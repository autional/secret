import { beforeEach, describe, expect, it, vi } from 'vitest';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  };
}

const SESSION_KEY = 'secret-center:auth:v2';

function installWindow() {
  const local = memoryStorage();
  const session = memoryStorage();
  local.setItem(
    SESSION_KEY,
    JSON.stringify({
      mode: 'oidc',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3_600_000,
      user: { sub: 'u1', name: 'QA', email: 'qa@example.com', tenantId: 't1', appId: '', roles: ['super_admin'] },
    }),
  );
  const win = {
    localStorage: local,
    sessionStorage: session,
    location: { origin: 'https://secret.autional.cn' },
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
  vi.stubGlobal('window', win);
  return { local, session, win };
}

describe('auth signOut', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.stubEnv('VITE_AUTH_MODE', 'oidc');
    vi.stubEnv('VITE_OIDC_CLIENT_ID', 'test-client');
  });

  it('吊销 refresh + access 两个 token，并清本地会话', async () => {
    const { local } = installWindow();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const { signOut } = await import('./auth');
    await signOut();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.every((url) => url.endsWith('/revoke'))).toBe(true);
    const bodies = fetchMock.mock.calls.map((call) => String((call[1] as RequestInit | undefined)?.body ?? ''));
    expect(bodies.some((body) => body.includes('token=refresh-token') && body.includes('token_type_hint=refresh_token'))).toBe(true);
    expect(bodies.some((body) => body.includes('token=access-token') && body.includes('token_type_hint=access_token'))).toBe(true);
    expect(local.getItem(SESSION_KEY)).toBeNull();
  });

  it('revoke 网络失败不阻塞本地退出', async () => {
    const { local } = installWindow();
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('network down'))));

    const { signOut } = await import('./auth');
    await expect(signOut()).resolves.toBeUndefined();
    expect(local.getItem(SESSION_KEY)).toBeNull();
  });

  it('mock 模式不发 revoke 请求', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'mock');
    const { local } = installWindow();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { signOut } = await import('./auth');
    await signOut();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(local.getItem(SESSION_KEY)).toBeNull();
  });
});
