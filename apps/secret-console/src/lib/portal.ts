/**
 * 门户目录（平台租户 applications：`type=portal` / `is_platform=true` / `status=active`）。
 *
 * 目录来自平台，不在本仓维护域名表。端点与平台控制台一致（同源 `/bff` 由 `vercel.ts`
 * rewrites 代理到 api 网关）：
 *
 *   GET /bff/tenant/api/v1/admin/tenants/{tenantId}/applications?type=portal&is_platform=true&status=active
 *
 * 目录不可用是**正常路径**（未登录 401 / 平台租户 403 / 超时）：调用方降级为一个
 * 「平台控制台」出口，不弹错、不阻塞主内容。
 */
import { TENANT_BASE } from './config';

import {
  ADMIN_PLANE_ROLES as SHARED_ADMIN_PLANE_ROLES,
  getSwitcherExcludedCodes,
} from '@autional/shared/portal';

/** 平台租户 well-known ULID（service-core base/constant TenantPlatformID，全环境同值）。 */
export const PLATFORM_TENANT_ID = '01KSQCBNVMS6SX64PJS937CE33';

/** 当前门户 code：目录中命中它就标「当前」。 */
export const CURRENT_PORTAL_CODE = 'secret';

/** 非桌面切换目标 —— 取自 `@autional/shared/portal` 注册表（inSwitcher === false）。 */
const EXCLUDED_PORTAL_CODES: readonly string[] = getSwitcherExcludedCodes();

/** 管理面平面角色集 —— 取自 `@autional/shared/portal`（单一真源）。 */
const ADMIN_PLANE_ROLES: readonly string[] = SHARED_ADMIN_PLANE_ROLES;

const DEFAULT_TIMEOUT_MS = 5_000;
const TWO_PART_TLDS = new Set(['com.cn', 'co.uk', 'co.jp', 'com.au', 'co.nz']);

export type PortalApplication = {
  code: string;
  name: string;
  description?: string;
  order?: number;
  config?: {
    portal?: {
      host?: string;
      base?: string;
      allowed_roles?: string[];
      allowedRoles?: string[];
    };
  } | null;
};

export class PortalCatalogError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = 'PortalCatalogError';
    this.status = status;
  }
}

