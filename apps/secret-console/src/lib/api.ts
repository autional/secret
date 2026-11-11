/**
 * 密钥中心管理面 API 客户端。
 *
 * 三组端点（同源 `/bff`，由 `vercel.ts` rewrites 代理到 api 网关，无 CORS）：
 *   - 密钥：`/bff/secret/api/v1/admin/secrets`
 *   - 审计：`/bff/audit/api/v1/admin/audit`
 *   - 门户目录：`/bff/tenant/api/v1/admin`（见 lib/portal.ts）
 *
 * 鉴权：`Authorization: Bearer <JWT>` + `X-Tenant-ID` + `X-App-ID` + `X-Namespace`。
 * 作用域（tenant / app）来自 lib/scope.ts（用户可切换），不是写死的常量。
 *
 * 安全口径：列表/详情只返回元数据与版本号；明文读取走 `POST /versions/value`，
 * 必须携带 `X-Change-Reason`（服务端写审计 `version_read`），前端只展示 30 秒。
 */
import { createFetchClient, FetchApiError } from '@autional/shared/fetch';
import { currentSession, refreshSession } from './auth';
import { API_BASE, API_NAMESPACE, AUDIT_BASE, AUTH_MODE, IDENTITY_BASE, PLATFORM_TENANT_ID, TENANT_BASE } from './config';
import { resolveScope } from './scope';

/** 管理面错误（统一携带 HTTP 状态与业务错误码，便于 UI 分流 401/403/503/400）。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;

  constructor(status: number, message: string, code = '', detail = '') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** 401 事件：由 App 监听后切到「需要登录」状态。 */
export const UNAUTHORIZED_EVENT = 'secret-center:unauthorized';

type ProblemBody = { title?: string; detail?: string; code?: string; status?: number; message?: string } | null;

export type QueryValue = string | number | boolean | null | undefined;
export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** 单次请求的数据作用域覆盖（平台盘点视图按行/按筛选传）。 */
export type ScopeOverride = { tenantId: string; appId?: string };

export type RequestOptions = {
  method?: Method;
  /** 覆盖默认作用域（X-Tenant-ID / X-App-ID）；缺省取 lib/scope 的当前值。 */
  scope?: ScopeOverride;
  query?: Record<string, QueryValue>;
  /** JSON 请求体（POST/PUT 用） */
  body?: unknown;
  /** 变更原因：当前服务端未落库（波 2 接入审计），先透传头便于网关/审计侧采集。 */
  changeReason?: string;
  /** 内部用：401 后已重试过一次 */
  retried?: boolean;
  timeoutMs?: number;
};

