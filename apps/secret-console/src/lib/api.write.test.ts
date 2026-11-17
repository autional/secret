import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 写路径契约：创建 / 改元信息 / 轮换 / 吊销 / 删除 / 策略 + 连通性探测。
 *
 * 关键口径（本次修复）：
 *   1. `POST /update` 的 body **不带 metadata** —— 服务端 metadata 是**整块替换**，
 *      带 `{metadata:{change_reason}}` 会把该密钥其它 metadata 键清空（数据丢失）。
 *      变更原因只走 `X-Change-Reason`。
 *   2. `POST /secrets`（创建）可以带 metadata（首次写入，无覆盖风险）。
 *   3. 写操作必须带 `X-Change-Reason`（前端表单已强制必填）。
 *   4. `checkApi` 在租户为空时**不回落** `/all`（普通账号只会 403，误报不可达）。
 */

const SESSION_KEY = 'secret-center:auth:v2';
const PLATFORM_TENANT = '01KSQCBNVMS6SX64PJS937CE33';

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  };
}

/** 安装最小 window：OIDC 会话（可指定租户）、同源 origin、事件总线。 */
function installWindow(options: { tenantId?: string } = {}) {
  const { tenantId = 'ten-a' } = options;
  const session = {
    mode: 'oidc' as const,
    accessToken: 'jwt-write',
    expiresAt: 0,
    user: { sub: 'u1', name: '写路径', email: 'write@qa.local', tenantId, appId: '', roles: ['admin'] },
  };
  const local = memoryStorage({ [SESSION_KEY]: JSON.stringify(session) });
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const win = {
    localStorage: local,
    sessionStorage: memoryStorage(),
    location: { origin: 'https://secret.autional.com', hostname: 'secret.autional.com' },
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), handler]);
    },
    removeEventListener: (type: string, handler: (event: unknown) => void) => {
      listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== handler));
    },
    dispatchEvent: (event: { type: string }) => {
      for (const handler of listeners.get(event.type) ?? []) handler(event);
      return true;
    },
  };
  vi.stubGlobal('window', win);
  return { win, listeners };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type FetchCall = [string, { method?: string; headers?: Record<string, string>; body?: string }];

function firstCall(fetchMock: ReturnType<typeof vi.fn>): FetchCall {
  return fetchMock.mock.calls[0] as unknown as FetchCall;
}

