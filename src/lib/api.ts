/**
 * 密钥中心管理面 API 客户端（`/api/v1/admin/secrets`，网关 `/bff/secret/...`）。
 *
 * 只读占位实现：目前只调用两个读接口，
 *   - `GET /`（列表，支持 prefix / status / page / page_size）；
 *   - `GET /detail?key=...`（详情元数据 + 版本列表，不含密钥值）。
 * 创建 / 轮换 / 撤销等写入接口**尚未接入**，本文件不提供任何写方法。
 *
 * 鉴权：`Authorization: Bearer <JWT>` + `X-Tenant-ID` + `X-App-ID`；租户/应用一律取自登录令牌，
 * `VITE_TENANT_ID` / `VITE_APP_ID` 只做兜底。
 *
 * 响应信封：`{ code, message, items, total, pagination }` / `{ code, message, data }`。
 */
import { currentSession, refreshSession } from './auth';
import { API_BASE, APP_ID, AUTH_MODE, DATA_MODE, TENANT_ID } from './config';

/** 管理面错误（统一携带 HTTP 状态与业务错误码，便于 UI 分流 401/403/503）。 */
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

export type RequestOptions = {
  method?: 'GET';
  query?: Record<string, QueryValue>;
  /** 内部用：401 后已重试过一次 */
  retried?: boolean;
  timeoutMs?: number;
};

function scopeHeaders(): Record<string, string> {
  const session = currentSession();
  const headers: Record<string, string> = {};
  const tenant = session?.user.tenantId || TENANT_ID;
  const app = session?.user.appId || APP_ID;
  if (session?.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;
  // 后端要求该头必填；值为空时交给后端判 401（不伪造）。
  if (tenant) headers['X-Tenant-ID'] = tenant;
  if (app) headers['X-App-ID'] = app;
  return headers;
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(`${API_BASE}${path}`, window.location.origin);
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
  if (res.status === 401) return '未登录或登录已过期（HTTP 401）';
  if (res.status === 403) return '无权限：密钥管理面需要相应读取权限（HTTP 403）';
  if (res.status === 503) return '服务暂不可用（HTTP 503）';
  return `请求失败（HTTP ${res.status}）`;
}

/** 统一请求入口：带作用域头、可被 401 触发一次静默续期、错误归一为 ApiError。 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const res = await send(path, options);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(res.status, '响应不是合法 JSON');
  }
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const { method = 'GET', query, retried = false, timeoutMs = 20_000 } = options;
  const headers: Record<string, string> = { Accept: 'application/json', ...scopeHeaders() };

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      headers,
      signal: controller.signal,
      credentials: 'omit',
    });
  } catch (cause) {
    const aborted = (cause as Error)?.name === 'AbortError';
    throw new ApiError(0, aborted ? `请求超时（${timeoutMs / 1000}s）` : `无法连接密钥服务：${(cause as Error).message}`);
  } finally {
    window.clearTimeout(timer);
  }

  if (res.status === 401) {
    if (!retried && AUTH_MODE === 'oidc') {
      const renewed = await refreshSession();
      if (renewed) return send(path, { ...options, retried: true });
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

type ListEnvelope = { items?: SecretItem[]; total?: number; pagination?: { page?: number; page_size?: number } };

export type ListSecretsQuery = {
  prefix?: string;
  status?: string;
  page?: number;
  page_size?: number;
};

/** 列表（只读）：返回密钥元数据，不含任何密钥值。 */
export async function listSecrets(query: ListSecretsQuery = {}): Promise<SecretItem[]> {
  const res = await request<ListEnvelope>('', { query: { ...query } });
  return res?.items ?? [];
}

/** 详情（只读）：返回元数据 + 版本列表。 */
export async function getSecretDetail(key: string): Promise<SecretDetail> {
  const res = await request<{ data?: SecretDetail }>('/detail', { query: { key } });
  if (!res?.data) throw new ApiError(500, '详情响应缺少 data 字段');
  return res.data;
}

/** API 连通性探测结果（供页面展示，不抛异常）。 */
export type ApiHealth = { ok: boolean; mode: 'mock' | 'api'; message: string };

export async function checkApi(): Promise<ApiHealth> {
  if (DATA_MODE === 'mock') {
    return { ok: true, mode: 'mock', message: '演示模式：未发起真实 API 请求' };
  }
  try {
    await listSecrets({ page: 1, page_size: 1 });
    return { ok: true, mode: 'api', message: `已连通 ${API_BASE}` };
  } catch (err) {
    return { ok: false, mode: 'api', message: `${API_BASE} 不可达：${err instanceof Error ? err.message : String(err)}` };
  }
}
