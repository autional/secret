import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 读路径契约：列表 / 详情 / 版本 / 密钥环 / 策略 + 400·401·403·503 分流。
 *
 * 口径来源（service-secret 管理面，2026-11 实测）：
 *   - `GET  /admin/secrets`            → `{code, message, items, total, pagination}`
 *   - `GET  /admin/secrets/detail?key=`→ `{data: SecretDetailResponse}`（含 versions，不含 value）
 *   - `GET  /admin/secrets/versions?key=` → `{data: SecretVersionResponse[]}`
 *   - `GET  /admin/secrets/encryption-keys` → `{data: {keys: [{key_id, algorithm, status}]}}`（无顶层 current）
 *   - `GET  /admin/secrets/policy`     → `{data: SecretPolicy}`
 *   - `GET  /admin/secrets/all` / `/all/scopes` 仅平台租户可用（否则 403 / 40000503）
 *   - `X-Namespace` 不属于实例 `SECRET_NAMESPACES` → 400（fail-closed）
 *   - 作用域内查不到 → 401 + 业务码 30000001（**不是**会话失效）
 */

const SESSION_KEY = 'secret-center:auth:v2';

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  };
}

/** 安装最小 window：OIDC 会话（带 token）、同源 origin、事件总线。 */
function installWindow(options: { withSession?: boolean } = {}) {
  const { withSession = true } = options;
  const session = {
    mode: 'oidc' as const,
    accessToken: 'jwt-read-mvp',
    expiresAt: 0,
    user: { sub: 'u1', name: '读路径', email: 'read@qa.local', tenantId: 'ten-a', appId: '', roles: ['admin'] },
  };
  const local = memoryStorage(withSession ? { [SESSION_KEY]: JSON.stringify(session) } : {});
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
  return { win, listeners, local };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function problem(status: number, code: number | string, detail: string) {
  return jsonResponse({ type: `https://docs.autional.cn/errors/${code}`, title: detail, status, detail, code }, status);
}

type FetchCall = [string, { method?: string; headers?: Record<string, string>; body?: string }];

function firstCall(fetchMock: ReturnType<typeof vi.fn>): FetchCall {
  return fetchMock.mock.calls[0] as unknown as FetchCall;
}

describe('secret api · 读路径契约', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.stubEnv('VITE_DATA_MODE', 'api');
    vi.stubEnv('VITE_AUTH_MODE', 'oidc');
    vi.stubEnv('VITE_API_NAMESPACE', 'prod');
    installWindow();
  });

  it('listSecrets：GET 列表端点 + Authorization / X-Tenant-ID / X-Namespace，解析 items 与 total', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        code: 0,
        message: 'success',
        items: [{ key: 'jwt_secret', status: 'active', version: 3, tenant_id: 'ten-a' }],
        total: 1,
        pagination: { total: 1, page: 1, page_size: 20 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { listSecrets } = await import('./api');

    const out = await listSecrets({ prefix: 'jwt', status: 'active', page: 1, page_size: 20 });
    expect(out.total).toBe(1);
    expect(out.items[0].key).toBe('jwt_secret');
    expect(out.items[0]).not.toHaveProperty('value');

    const [url, init] = firstCall(fetchMock);
    expect(url).toBe('https://secret.autional.com/bff/secret/api/v1/admin/secrets?prefix=jwt&status=active&page=1&page_size=20');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.headers?.Authorization).toBe('Bearer jwt-read-mvp');
    expect(init.headers?.['X-Tenant-ID']).toBe('ten-a');
    expect(init.headers?.['X-Namespace']).toBe('prod');
    // 未选应用作用域时不伪造 X-App-ID（服务端按存在与否过滤）
    expect(init.headers?.['X-App-ID']).toBeUndefined();
  });

  it('listSecrets：传 app 作用域时补 X-App-ID', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ code: 0, items: [], total: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    const { listSecrets } = await import('./api');

    await listSecrets({ page: 1, page_size: 10 }, { tenantId: 'ten-a', appId: 'secret-service' });
    const [, init] = firstCall(fetchMock);
    expect(init.headers?.['X-Tenant-ID']).toBe('ten-a');
    expect(init.headers?.['X-App-ID']).toBe('secret-service');
  });

  it('listAllSecrets：平台盘点走 /all + tenant_id/app_id 过滤（不依赖 X-Tenant-ID）', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ code: 0, items: [], total: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    const { listAllSecrets } = await import('./api');

    await listAllSecrets({ tenant_id: '_system', app_id: 'secret-service', page: 1, page_size: 20 });
    const [url] = firstCall(fetchMock);
    expect(url).toBe(
      'https://secret.autional.com/bff/secret/api/v1/admin/secrets/all?tenant_id=_system&app_id=secret-service&page=1&page_size=20',
    );
  });

  it('getSecretDetail：GET /detail?key=，返回元数据 + versions，且不含 value', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        code: 0,
        data: {
          key: 'jwt_secret',
          tenant_id: 'ten-a',
          status: 'active',
          version: 2,
          versions: [{ version: 2, created_by: 'admin', created_at: '2026-11-01T00:00:00Z' }],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { getSecretDetail } = await import('./api');

    const detail = await getSecretDetail('jwt_secret', { tenantId: 'ten-a', appId: 'secret-service' });
    expect(detail.key).toBe('jwt_secret');
    expect(detail.versions?.[0].version).toBe(2);
    expect(detail).not.toHaveProperty('value');

    const [url, init] = firstCall(fetchMock);
    expect(url).toBe(
      'https://secret.autional.com/bff/secret/api/v1/admin/secrets/detail?key=jwt_secret',
    );
    expect(init.headers?.['X-App-ID']).toBe('secret-service');
  });

  it('getEncryptionKeys：current 按 status=current 选，不取数组首项', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        code: 0,
        data: {
          keys: [
            { key_id: 'k-old', algorithm: 'AES-256-GCM', status: 'fallback', secrets_count: 0 },
            { key_id: 'k-new', algorithm: 'AES-256-GCM', status: 'current', secrets_count: 12 },
          ],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { getEncryptionKeys } = await import('./api');

    const ring = await getEncryptionKeys();
    expect(ring.current).toBe('k-new');
    expect(ring.available).toEqual(['k-old', 'k-new']);
    expect(firstCall(fetchMock)[0]).toBe(
      'https://secret.autional.com/bff/secret/api/v1/admin/secrets/encryption-keys',
    );
  });

  it('getSecretPolicy：GET /policy 读取租户策略', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ code: 0, data: { tenant_id: 'ten-a', auto_rotate_days: 90, max_versions: 100 } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { getSecretPolicy } = await import('./api');

    const policy = await getSecretPolicy({ tenantId: 'ten-a' });
    expect(policy.auto_rotate_days).toBe(90);
    expect(firstCall(fetchMock)[0]).toBe('https://secret.autional.com/bff/secret/api/v1/admin/secrets/policy');
  });

  it('listAppScopes / listAllScopes：解析 data 数组', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: [{ app_id: 'secret-service', secret_count: 3 }] }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: [{ tenant_id: '_system', app_id: 'secret-service', secret_count: 3 }] }));
    vi.stubGlobal('fetch', fetchMock);
    const { listAppScopes, listAllScopes } = await import('./api');

    expect(await listAppScopes()).toEqual([{ app_id: 'secret-service', secret_count: 3 }]);
    expect((await listAllScopes())[0].tenant_id).toBe('_system');
  });

  describe('错误状态分流', () => {
    it('400（X-Namespace 不被实例接受）→ ApiError 400 且文案点明命名空间', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          problem(400, 10000001, 'namespace dev is not served by this instance (fail-closed, no fallback)'),
        ),
      );
      const { listSecrets, ApiError } = await import('./api');

      await expect(listSecrets()).rejects.toBeInstanceOf(ApiError);
      await expect(listSecrets()).rejects.toMatchObject({ status: 400, code: '10000001' });
    });

    it('400 无 detail 时给出命名空间排查提示', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 400 })));
      const { listSecrets } = await import('./api');

      await expect(listSecrets()).rejects.toThrow(/X-Namespace/);
    });

    it('401 + 30000001（作用域内查不到）不触发登出，只把错误交给调用方', async () => {
      const { listeners } = installWindow();
      vi.stubGlobal('fetch', vi.fn(async () => problem(401, 30000001, 'secret not found in scope')));
      const { getSecretDetail, UNAUTHORIZED_EVENT } = await import('./api');

      await expect(getSecretDetail('missing')).rejects.toMatchObject({ status: 401, code: '30000001' });
      expect(listeners.get(UNAUTHORIZED_EVENT) ?? []).toHaveLength(0);
      expect(window.localStorage.getItem(SESSION_KEY)).toBeTruthy();
    });

    it('401（会话失效且无法续期）→ 派发 unauthorized 事件', async () => {
      const { listeners } = installWindow();
      const dispatched: string[] = [];
      window.addEventListener('secret-center:unauthorized', () => void dispatched.push('unauthorized'));
      vi.stubGlobal('fetch', vi.fn(async () => problem(401, 10000002, 'invalid token')));
      const { listSecrets } = await import('./api');

      await expect(listSecrets()).rejects.toMatchObject({ status: 401 });
      expect(listeners.get('secret-center:unauthorized')).toHaveLength(1);
      expect(dispatched).toEqual(['unauthorized']);
    });

    it('403（缺 secret:admin / 非平台租户）→ ApiError 403 带业务码', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => problem(403, 40000503, 'platform tenant required')));
      const { listAllSecrets } = await import('./api');

      await expect(listAllSecrets()).rejects.toMatchObject({ status: 403, code: '40000503' });
    });

    it('503（服务暂不可用）→ ApiError 503 且文案可读', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
      const { listSecrets } = await import('./api');

      await expect(listSecrets()).rejects.toMatchObject({ status: 503 });
      await expect(listSecrets()).rejects.toThrow(/503/);
    });

    it('网络不可达 → ApiError status=0（UI 走「无法连接」分支）', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
      const { listSecrets } = await import('./api');

      await expect(listSecrets()).rejects.toMatchObject({ status: 0 });
    });
  });
});