describe('secret api · 写路径契约', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.stubEnv('VITE_DATA_MODE', 'api');
    vi.stubEnv('VITE_AUTH_MODE', 'oidc');
    vi.stubEnv('VITE_API_NAMESPACE', 'prod');
    installWindow();
  });

  it('updateSecretMeta：body 只含 description（**不含 metadata**）+ 原因头 + 作用域头', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: { key: 'db/pw', description: '新描述' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { updateSecretMeta } = await import('./api');

    const out = await updateSecretMeta(
      'db/pw',
      { description: '新描述', reason: '修正描述笔误' },
      { tenantId: 'ten-a', appId: 'secret-service' },
    );
    expect(out.description).toBe('新描述');

    const [url, init] = firstCall(fetchMock);
    expect(url).toBe('https://secret.autional.com/bff/secret/api/v1/admin/secrets/update?key=db%2Fpw');
    expect(init.method).toBe('POST');
    // P0 数据丢失修复：绝不能把 metadata 发进 update（服务端是整块替换）
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({ description: '新描述' });
    expect(body).not.toHaveProperty('metadata');
    expect(init.headers?.['X-Change-Reason']).toBe('修正描述笔误');
    expect(init.headers?.['X-Tenant-ID']).toBe('ten-a');
    expect(init.headers?.['X-App-ID']).toBe('secret-service');
    expect(init.headers?.['X-Namespace']).toBe('prod');
    expect(init.headers?.Authorization).toBe('Bearer jwt-write');
  });

  it('updateSecretMeta：未给原因时既不发 metadata 也不发 X-Change-Reason', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: { key: 'db/pw' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { updateSecretMeta } = await import('./api');

    await updateSecretMeta('db/pw', { description: '' });
    const [, init] = firstCall(fetchMock);
    expect(JSON.parse(String(init.body))).toEqual({ description: '' });
    expect(init.headers?.['X-Change-Reason']).toBeUndefined();
  });

  it('createSecret：POST /secrets，body 保留 metadata.change_reason（新建不动）+ 原因头', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: { key: 'db/pw', status: 'active' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { createSecret } = await import('./api');

    await createSecret(
      { key: 'db/pw', value: 's3cret', description: 'PG 口令', reason: '首次录入' },
      { tenantId: '_system', appId: 'identity-service' },
    );

    const [url, init] = firstCall(fetchMock);
    expect(url).toBe('https://secret.autional.com/bff/secret/api/v1/admin/secrets');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      key: 'db/pw',
      value: 's3cret',
      description: 'PG 口令',
      metadata: { change_reason: '首次录入' },
    });
    expect(init.headers?.['X-Change-Reason']).toBe('首次录入');
    expect(init.headers?.['X-Tenant-ID']).toBe('_system');
    expect(init.headers?.['X-App-ID']).toBe('identity-service');
    expect(init.headers?.['X-Namespace']).toBe('prod');
  });

  it('rotateSecret：POST /rotate?key=，body 只有新值 + 原因头', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: { key: 'db/pw', version: 4 } }));
    vi.stubGlobal('fetch', fetchMock);
    const { rotateSecret } = await import('./api');

    const out = await rotateSecret('db/pw', 'new-value', '例行轮换', { tenantId: 'ten-a' });
    expect(out.version).toBe(4);

    const [url, init] = firstCall(fetchMock);
    expect(url).toBe('https://secret.autional.com/bff/secret/api/v1/admin/secrets/rotate?key=db%2Fpw');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ value: 'new-value' });
    expect(init.headers?.['X-Change-Reason']).toBe('例行轮换');
    expect(init.headers?.['X-Tenant-ID']).toBe('ten-a');
  });

  it('revokeSecret：POST /revoke?key=，无 body + 原因头', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: null }));
    vi.stubGlobal('fetch', fetchMock);
    const { revokeSecret } = await import('./api');

    await revokeSecret('db/pw', '密钥疑似泄露', { tenantId: 'ten-a', appId: 'secret-service' });

    const [url, init] = firstCall(fetchMock);
    expect(url).toBe('https://secret.autional.com/bff/secret/api/v1/admin/secrets/revoke?key=db%2Fpw');
    expect(init.method).toBe('POST');
    expect(init.headers?.['X-Change-Reason']).toBe('密钥疑似泄露');
    expect(init.headers?.['X-App-ID']).toBe('secret-service');
  });

  it('deleteSecret：DELETE /item/key/<逐段编码> + 原因头', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: null }));
    vi.stubGlobal('fetch', fetchMock);
    const { deleteSecret } = await import('./api');

    await deleteSecret('db/app key', '废弃配置清理', { tenantId: '_system' });

    const [url, init] = firstCall(fetchMock);
    // 逐段编码但要保留 `/` 分层（不能被编码成 %2F）
    expect(url).toBe('https://secret.autional.com/bff/secret/api/v1/admin/secrets/item/key/db/app%20key');
    expect(init.method).toBe('DELETE');
    expect(init.headers?.['X-Change-Reason']).toBe('废弃配置清理');
    expect(init.headers?.['X-Tenant-ID']).toBe('_system');
  });

  it('upsertSecretPolicy：PUT /policy，body + 原因头（策略写必须有原因）', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: { tenant_id: 'ten-a', auto_rotate_days: 30 } }));
    vi.stubGlobal('fetch', fetchMock);
    const { upsertSecretPolicy } = await import('./api');

    const out = await upsertSecretPolicy(
      { auto_rotate_days: 30, notification_days_before: 7, max_versions: 5 },
      '收紧轮换策略',
      { tenantId: 'ten-a' },
    );
    expect(out.auto_rotate_days).toBe(30);

    const [url, init] = firstCall(fetchMock);
    expect(url).toBe('https://secret.autional.com/bff/secret/api/v1/admin/secrets/policy');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ auto_rotate_days: 30, notification_days_before: 7, max_versions: 5 });
    expect(init.headers?.['X-Change-Reason']).toBe('收紧轮换策略');
    expect(init.headers?.['X-Tenant-ID']).toBe('ten-a');
  });

  describe('checkApi 连通性探测', () => {
    it('租户为空：返回「未选择租户」且**不发请求**（不回落 /all）', async () => {
      installWindow({ tenantId: '' });
      const fetchMock = vi.fn(async () => jsonResponse({ code: 0, items: [], total: 0 }));
      vi.stubGlobal('fetch', fetchMock);
      const { checkApi } = await import('./api');

      const health = await checkApi();
      expect(health.ok).toBe(false);
      expect(health.skipped).toBe(true);
      expect(health.message).toMatch(/未选择租户/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('平台租户：走 /all 平台端点并回 total', async () => {
      installWindow({ tenantId: PLATFORM_TENANT });
      const fetchMock = vi.fn(async () => jsonResponse({ code: 0, items: [], total: 12 }));
      vi.stubGlobal('fetch', fetchMock);
      const { checkApi } = await import('./api');

      const health = await checkApi();
      expect(health.ok).toBe(true);
      expect(health.message).toContain('全平台共 12 条');
      const [url] = firstCall(fetchMock);
      expect(url).toContain('/admin/secrets/all?page=1&page_size=1');
    });

    it('普通租户：走本租户列表端点并带 X-Tenant-ID', async () => {
      installWindow({ tenantId: 'ten-a' });
      const fetchMock = vi.fn(async () => jsonResponse({ code: 0, items: [], total: 3 }));
      vi.stubGlobal('fetch', fetchMock);
      const { checkApi } = await import('./api');

      const health = await checkApi();
      expect(health.ok).toBe(true);
      expect(health.message).toContain('本租户共 3 条');
      const [url, init] = firstCall(fetchMock);
      expect(url).toContain('/admin/secrets?page=1&page_size=1');
      expect(url).not.toContain('/all');
      expect(init.headers?.['X-Tenant-ID']).toBe('ten-a');
    });
  });
});
