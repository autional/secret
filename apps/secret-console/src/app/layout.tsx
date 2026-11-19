import { useMemo, useState } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { Button, Menu, Spin, Tag, Tooltip } from 'antd';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AppShell, LanguageSwitcher, ThemeToggle, UserMenu } from '@autional/ui';
import type { UserMenuItemSpec } from '@autional/ui';
import { API_NAMESPACE, DATA_MODE, PLATFORM_TENANT_ID } from '@/lib/config';
import { markAutoLoginAttemptedInThisDocument } from '@/lib/auto-login';
import { useSession } from '@/hooks/use-session';
import { useAutoLogin } from '@/hooks/use-auto-login';
import { useSessionActivity } from '@/hooks/use-session-activity';
import { PortalMenu } from '@/components/portal-menu';
import { LoginPage } from './login/page';

export default function Layout() {
  const { ready, session, error, needsLogin, login, logout } = useSession();

  if (!ready) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-[var(--color-text-secondary)]">…</div>;
  }
  // 兜底：任何模式下停在 /oauth/callback（例如 mock 模式手动访问）都回首页
  if (typeof window !== 'undefined' && window.location.pathname.replace(/\/+$/, '') === '/oauth/callback') {
    return <Navigate to="/" replace />;
  }
  if (needsLogin) return <LoginGate ready={ready} needsLogin={needsLogin} error={error} onLogin={() => void login()} />;

  return <Shell session={session} onLogout={logout} />;
}

/**
 * 登录闸门：**先自动跳一次**（首次确认无会话时免点击），失败/被循环保护抑制时
 * 回落原来的登录页（保留手动按钮）。
 *
 * 自动跳的判定与限流在 `lib/auto-login` 的纯函数里（含单测），这里只负责渲染：
 * 正在跳转时显示「正在跳转…」，避免按钮闪一下又消失。
 */
function LoginGate({
  ready,
  needsLogin,
  error,
  onLogin,
}: {
  ready: boolean;
  needsLogin: boolean;
  error: string;
  onLogin: () => void;
}) {
  const { t } = useTranslation();
  const autoLoginPending = useAutoLogin({ ready, needsLogin, error, onLogin });

  if (autoLoginPending) {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center gap-3 bg-[var(--color-bg-muted)] text-sm text-[var(--color-text-secondary)]"
        role="status"
        aria-live="polite"
      >
        <Spin />
        <span>{t('login.autoRedirecting')}</span>
      </div>
    );
  }
  // 手动点击也打「已发起跳转」标记：否则 error 被清空后判定会重新变「该跳」，双开授权请求。
  const handleManualLogin = () => {
    markAutoLoginAttemptedInThisDocument();
    onLogin();
  };
  return <LoginPage error={error} onLogin={handleManualLogin} />;
}

