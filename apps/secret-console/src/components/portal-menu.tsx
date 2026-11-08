import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PortalSwitcher } from '@autional/ui';
import type { PortalLink } from '@autional/ui';
import type { Session } from '@/lib/auth';
import {
  CURRENT_PORTAL_CODE,
  PLATFORM_TENANT_ID,
  buildPortalUrl,
  fallbackPlatformUrl,
  fetchPortals,
  filterPortals,
  rootDomainOf,
} from '@/lib/portal';
import type { PortalApplication } from '@/lib/portal';

/** 控制台切换器只列同类控制台（与 admin/platform/security/user 一致）。 */
const CONSOLE_PORTALS = new Set(['config', 'secret', 'admin', 'security', 'user', 'platform']);

/**
 * 顶栏门户切换：目录来自平台 `tenant_applications`（不维护本地域名表）。
 *
 * 降级是正常路径（平台租户 403 / 未登录 401 / 超时）：
 * 只保留一条「平台控制台」，不弹错、不阻塞主内容。
 */
export function PortalMenu({ session }: { session: Session | null }) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ loading: boolean; degraded: boolean; portals: PortalApplication[] }>({
    loading: true,
    degraded: false,
    portals: [],
  });

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    const token = session?.accessToken ?? '';
    if (!token) {
      setState({ loading: false, degraded: true, portals: [] });
      return () => controller.abort();
    }
    setState({ loading: true, degraded: false, portals: [] });
    void (async () => {
      try {
        const sessionTenant = session?.user.tenantId || PLATFORM_TENANT_ID;
        // 目录是「平台门户注册表」：先按平台租户取全量，失败再用会话租户兜底。
        // 之前只查会话租户，导致非平台上下文里可选门户明显偏少。
        const candidates = [...new Set([PLATFORM_TENANT_ID, sessionTenant])];
        let rows: PortalApplication[] = [];
        let lastError: unknown = null;
        for (const tenantId of candidates) {
          try {
            rows = await fetchPortals({ tenantId, accessToken: token, signal: controller.signal });
            lastError = null;
            break;
          } catch (err) {
            lastError = err;
          }
        }
        if (lastError) throw lastError;
        if (!alive) return;
        // 可见性仍按「会话租户 + 角色」判定：platform 只对平台成员显示
        const visible = filterPortals(rows, {
          tenantId: sessionTenant,
          roles: session?.user.roles,
        })
          .filter((item) => CONSOLE_PORTALS.has(item.code))
          .slice()
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        const hasOther = visible.some((item) => item.code !== CURRENT_PORTAL_CODE);
        setState({ loading: false, degraded: !hasOther, portals: visible });
      } catch {
        if (alive) setState({ loading: false, degraded: true, portals: [] });
      }
    })();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [session]);

  const links = useMemo<PortalLink[]>(() => {
    const hostname = typeof window === 'undefined' ? '' : window.location.hostname;
    const protocol = typeof window === 'undefined' ? '' : window.location.protocol;
    const root = rootDomainOf(hostname);

    if (state.degraded) {
      return [{ code: 'platform', name: t('portal.platformFallback'), url: fallbackPlatformUrl(hostname) }];
    }
    return state.portals
      .map((portal) => ({
        code: portal.code,
        name: portal.name || portal.code,
        description: portal.description,
        url: buildPortalUrl(portal, root, protocol),
      }))
      .filter((portal) => portal.url !== '');
  }, [state.degraded, state.portals, t]);

  return (
    <PortalSwitcher
      portals={links}
      currentPortal={CURRENT_PORTAL_CODE}
      loading={state.loading}
      // 降级时只有一条「平台控制台」：必须显示，否则用户失去唯一出口
      hideWhenSingle={!state.degraded}
      labels={{ switchPortal: t('portal.switch') }}
    />
  );
}