/** 根域：config.autional.cn → autional.cn；localhost / IP 原样。 */
export function rootDomainOf(hostname: string): string {
  let host = String(hostname ?? '').trim().toLowerCase();
  // 用 let 分阶段归一：先剥离 IPv6 方括号 / 端口，再做域名分段。
  if (!host) return '';
  if (host.startsWith('[')) return host.replace(/^\[|\](:\d+)?$/g, '');
  if ((host.match(/:/g) ?? []).length > 1) return host; // 裸 IPv6（::1 等）
  host = host.replace(/:\d+$/, '').replace(/\.$/, '');
  if (!host) return '';
  if (host === 'localhost' || /^\d+(\.\d+){3}$/.test(host)) return host;
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  if (host.endsWith('.local') && parts.length >= 3) return parts.slice(-3).join('.');
  if (TWO_PART_TLDS.has(parts.slice(-2).join('.'))) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

function normalizeBase(base?: string | null): string {
  const value = String(base ?? '').trim();
  if (!value) return '';
  return value.startsWith('/') ? value : `/${value}`;
}

/** 拼门户 URL；无法派生（缺 host / 缺根域）时返回 ''。 */
export function buildPortalUrl(entry: PortalApplication, rootDomain: string, protocol: string): string {
  const portal = entry?.config?.portal ?? null;
  const code = String(entry?.code ?? '').trim();
  const host = String(portal?.host ?? '').trim() || code;
  const root = String(rootDomain ?? '')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  if (!host || !root) return '';
  const fullHost = host === root || host.endsWith(`.${root}`) ? host : `${host}.${root}`;
  const proto = String(protocol ?? '').trim();
  return `${proto ? `${proto}//` : '//'}${fullHost}${normalizeBase(portal?.base)}`;
}

/** 目录不可用时的降级出口（仅此一处域名硬编码，按后缀选 cn / com）。 */
export function fallbackPlatformUrl(hostname: string): string {
  const host = String(hostname ?? '').trim().toLowerCase();
  return host.endsWith('.cn') ? 'https://platform.autional.cn' : 'https://platform.autional.com';
}

export type PortalFilterContext = {
  tenantId?: string | null;
  /** 会话 JWT 的 roles；空数组 = 令牌未带角色 → 不拦 admin/security，避免误伤。 */
  roles?: readonly string[] | null;
};

export function filterPortals(list: readonly PortalApplication[], ctx: PortalFilterContext = {}): PortalApplication[] {
  const excluded = new Set(EXCLUDED_PORTAL_CODES);
  const tenant = String(ctx.tenantId ?? '').trim() || PLATFORM_TENANT_ID;
  const isPlatformTenant = tenant === PLATFORM_TENANT_ID;
  const roles = (ctx.roles ?? []).filter((role): role is string => typeof role === 'string' && role.trim() !== '');

  return list.filter((app) => {
    const code = String(app?.code ?? '').trim();
    if (!code || excluded.has(code)) return false;
    if (code === 'platform') return isPlatformTenant;
    if (code === 'admin' || code === 'security' || code === 'secret') {
      if (roles.length === 0) return true;
      return roles.some((role) => ADMIN_PLANE_ROLES.includes(role));
    }
    return true;
  });
}

export type FetchPortalsOptions = {
  tenantId?: string | null;
  accessToken?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

export function portalCatalogUrl(tenantId: string): string {
  const base = TENANT_BASE.replace(/\/+$/, '');
  return `${base}/tenants/${encodeURIComponent(tenantId)}/applications?type=portal&is_platform=true&status=active`;
}

function parseCatalog(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const envelope = body as { code?: unknown; message?: unknown; data?: unknown; items?: unknown };
    if (typeof envelope.code === 'number' && envelope.code !== 0) {
      const detail = typeof envelope.message === 'string' && envelope.message ? `：${envelope.message}` : '';
      throw new PortalCatalogError(`门户目录返回错误码 ${envelope.code}${detail}`);
    }
    if (Array.isArray(envelope.data)) return envelope.data;
    if (Array.isArray(envelope.items)) return envelope.items;
  }
  return [];
}

function normalizeRows(rows: readonly unknown[]): PortalApplication[] {
  const out: PortalApplication[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const raw = row as Record<string, unknown>;
    const code = typeof raw.code === 'string' ? raw.code.trim() : '';
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push({
      code,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : code,
      description: typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim() : undefined,
      order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : undefined,
      config: raw.config && typeof raw.config === 'object' ? (raw.config as PortalApplication['config']) : null,
    });
  }
  return out;
}

/** 拉门户目录；失败即抛 `PortalCatalogError`，由调用方统一降级。 */
export async function fetchPortals(options: FetchPortalsOptions = {}): Promise<PortalApplication[]> {
  const { accessToken, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options;
  const tenant = String(options.tenantId ?? '').trim() || PLATFORM_TENANT_ID;
  const doFetch = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new PortalCatalogError('当前环境不支持 fetch');

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  headers['X-Tenant-ID'] = tenant;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  const forwardAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', forwardAbort);
  }

  try {
    let res: Response;
    try {
      res = await doFetch(portalCatalogUrl(tenant), {
        method: 'GET',
        headers,
        signal: controller.signal,
        credentials: 'omit',
      });
    } catch (cause) {
      const aborted = (cause as Error)?.name === 'AbortError';
      throw new PortalCatalogError(
        aborted
          ? `门户目录请求超时（${Math.round(timeoutMs / 100) / 10}s）`
          : `无法连接门户目录：${(cause as Error)?.message ?? ''}`,
      );
    }
    if (!res.ok) throw new PortalCatalogError(`门户目录请求失败（HTTP ${res.status}）`, res.status);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new PortalCatalogError('门户目录响应不是合法 JSON', res.status);
    }
    return normalizeRows(parseCatalog(body));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}