function Shell({ session, onLogout }: {
  session: ReturnType<typeof useSession>['session']; onLogout: () => Promise<void> }) {
  useSessionActivity(session);
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const navItems = useMemo(
    () => [
      { key: '/', label: t('nav.overview') },
      { key: '/secrets', label: t('nav.secrets') },
      { key: '/audit', label: t('nav.audit') },
    ],
    [t],
  );

  // 只读角色：security_admin 且不是 super_admin / admin
  const readOnly = useMemo(() => {
    const roles = session?.user.roles ?? [];
    if (roles.length === 0) return false;
    return roles.includes('security_admin') && !roles.includes('super_admin') && !roles.includes('admin');
  }, [session]);

  const selected = '/' + (location.pathname.split('/')[1] ?? '');

  const crumbs = useMemo(() => {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return [];
    if (parts[0] === 'secrets') return [{ label: t('nav.secrets'), to: '/secrets' }];
    if (parts[0] === 'audit') return [{ label: t('nav.audit'), to: '/audit' }];
    return [];
  }, [location.pathname, t]);
  // 跨站入口交给顶栏的门户切换（PortalSwitcher），UserMenu 只保留退出登录，避免同一跳转出现两次
  const userItems: UserMenuItemSpec[] = [{ key: 'logout', type: 'logout', onClick: () => void onLogout() }];

  return (
    <AppShell
      brand={
        <span className="flex min-w-0 items-center gap-2">
          <img src="/favicon.svg" alt="" className="h-6 w-6 shrink-0 rounded" />
          {collapsed ? null : <span className="truncate text-lg font-bold">{t('app.brand')}</span>}
        </span>
      }
      sidebarCollapsed={collapsed}
      nav={
        <>
          <Menu
            mode="inline"
            selectedKeys={[selected === '/' ? '/' : selected]}
            items={navItems}
            className="border-r-0"
            onClick={({ key }) => {
              navigate(key);
              setMobileOpen(false);
            }}
          />
          {collapsed || !session ? null : (
            <div className="mt-auto border-t border-[var(--color-border-subtle)] px-4 py-3 text-xs text-[var(--color-text-secondary)]">
              <div className="mb-1 truncate font-semibold text-[var(--color-text-primary)]">{session.user.name}</div>
              <div className="truncate py-0.5">
                {t('sidebar.tenant')}：
                {session.user.tenantId === PLATFORM_TENANT_ID
                  ? t('sidebar.platformTenant')
                  : session.user.tenantId
                    ? `…${session.user.tenantId.slice(-8)}`
                    : '—'}
              </div>
              <div className="truncate py-0.5">{t('sidebar.roles')}：{session.user.roles.join(' / ') || '—'}</div>
              <div className="truncate py-0.5">{t('sidebar.namespace')}：{API_NAMESPACE}</div>
            </div>
          )}
        </>
      }
      headerLeft={
        <>
          <Button
            type="text"
            className="lg:hidden"
            icon={<PanelLeftOpen size="1em" />}
            onClick={() => setMobileOpen(true)}
            aria-label={t('nav.openMenu')}
          />
          <Button
            type="text"
            className="hidden lg:inline-flex"
            icon={collapsed ? <PanelLeftOpen size="1em" /> : <PanelLeftClose size="1em" />}
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? t('header.expand') : t('header.collapse')}
            aria-expanded={!collapsed}
          />
          <Breadcrumb crumbs={crumbs} />
        </>
      }
      headerRight={
        <>
          {/* 顶栏条目在窄屏必须收敛：headerRight 是 shrink-0，全量保留会把顶栏撑出视口，
              导致整页横向滚动、右侧头像被裁切（390px 实测）。 */}
          <Tooltip title={t('header.namespaceHint')}>
            <Tag color="gold" className="hidden md:inline-flex">
              {t('header.namespace', { namespace: API_NAMESPACE })}
            </Tag>
          </Tooltip>
          <Tag color={DATA_MODE === 'api' ? 'blue' : 'default'} className="hidden sm:inline-flex">
            {DATA_MODE === 'api' ? t('header.apiMode') : t('header.demoMode')}
          </Tag>
          {readOnly ? <Tag className="hidden lg:inline-flex">{t('header.readOnly')}</Tag> : null}
          <PortalMenu session={session} />
          <LanguageSwitcher />
          <ThemeToggle />
          <UserMenu
            user={session ? { displayName: session.user.name, email: session.user.email, username: session.user.email } : null}
            items={userItems}
          />
        </>
      }
      mobileOpen={mobileOpen}
      onMobileClose={() => setMobileOpen(false)}
      closeLabel={t('nav.closeMenu')}
    >
      <Outlet />
    </AppShell>
  );
}


function Breadcrumb({ crumbs }: { crumbs: Array<{ label: string; to: string }> }) {
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1 text-sm text-[var(--color-text-secondary)] md:flex">
      {crumbs.map((crumb, index) => (
        <span key={`${crumb.to}-${index}`} className="flex min-w-0 items-center gap-1">
          {index > 0 ? <span className="text-[var(--color-text-muted)]">/</span> : null}
          {index === crumbs.length - 1 ? (
            <span className="truncate text-[var(--color-text-primary)]">{crumb.label}</span>
          ) : (
            <Link to={crumb.to} className="truncate hover:text-[var(--color-text-primary)]">
              {crumb.label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
