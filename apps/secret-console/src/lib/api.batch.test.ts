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

function installWindow() {
  const local = memoryStorage();
  const session = memoryStorage();
  const win = {
    localStorage: local,
    sessionStorage: session,
    location: { origin: 'https://secret.autional.cn' },
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
  vi.stubGlobal('window', win);
  return win;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('secret api · 批量/明文请求契约', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.stubEnv('VITE_AUTH_MODE', 'mock');
    vi.stubEnv('VITE_DATA_MODE', 'api');
    vi.stubEnv('VITE_API_NAMESPACE', 'prod');
    installWindow();
  });

  it('batchRevoke 发送 keys + 原因 + 行作用域', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: { succeeded: ['a'], errors: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const { batchRevokeSecrets } = await import('./api');

    const res = await batchRevokeSecrets(['a', 'b'], '批量吊销测试', { tenantId: '_system', appId: 'qa-app' });
    expect(res.succeeded).toEqual(['a']);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://secret.autional.cn/bff/secret/api/v1/admin/secrets/batch-revoke');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ keys: ['a', 'b'] });
    const headers = init?.headers as Record<string, string>;
    expect(headers['X-Change-Reason']).toBe('批量吊销测试');
    expect(headers['X-Tenant-ID']).toBe('_system');
    expect(headers['X-App-ID']).toBe('qa-app');
    expect(headers['X-Namespace']).toBe('prod');
  });

  it('batchDelete 发送 keys + 原因 + 行作用域', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: { succeeded: ['a', 'b'], errors: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const { batchDeleteSecrets } = await import('./api');

    await batchDeleteSecrets(['a', 'b'], '批量删除测试', { tenantId: '_system', appId: 'qa-app' });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({ keys: ['a', 'b'] });
    expect((init?.headers as Record<string, string>)['X-Change-Reason']).toBe('批量删除测试');
  });

  it('reveal 发送 version body + 原因头', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: { key: 'k', value: 'v', version: 2, status: 'active' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { revealSecretVersion } = await import('./api');

    const out = await revealSecretVersion('k', 2, '排障核对', { tenantId: '_system' });
    expect(out.value).toBe('v');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/admin/secrets/versions/value?key=k');
    expect(JSON.parse(String(init?.body))).toEqual({ version: 2 });
    expect((init?.headers as Record<string, string>)['X-Change-Reason']).toBe('排障核对');
  });
});
