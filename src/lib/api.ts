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
 * 安全口径：本文件**不提供密钥明文读取**（`POST /versions/value` 未接入）。
 * 密钥值只写不读；列表/详情只返回元数据与版本号。
 */
import { currentSession, refreshSession } from './auth';
import { API_BASE, API_NAMESPACE, AUDIT_BASE, AUTH_MODE, IDENTITY_BASE, TENANT_BASE } from './config';
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

function buildUrl(base: string, path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(`${base}${path}`, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function parseProblem(res: Response): Promise<ProblemBody> {
  try {
    return (await res.json()) as ProblemBody;
  } catch {
    return null;
  }
}

function problemMessage(res: Response, problem: ProblemBody): string {
  const detail = problem?.detail || problem?.message || problem?.title;
  if (detail) return `${detail}（HTTP ${res.status}${problem?.code ? ` · ${problem.code}` : ''}）`;
  if (res.status === 400) return '请求参数不合法（HTTP 400）：常见原因是 X-Namespace 不属于实例 SECRET_NAMESPACES';
  if (res.status === 401) return '未登录或登录已过期（HTTP 401）';
  if (res.status === 403) return '无权限：密钥管理面需要 secret:admin（HTTP 403）';
  if (res.status === 404) return '资源不存在（HTTP 404）';
  if (res.status === 409) return '版本冲突，请刷新后重试（HTTP 409）';
  if (res.status === 503) return '服务暂不可用（HTTP 503）';
  return `请求失败（HTTP ${res.status}）`;
}

/** 统一请求入口：带作用域头、可被 401 触发一次静默续期、错误归一为 ApiError。 */
export async function request<T>(base: string, path: string, options: RequestOptions = {}): Promise<T> {
  const res = await send(base, path, options);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(res.status, '响应不是合法 JSON');
  }
}

async function send(base: string, path: string, options: RequestOptions): Promise<Response> {
  const { method = 'GET', query, body, changeReason, retried = false, timeoutMs = 20_000 } = options;
  const headers: Record<string, string> = { Accept: 'application/json', ...scopeHeaders(options.scope) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (changeReason) headers['X-Change-Reason'] = changeReason;

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(buildUrl(base, path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      credentials: 'omit',
    });
  } catch (cause) {
    const aborted = (cause as Error)?.name === 'AbortError';
    throw new ApiError(
      0,
      aborted ? `请求超时（${timeoutMs / 1000}s）` : `无法连接服务：${(cause as Error).message}`,
    );
  } finally {
    window.clearTimeout(timer);
  }

  if (res.status === 401) {
    if (!retried && AUTH_MODE === 'oidc') {
      const renewed = await refreshSession();
      if (renewed) return send(base, path, { ...options, retried: true });
    }
    const problem = await parseProblem(res);
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    throw new ApiError(401, problemMessage(res, problem), problem?.code ?? 'unauthorized', problem?.detail ?? '');
  }

  if (!res.ok) {
    const problem = await parseProblem(res);
    throw new ApiError(res.status, problemMessage(res, problem), problem?.code ?? '', problem?.detail ?? '');
  }
  return res;
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

/** 列表（只读）：返回密钥元数据，不含任何密钥值。 */
export async function listSecrets(query: ListSecretsQuery = {}): Promise<{ items: SecretItem[]; total: number }> {
  const res = await request<ListEnvelope<SecretItem>>(API_BASE, '', { query: { ...query } });
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
    query: { page: 1, page_size: 200 },
  });
  return Array.isArray(res?.items) ? res.items : [];
}

export type UserItem = { id: string; username?: string; email?: string };

/** 用户详情（按数据租户解析；失败返回 null，UI 回退显示 ID）。 */
export async function getUser(userId: string, scope?: ScopeOverride): Promise<UserItem | null> {
  try {
    const res = await request<{ data?: UserItem }>(IDENTITY_BASE, `/users/${encodeURIComponent(userId)}`, { scope });
    return res?.data ?? null;
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
  if (AUTH_MODE === 'oidc' && !currentSession()?.accessToken) {
    return { ok: false, mode: 'api', message: '未登录：未检测 API' };
  }
  try {
    const { total } = await listAllSecrets({ page: 1, page_size: 1 });
    return { ok: true, mode: 'api', message: `已连通 ${API_BASE}（全平台共 ${total} 条）` };
  } catch (err) {
    return { ok: false, mode: 'api', message: `${API_BASE} 不可达：${err instanceof Error ? err.message : String(err)}` };
  }
}
