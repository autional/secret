import { useEffect, useRef } from 'react';
import type { Session } from '@/lib/auth';

/**
 * 心跳端点：走管理面前缀（网关已对该前缀做 admin 平面 + 角色粗筛）；
 * sid 取自 token，服务端只允许续「自己的」会话。
 */
const ACTIVITY_URL = '/bff/session/api/v1/admin/sessions/me/activity';
/** 心跳周期：idle 30 分钟的 1/6（业界常用 5 分钟）。 */
const PING_INTERVAL = 5 * 60_000;
/** 检查节拍：每秒级太重，1 分钟一次足够（真正的间隔由 PING_INTERVAL 控制）。 */
const TICK_INTERVAL = 60_000;
/** 交互新鲜度：超过这个时间没交互，就不发心跳（人不在，让会话自然闲置过期）。 */
const INTERACTION_FRESH = 5 * 60_000;

function sidFromToken(token: string): string {
  try {
    const part = token.split('.')[1] ?? '';
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4)));
    const custom = claims?.custom ?? {};
    return String(custom.sid || custom.session_id || claims.session_id || '');
  } catch {
    return '';
  }
}

/**
 * 会话活动心跳（NIST「activity resets inactivity」口径）。
 *
 * - 只在「页面可见 + 最近 5 分钟有真实交互」时上报；页面开着但人不在 → 不发，交给服务端闲置过期。
 * - 只刷新闲置窗口，绝对上限（12h）由服务端固定，心跳无法突破。
 * - 失败静默：端点未上线/网关未放行时不影响业务请求。
 */
export function useSessionActivity(session: Session | null, enabled = true): void {
  const lastInteraction = useRef(Date.now());
  const lastPing = useRef(0);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // 依赖只放「有没有会话」：token 每 3 分钟刷新一次，若把它放进依赖，
  // setInterval 会被反复重建，5 分钟的间隔永远到不了（心跳一次都不发）。
  const hasSession = Boolean(session);
  useEffect(() => {
    if (!enabled || !hasSession) return;

    const markInteraction = () => {
      lastInteraction.current = Date.now();
    };
    const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchstart', 'wheel'];
    events.forEach((name) => window.addEventListener(name, markInteraction, { passive: true }));

    const ping = () => {
      const current = sessionRef.current;
      if (!current?.accessToken) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastInteraction.current > INTERACTION_FRESH) return;
      if (now - lastPing.current < PING_INTERVAL) return;
      const sid = sidFromToken(current.accessToken);
      if (!sid) return;

      lastPing.current = now;
      const headers: Record<string, string> = {
        Accept: 'application/json',
        Authorization: `Bearer ${current.accessToken}`,
      };
      if (current.user?.tenantId) headers['X-Tenant-ID'] = current.user.tenantId;
      if (current.user?.appId) headers['X-App-ID'] = current.user.appId;
      void fetch(ACTIVITY_URL, { method: 'POST', headers, credentials: 'omit' }).catch(() => undefined);
    };

    const timer = window.setInterval(ping, TICK_INTERVAL);
    const onVisible = () => {
      if (document.visibilityState === 'visible') ping();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      events.forEach((name) => window.removeEventListener(name, markInteraction));
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, hasSession]);
}
