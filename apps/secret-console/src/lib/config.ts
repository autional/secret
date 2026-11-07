/**
 * 运行期配置（构建期注入的 VITE_* 环境变量）。
 *
 * 两个正交开关：
 *   - VITE_DATA_MODE = mock（默认）| api   —— 数据从占位数据来，还是走密钥服务管理面真实接口；
 *   - VITE_AUTH_MODE = mock（默认）| oidc  —— 会话来自演示账号，还是走 OIDC 授权码 + PKCE。
 *
 * 默认全 mock：公开演示无需后端、无需登录即可查看占位页面。
 * 切 api/oidc 见 README「接入真实 API」。
 */

type RawEnv = Record<string, string | undefined>;

const env = (import.meta.env ?? {}) as unknown as RawEnv;

/** 读字符串环境变量；缺省/空串一律回落默认值（避免 `VITE_X=` 把默认值打成空）。 */
function str(name: string, fallback = ''): string {
  const raw = env[name];
  if (raw === undefined || raw === null) return fallback;
  const value = String(raw).trim();
  return value === '' ? fallback : value;
}

export type DataMode = 'mock' | 'api';
export type AuthMode = 'mock' | 'oidc';

/** 非浏览器环境（node 单测）返回空串，避免模块初始化就抛。 */
function currentOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location?.origin ?? '';
}

function currentHostname(): string {
  return typeof window === 'undefined' ? '' : window.location?.hostname ?? '';
}

export const DATA_MODE: DataMode = str('VITE_DATA_MODE', 'mock').toLowerCase() === 'api' ? 'api' : 'mock';
export const AUTH_MODE: AuthMode = str('VITE_AUTH_MODE', 'mock').toLowerCase() === 'oidc' ? 'oidc' : 'mock';

/**
 * 密钥服务管理面 API 基址。默认走同源 `/bff/secret/...`：
 * 生产由 vercel.ts 的 rewrites 代理到 https://api.autional.com/bff/...（服务端代理，无 CORS）；
 * 本地 dev 可在 vite 代理或 VITE_API_BASE 直接指向网关。
 */
export const API_BASE = str('VITE_API_BASE', '/bff/secret/api/v1/admin/secrets').replace(/\/+$/, '');

/** 审计查询（独立服务；租户由 JWT 决定，见 lib/api.ts listAudit）。 */
export const AUDIT_BASE = str('VITE_AUDIT_BASE', '/bff/audit/api/v1/admin/audit').replace(/\/+$/, '');

/** 租户服务管理面（门户目录）。 */
export const TENANT_BASE = str('VITE_TENANT_BASE', '/bff/tenant/api/v1/admin').replace(/\/+$/, '');

/** 身份服务管理面（审计操作者姓名解析）。 */
export const IDENTITY_BASE = str('VITE_IDENTITY_BASE', '/bff/identity/api/v1/admin').replace(/\/+$/, '');

/**
 * 密钥服务要求 X-Namespace，值必须 ∈ 实例 `SECRET_NAMESPACES`，否则 **400**（fail-closed）。
 * 该维度已从数据模型移除（只做门禁，不分区数据）。
 *
 * 缺省按站点域名推导：正式域（secret.autional.com / .cn）→ `prod`；其它（本地/预览）→ `dev`。
 * `VITE_API_NAMESPACE` 显式设置时优先（多命名空间实例可自行覆盖）。
 */
export function namespaceOfHost(hostname: string): string {
  const host = String(hostname ?? '').trim().toLowerCase();
  return host === 'secret.autional.com' || host === 'secret.autional.cn' ? 'prod' : 'dev';
}

function defaultNamespace(): string {
  return namespaceOfHost(currentHostname());
}

export const API_NAMESPACE = str('VITE_API_NAMESPACE', defaultNamespace());

/** 平台租户 well-known ULID（全环境同值；默认数据作用域）。 */
export const PLATFORM_TENANT_ID = '01KSQCBNVMS6SX64PJS937CE33';

/** 租户/应用作用域：JWT 已带租户时以令牌为准（见 lib/api.ts），此处是兜底。 */
export const TENANT_ID = str('VITE_TENANT_ID');
export const APP_ID = str('VITE_APP_ID');

/** 1 = 未登录不得进入控制台（默认 0：mock 演示可直接看）。 */
export const REQUIRE_AUTH = str('VITE_REQUIRE_AUTH') === '1';

/** OIDC 授权码 + PKCE 参数。 */
export const OIDC = {
  authorizeUrl: str('VITE_OIDC_AUTHORIZE', 'https://auth.autional.com/oauth/api/v1/oauth/authorize'),
  tokenUrl: str('VITE_OIDC_TOKEN', 'https://api.autional.com/bff/oauth/api/v1/oauth/token'),
  clientId: str('VITE_OIDC_CLIENT_ID'),
  redirectUri: str('VITE_OIDC_REDIRECT_URI', `${currentOrigin()}/oauth/callback`),
  /**
   * 读接口自 2026-11-06 起统一要求 `scope=read`（18 服务 + 网关 BFF）；
   * `offline_access` 用于拿 refresh_token。缺 `read` → 登录成功但读接口 403。
   */
  scope: str('VITE_OIDC_SCOPE', 'openid profile email offline_access read'),
} as const;

/** 「返回平台」链接：默认按访问域名区分 com / cn，可用 VITE_PLATFORM_URL 覆盖。 */
const REGION = currentHostname().endsWith('.cn') ? 'cn' : 'com';
export const PLATFORM_URL = str('VITE_PLATFORM_URL', `https://platform.autional.${REGION}`);

/** 当前地址是否 OIDC 回调页（`/oauth/callback`）。 */
export function isCallbackPath(pathname: string = typeof window === 'undefined' ? '' : window.location.pathname): boolean {
  return pathname.replace(/\/+$/, '') === '/oauth/callback';
}

/** 当前构建的配置摘要，供页面提示与排障使用。 */
export const RUNTIME_MODE_LABEL = DATA_MODE === 'api' ? '真实 API' : '演示数据';
