import { useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { Button, Menu, Tag, Tooltip } from 'antd';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AppShell, LanguageSwitcher, ThemeToggle, UserMenu } from '@autional/ui';
import type { UserMenuItemSpec } from '@autional/ui';
import { API_NAMESPACE, DATA_MODE, PLATFORM_URL } from '@/lib/config';
import { useSession } from '@/hooks/use-session';
import { PortalMenu } from '@/components/portal-menu';
import { LoginPage } from './login/page';

export default function Layout() {
  const { ready, session, error, needsLogin, login, logout } = useSession();

  if (!ready) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-[var(--color-text-secondary)]">…</div>;
  }
  if (needsLogin) return <LoginPage error={error} onLogin={() => void login()} />;

  return <Shell session={session} onLogout={logout} />;
}

function Shell({ session, onLogout }: { session: ReturnType<typeof useSession>['session']; onLogout: () => Promise<void> }) {
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
  const userItems: UserMenuItemSpec[] = [
    { key: 'platform', type: 'custom', label: t('nav.platform'), href: PLATFORM_URL },
    { key: 'logout', type: 'logout', onClick: () => void onLogout() },
  ];

  return (
    <AppShell
      brand={<span className="truncate text-lg font-bold">{collapsed ? 'A' : t('app.brand')}</span>}
      sidebarCollapsed={collapsed}
      nav={
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
        </>
      }
      headerRight={
        <>
          <Tooltip title={t('header.namespaceHint')}>
            <Tag color="gold">{t('header.namespace', { ns: API_NAMESPACE })}</Tag>
          </Tooltip>
          <Tag color={DATA_MODE === 'api' ? 'blue' : 'default'}>
            {DATA_MODE === 'api' ? t('header.apiMode') : t('header.demoMode')}
          </Tag>
          {readOnly ? <Tag>{t('header.readOnly')}</Tag> : null}
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
