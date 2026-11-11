import { Alert, Button } from 'antd';
import { useTranslation } from 'react-i18next';
import { AUTH_MODE, OIDC } from '@/lib/config';

/** 登录页：mock 模式给「演示账号」，oidc 模式走授权码 + PKCE（由 lib/auth 发起）。 */
export function LoginPage({ error, onLogin }: { error: string; onLogin: () => void }) {
  const { t } = useTranslation();
  // 按钮文案要跟着**实际动作**走：AUTH_MODE（怎么登录），不是 DATA_MODE（数据从哪来）。
  // 之前按 DATA_MODE 判：VITE_DATA_MODE=mock + VITE_AUTH_MODE=oidc 时按钮写「演示账号」，
  // 点下去却跳真 OIDC 授权页 —— 文案与行为不符。
  const mock = AUTH_MODE === 'mock';

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg-muted)] p-6">
      <div className="w-full max-w-md rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-8 shadow-card">
        <div className="mb-6 flex items-center gap-2 text-lg font-bold text-[var(--color-text-primary)]">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--color-primary-700)] text-sm font-extrabold text-white">
            A
          </span>
          {t('app.brand')}
        </div>
        <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">{t('login.title')}</h1>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">{t('login.description')}</p>
        {error ? <Alert className="my-4" type="error" showIcon title={error} /> : null}
        <Button className="mt-6" type="primary" onClick={onLogin}>
          {mock ? t('login.mockAction') : t('login.oidcAction')}
        </Button>
        <div className="mt-4 text-xs text-[var(--color-text-muted)]">
          {mock ? t('login.mockHint') : t('login.oidcHint', { url: OIDC.authorizeUrl })}
        </div>
      </div>
    </div>
  );
}