function scopeHeaders(override?: ScopeOverride): Record<string, string> {
  const session = currentSession();
  const scope = override ?? resolveScope();
  const headers: Record<string, string> = {};
  if (session?.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;
  // 后端要求 X-Tenant-ID 必填；作用域由 UI 选择，空值交给后端判 401/400（不伪造）。
  if (scope.tenantId) headers['X-Tenant-ID'] = scope.tenantId;
  if (scope.appId) headers['X-App-ID'] = scope.appId;
  // service-secret 的 NamespaceMiddleware 必填（fail-closed 400）。
  headers['X-Namespace'] = API_NAMESPACE;
  return headers;
}

function problemMessage(status: number, problem: ProblemBody): string {
  const detail = problem?.detail || problem?.message || problem?.title;
  if (detail) return `${detail}（HTTP ${status}${problem?.code ? ` · ${problem.code}` : ''}）`;
  if (status === 400) return '请求参数不合法（HTTP 400）：常见原因是 X-Namespace 不属于实例 SECRET_NAMESPACES';
  if (status === 401) return '未登录或登录已过期（HTTP 401）';
  if (status === 403) return '无权限：密钥管理面需要 secret:admin（HTTP 403）';
  if (status === 404) return '资源不存在（HTTP 404）';
  if (status === 409) return '版本冲突，请刷新后重试（HTTP 409）';
  if (status === 503) return '服务暂不可用（HTTP 503）';
  return `请求失败（HTTP ${status}）`;
}

/**
 * 传输层 = `@autional/shared` 的 `createFetchClient`（与各门户同一套实现）：
 * 作用域头、超时、RFC7807 归一、401 一次静默续期；本站只保留自己的错误类型与文案。
 *
 * 本站特有语义（**不要改**）：管理面把「当前作用域查不到」也返 401（`30000001 secret not found`），
 * 那不是会话失效 —— 既不续期，也不派发 `UNAUTHORIZED_EVENT`（不把用户踢下线），直接交给调用方展示。
 */
function isDomainMiss(error: FetchApiError): boolean {
  return error.code === '30000001' || /not found/i.test(error.detail ?? '');
}

const clients = new Map<string, ReturnType<typeof createFetchClient>>();

function clientFor(base: string) {
  const cached = clients.get(base);
  if (cached) return cached;
  const client = createFetchClient({
    baseUrl: base,
    getToken: () => currentSession()?.accessToken ?? null,
    // 作用域头（X-Tenant-ID / X-App-ID / X-Namespace）含未登录时的兜底值，与迁移前一致
    getHeaders: () => scopeHeaders(),
    onUnauthorized: (error) => {
      if (isDomainMiss(error)) return;
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    },
    refresh: (error) => {
      if (isDomainMiss(error) || AUTH_MODE !== 'oidc') return Promise.resolve(null);
      return refreshSession().then((session) => session?.accessToken ?? null);
    },
    timeoutMs: 20_000,
  });
  clients.set(base, client);
  return client;
}

/** FetchApiError → 本站 ApiError（保留既有文案与业务码）。 */
function toApiError(error: unknown): ApiError {
  if (!(error instanceof FetchApiError)) {
    return new ApiError(0, (error as Error)?.message || '请求失败');
  }
  if (error.code === 'timeout') return new ApiError(0, error.message);
  if (error.code === 'aborted') return new ApiError(0, '请求已取消');
  if (error.code === 'network_error') return new ApiError(0, `无法连接服务：${error.detail || error.message}`);
  const problem = (error.body && typeof error.body === 'object' ? error.body : null) as ProblemBody;
  if (error.status === 401) {
    const domainMiss =
      String(problem?.code ?? error.code ?? '') === '30000001' || /not found/i.test(problem?.detail ?? '');
    return new ApiError(
      401,
      problemMessage(401, problem),
      problem?.code ?? (domainMiss ? 'not_found' : 'unauthorized'),
      problem?.detail ?? '',
    );
  }
  return new ApiError(error.status, problemMessage(error.status, problem), problem?.code ?? '', problem?.detail ?? '');
}

/** 统一请求入口：带作用域头、可被 401 触发一次静默续期、错误归一为 ApiError。 */
export async function request<T>(base: string, path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', query, body, scope, changeReason, timeoutMs } = options;
  const headers: Record<string, string> = { ...scopeHeaders(scope) };
  if (changeReason) headers['X-Change-Reason'] = changeReason;
  try {
    const data = await clientFor(base).request<T | null>(path, { method, query, body, timeoutMs, headers });
    return (data ?? undefined) as T;
  } catch (error) {
    throw toApiError(error);
  }
}

/* ------------------------------- 响应形状 ------------------------------- */

/** 管理面密钥条目（= service-secret 的 dto.SecretResponse，**不含密钥值**）。 */
export type SecretItem = {
  id?: string;
  tenant_id?: string;
  app_id?: string;
  key: string;
  description?: string;
  metadata?: Record<string, unknown>;
  version?: number;
  status?: string;
  expires_at?: string | null;
  notify_before?: number;
  created_at?: string;
  updated_at?: string;
};

export type SecretVersion = {
  version: number;
  created_by?: string;
  created_at?: string;
};

/** 详情 = 元数据 + 版本列表（仍然不含密钥值）。 */
export type SecretDetail = SecretItem & { versions?: SecretVersion[] };

export type SecretPolicy = {
  tenant_id?: string;
  default_ttl?: number;
  max_ttl?: number;
  auto_rotate_days?: number;
  notification_days_before?: number;
  max_versions?: number;
  require_rotation_for_fallback_keys?: boolean;
  updated_at?: string;
};

export type BatchResult = { succeeded?: string[]; errors?: { key: string; error: string }[] };

export type ListEnvelope<T> = {
  items?: T[];
  total?: number;
  pagination?: { page?: number; page_size?: number };
  data?: T[];
  code?: number;
  message?: string;
};

function unwrap<T>(res: { data?: T } | null | undefined, what: string): T {
  if (!res || res.data === undefined) throw new ApiError(500, `${what}响应缺少 data 字段`);
  return res.data;
}

/* -------------------------------- 密钥读 -------------------------------- */

export type ListSecretsQuery = {
  prefix?: string;
  status?: string;
  page?: number;
  page_size?: number;
};

/** 列表（只读）：返回密钥元数据，不含任何密钥值。
 *  scope 用于租户模式按行/按应用过滤（缺省取当前会话作用域）。 */
export async function listSecrets(query: ListSecretsQuery = {}, scope?: ScopeOverride): Promise<{ items: SecretItem[]; total: number }> {
  const res = await request<ListEnvelope<SecretItem>>(API_BASE, '', { query: { ...query }, scope });
  return { items: res?.items ?? res?.data ?? [], total: res?.total ?? 0 };
}

/* --------------------------- 平台盘点（跨租户/跨应用） --------------------------- */

export type SecretScope = { tenant_id: string; app_id: string; secret_count: number };

/** 全库 tenant×app 作用域（平台过滤下拉 + 盘点视图）。 */
export async function listAllScopes(): Promise<SecretScope[]> {
  const res = await request<{ data?: SecretScope[] }>(API_BASE, '/all/scopes');
  return Array.isArray(res?.data) ? res.data : [];
}

export type ListAllSecretsQuery = {
  tenant_id?: string;
  app_id?: string;
  prefix?: string;
  status?: string;
  page?: number;
  page_size?: number;
};

/** 平台盘点列表：tenant_id / app_id 为空表示不过滤（不依赖 X-Tenant-ID）。 */
export async function listAllSecrets(
  query: ListAllSecretsQuery = {},
): Promise<{ items: SecretItem[]; total: number }> {
  const res = await request<ListEnvelope<SecretItem>>(API_BASE, '/all', { query: { ...query } });
  return { items: res?.items ?? res?.data ?? [], total: res?.total ?? 0 };
}

/** 详情（只读）：元数据 + 版本列表。 */
export async function getSecretDetail(key: string, scope?: ScopeOverride): Promise<SecretDetail> {
  const res = await request<{ data?: SecretDetail }>(API_BASE, '/detail', { query: { key }, scope });
  return unwrap(res, '详情');
}

/** 应用作用域（tenant 下实际存在的 app_id 与条目数）。 */
export type AppScope = { app_id: string; secret_count: number };

export async function listAppScopes(): Promise<AppScope[]> {
  const res = await request<{ data?: AppScope[] }>(API_BASE, '/scopes');
  return Array.isArray(res?.data) ? res.data : [];
}

/* -------------------------------- 密钥写 -------------------------------- */

export type CreateSecretInput = {
  key: string;
  value: string;
  description?: string;
  expires_at?: string;
  /** 变更原因：写入 metadata.change_reason（服务端 metadata 上限 100 项）。 */
  reason?: string;
};

export async function createSecret(input: CreateSecretInput, scope?: ScopeOverride): Promise<SecretItem> {
  const { reason, ...rest } = input;
  const metadata = reason?.trim() ? { change_reason: reason.trim() } : undefined;
  const res = await request<{ data?: SecretItem }>(API_BASE, '', {
    method: 'POST',
    body: { ...rest, metadata },
    changeReason: reason?.trim() || undefined,
    scope,
  });
  return unwrap(res, '创建');
}

export type UpdateSecretInput = { description?: string; reason?: string };

/** 只更新元信息（描述 / metadata），不改变密钥值。 */
export async function updateSecretMeta(key: string, input: UpdateSecretInput, scope?: ScopeOverride): Promise<SecretItem> {
  const metadata = input.reason?.trim() ? { change_reason: input.reason.trim() } : undefined;
  const res = await request<{ data?: SecretItem }>(API_BASE, '/update', {
    method: 'POST',
    query: { key },
    body: { description: input.description, metadata },
    changeReason: input.reason?.trim() || undefined,
    scope,
  });
  return unwrap(res, '更新');
}

/** 轮换：写入新值并推进版本。 */
export async function rotateSecret(key: string, value: string, reason?: string, scope?: ScopeOverride): Promise<SecretItem> {
  const res = await request<{ data?: SecretItem }>(API_BASE, '/rotate', {
    method: 'POST',
    query: { key },
    body: { value },
    changeReason: reason?.trim() || undefined,
    scope,
  });
  return unwrap(res, '轮换');
}

export type SecretVersionValue = { key?: string; value?: string; version?: number; status?: string };

/** 查看指定版本的明文（服务端 `secret:admin` + 审计 `version_read`；reason 走 X-Change-Reason）。 */
export async function revealSecretVersion(
  key: string,
  version: number,
  reason: string,
  scope?: ScopeOverride,
): Promise<SecretVersionValue> {
  const res = await request<{ data?: SecretVersionValue }>(API_BASE, '/versions/value', {
    method: 'POST',
    query: { key },
    body: { version },
    changeReason: reason.trim(),
    scope,
  });
  return unwrap(res, '查看明文');
}

/** 吊销：状态置 revoked，版本保留。 */
export async function revokeSecret(key: string, reason?: string, scope?: ScopeOverride): Promise<void> {
  await request(API_BASE, '/revoke', { method: 'POST', query: { key }, changeReason: reason?.trim() || undefined, scope });
}

/** 删除（软删）。密钥路径可能含 `/`，逐段编码避免被当成新路径。 */
export async function deleteSecret(key: string, reason?: string, scope?: ScopeOverride): Promise<void> {
  const encoded = key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  await request(API_BASE, `/item/key/${encoded}`, { method: 'DELETE', changeReason: reason?.trim() || undefined, scope });
}

export async function batchRevokeSecrets(keys: string[], reason?: string, scope?: ScopeOverride): Promise<BatchResult> {
  const res = await request<{ data?: BatchResult }>(API_BASE, '/batch-revoke', {
    method: 'POST',
    body: { keys },
    changeReason: reason?.trim() || undefined,
    scope,
  });
  return unwrap(res, '批量吊销');
}

export async function batchDeleteSecrets(keys: string[], reason?: string, scope?: ScopeOverride): Promise<BatchResult> {
  const res = await request<{ data?: BatchResult }>(API_BASE, '/batch-delete', {
    method: 'POST',
    body: { keys },
    changeReason: reason?.trim() || undefined,
    scope,
  });
  return unwrap(res, '批量删除');
}

/* -------------------------------- 策略 / 密钥环 -------------------------------- */

export async function getSecretPolicy(scope?: ScopeOverride): Promise<SecretPolicy> {
  const res = await request<{ data?: SecretPolicy }>(API_BASE, '/policy', { scope });
  return unwrap(res, '策略');
}

export type SecretPolicyInput = {
  auto_rotate_days?: number;
  notification_days_before?: number;
  max_versions?: number;
  require_rotation_for_fallback_keys?: boolean;
};

export async function upsertSecretPolicy(input: SecretPolicyInput, reason?: string, scope?: ScopeOverride): Promise<SecretPolicy> {
  const res = await request<{ data?: SecretPolicy }>(API_BASE, '/policy', {
    method: 'PUT',
    body: input,
    changeReason: reason?.trim() || undefined,
    scope,
  });
  return unwrap(res, '策略');
}

export type EncryptionKeyInfo = { keyId?: string; key_id?: string; status?: string; createdAt?: string };
export async function getEncryptionKeys(): Promise<{ current: string; available: string[] }> {
  const res = await request<{ data?: { current?: string; keys?: EncryptionKeyInfo[] } }>(API_BASE, '/encryption-keys');
  const data = res?.data ?? {};
  const keys = Array.isArray(data.keys) ? data.keys : [];
  const available = keys
    .map((item) => String(item.keyId ?? item.key_id ?? ''))
    .filter((id): id is string => id !== '');
  return { current: String(data.current ?? available[0] ?? ''), available };
}


/* --------------------------- 名称解析（审计展示） --------------------------- */

export type TenantItem = { id: string; name: string; display_name?: string };

/** 平台租户列表（仅平台会话可用；用于审计租户名展示）。 */
export async function listTenants(): Promise<TenantItem[]> {
  const res = await request<{ items?: TenantItem[] }>(TENANT_BASE, '/tenants', {
    query: { page: 1, page_size: 100 },
  });
  return Array.isArray(res?.items) ? res.items : [];
}

export type UserItem = { id: string; username?: string; email?: string };

/** 单个租户详情（名称解析兜底：列表未覆盖时按 ID 取）。 */
export async function getTenant(tenantId: string): Promise<TenantItem | null> {
  try {
    const res = await request<{ data?: TenantItem }>(TENANT_BASE, `/tenants/${encodeURIComponent(tenantId)}`);
    return res?.data ?? null;
  } catch {
    return null;
  }
}

type IdentityItem = { type?: string; identifier?: string };
type UserEnvelope = {
  user?: UserItem;
  identities?: IdentityItem[];
} & UserItem;

/** 用户详情（按数据租户解析；失败返回 null，UI 回退显示 ID）。
 *
 * 管理面响应形状是 `{ data: { user: {...}, identities: [...] } }`（不是扁平的 user），
 * 且 username/email 在 identities 里也可能有值 —— 两者都要读。
 */
export async function getUser(userId: string, scope?: ScopeOverride): Promise<UserItem | null> {
  try {
    const res = await request<{ data?: UserEnvelope }>(IDENTITY_BASE, `/users/${encodeURIComponent(userId)}`, { scope });
    const data = res?.data;
    if (!data) return null;
    const user: UserItem = data.user ?? data;
    let username = user.username;
    let email = user.email;
    for (const item of data.identities ?? []) {
      if (!username && item.type === 'username') username = item.identifier;
      if (!email && item.type === 'email') email = item.identifier;
    }
    return { id: user.id || userId, username, email };
  } catch {
    return null;
  }
}

/* -------------------------------- 审计 -------------------------------- */

export type AuditLogItem = {
  id: string;
  tenant_id?: string;
  app_id?: string;
  operator_id?: string;
  operator_type?: string;
  module?: string;
  action?: string;
  target_id?: string;
  target_type?: string;
  status?: number;
  level?: string;
  message?: string;
  ip?: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
};

export type ListAuditQuery = {
  module?: string;
  action?: string;
  keyword?: string;
  page?: number;
  page_size?: number;
  start_date?: string;
  end_date?: string;
  /** 平台范围查询的数据租户（platform=true 时必填，可为 `_system`） */
  tenantId?: string;
  /** true = 走平台管理员跨租户端点（/platform/logs） */
  platform?: boolean;
};

/**
 * 审计查询。
 * - 普通模式：租户由 JWT 决定，只能看到认证租户；
 * - 平台模式（platform=true）：显式传 tenantId 读取任意租户（服务端要求平台租户 + super_admin/admin）。
 */
export async function listAudit(query: ListAuditQuery = {}): Promise<{ items: AuditLogItem[]; total: number }> {
  const { platform, tenantId, ...rest } = query;
  const path = platform ? '/platform/logs' : '/logs';
  const res = await request<ListEnvelope<AuditLogItem>>(AUDIT_BASE, path, {
    query: { module: 'secret', ...rest, tenant_id: platform ? tenantId : undefined },
  });
  return { items: res?.items ?? res?.data ?? [], total: res?.total ?? 0 };
}

/* -------------------------------- 健康探测 -------------------------------- */

export type ApiHealth = { ok: boolean; mode: 'mock' | 'api'; message: string };

export async function checkApi(): Promise<ApiHealth> {
  const session = currentSession();
  if (AUTH_MODE === 'oidc' && !session?.accessToken) {
    return { ok: false, mode: 'api', message: '未登录：未检测 API' };
  }
  try {
    const tenantId = session?.user.tenantId ?? '';
    const platform = !tenantId || tenantId === PLATFORM_TENANT_ID;
    const { total } = platform
      ? await listAllSecrets({ page: 1, page_size: 1 })
      : await listSecrets({ page: 1, page_size: 1 }, { tenantId });
    return {
      ok: true,
      mode: 'api',
      message: platform ? `已连通 ${API_BASE}（全平台共 ${total} 条）` : `已连通 ${API_BASE}（本租户共 ${total} 条）`,
    };
  } catch (err) {
    return { ok: false, mode: 'api', message: `${API_BASE} 不可达：${err instanceof Error ? err.message : String(err)}` };
  }
}
