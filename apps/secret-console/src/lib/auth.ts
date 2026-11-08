/**
 * 登录会话：OIDC 授权码 + PKCE（S256，state + nonce）。
 *
 * 约定（与 platform SDK / 门户一致）：
 *   - 公开客户端（is_confidential=false），不存 client_secret；
 *   - token 存 localStorage（与其它门户一致）：刷新/新标签/跨页保持登录；
 *   - 回调地址默认 `${origin}/oauth/callback`，必须与 OAuth 客户端登记的 redirect_uris 逐字一致；
 *   - 主动续期：剩余 < 5 分钟或页面重新可见时自动 refresh；401 单飞重试。
 *   - VITE_AUTH_MODE=mock 时返回演示会话（密钥中心管理员），不发任何网络请求。
 *
 * 安全要点：
 *   - code_verifier / state / nonce 只存本标签页（sessionStorage），用完即删；
 *   - state 不匹配直接判失败（防 CSRF / 授权码注入）；
 *   - id_token 的 nonce 与本地保存值不一致同样判失败（防重放）。
 */
import { APP_ID, AUTH_MODE, OIDC, TENANT_ID } from './config';

export type SessionUser = {
  /** JWT sub / OIDC subject */
  sub: string;
  /** 展示名（name / preferred_username / email 依次回落） */
  name: string;
  email: string;
  /** 令牌内租户；空 = 需要 VITE_TENANT_ID 或由后端拒绝 */
  tenantId: string;
  /** 令牌内应用；空 = 平台应用 */
  appId: string;
  roles: string[];
};

export type Session = {
  mode: 'mock' | 'oidc';
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** epoch ms；0 = 不过期（mock） */
  expiresAt: number;
  user: SessionUser;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

type PkceState = {
  verifier: string;
  state: string;
  nonce: string;
  redirectUri: string;
  at: number;
};

export const SESSION_STORAGE_KEY = 'secret-center:auth:v2';
const SESSION_KEY = SESSION_STORAGE_KEY;
const LEGACY_SESSION_KEY = 'secret-center:auth:v1';
const PKCE_KEY = 'secret-center:pkce:v1';
/** mock 模式下点过「退出」的标记（否则演示会话每次都自动存在）。 */
const MOCK_SIGNED_OUT_KEY = 'secret-center:auth:signed-out:v1';

/** 提前 60s 视为过期，避免请求途中失效。 */
const EXPIRY_SKEW_MS = 60_000;

/**
 * localStorage 持久化（与 platform/admin/security 等门户一致）：
 * sessionStorage 按标签页隔离 —— 新标签打开或跨页跳转即掉登录，是此前「刷新/换页就掉线」的根因。
 * 隐私模式/被禁用时 try/catch 降级为「无会话」，绝不抛到 UI。
 */
function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 忽略：无存储时退化为「每次刷新都要重新登录」 */
  }
}

function removeStorage(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* 忽略 */
  }
}

/** 兼容旧会话（v1 在 sessionStorage）：只迁移一次，避免升级后强制重登。 */
function migrateLegacySession(): void {
  try {
    if (window.localStorage.getItem(SESSION_KEY)) return;
    const legacy = window.sessionStorage.getItem(LEGACY_SESSION_KEY);
    if (legacy) {
      window.localStorage.setItem(SESSION_KEY, legacy);
      window.sessionStorage.removeItem(LEGACY_SESSION_KEY);
    }
  } catch {
    /* 忽略 */
  }
}

function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(byteLength = 32): string {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return b64url(buf);
}

/** PKCE S256 challenge = base64url(sha256(verifier))。 */
async function challengeOf(verifier: string): Promise<string> {
  if (!window.crypto?.subtle) {
    throw new Error('当前环境不支持 WebCrypto（PKCE 需要 HTTPS 或 localhost）');
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

/** 解出 JWT / id_token 的 payload（不验签：签名校验在后端，前端只取展示用声明）。 */
function decodeJwtPayload(token?: string): Record<string, unknown> | null {
  if (!token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pickString(source: Record<string, unknown> | null, ...keys: string[]): string {
  if (!source) return '';
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

function pickRoles(source: Record<string, unknown> | null): string[] {
  if (!source) return [];
  for (const key of ['roles', 'role', 'authorities']) {
    const value = source[key];
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
    if (typeof value === 'string' && value !== '') return value.split(/[,\s]+/).filter(Boolean);
  }
  return [];
}

function userFromClaims(claims: Record<string, unknown> | null, fallbackName: string): SessionUser {
  const sub = pickString(claims, 'sub', 'user_id', 'userId');
  // 展示名：name → preferred_username → nickname → email → sub 尾段。
  // 之前缺省是「已登录用户」，顶栏出现「已 已登录用户」这种既重复又不提供身份的文案。
  const name =
    pickString(claims, 'name', 'preferred_username', 'nickname', 'email') ||
    (sub ? `…${sub.slice(-6)}` : fallbackName);
  return {
    sub,
    name,
    email: pickString(claims, 'email'),
    tenantId: pickString(claims, 'tenant_id', 'tenantId', 'tenant'),
    appId: pickString(claims, 'app_id', 'appId', 'application_id'),
    roles: pickRoles(claims),
  };
}

/** 过期时间：优先 JWT `exp`（服务端真实 TTL），其次 expires_in，最后 30 分钟兜底。 */
function expiresAtFromToken(accessToken: string, expiresIn?: number): number {
  const claims = decodeJwtPayload(accessToken);
  const exp = claims && typeof claims.exp === 'number' ? claims.exp : 0;
  if (exp > 0) return exp * 1000;
  const sec = Number(expiresIn);
  if (Number.isFinite(sec) && sec > 0) return Date.now() + sec * 1000;
  return Date.now() + 30 * 60_000;
}

function saveSession(session: Session): void {
  writeStorage(SESSION_KEY, JSON.stringify(session));
}

/** 把用户资料合并进当前会话并落盘（用于 identity 补全展示名）。 */
export function patchSessionUser(patch: Partial<SessionUser>): Session | null {
  const current = currentSession();
  if (!current) return null;
  const next: Session = { ...current, user: { ...current.user, ...patch } };
  saveSession(next);
  return next;
}

function clearSession(): void {
  removeStorage(SESSION_KEY);
}

function readPkce(): PkceState | null {
  const raw = readStorage(PKCE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PkceState;
    if (!parsed?.verifier || !parsed?.state) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 演示会话：密钥中心管理员（VITE_AUTH_MODE=mock 默认）。 */
export function mockSession(): Session {
  return {
    mode: 'mock',
    accessToken: '',
    expiresAt: 0,
    user: {
      sub: 'demo-secret-admin',
      name: '密钥中心管理员',
      email: 'secret-admin@demo.local',
      tenantId: TENANT_ID,
      appId: APP_ID,
      roles: ['super_admin'],
    },
  };
}

/** 会话真实过期时间：优先 JWT exp（兼容旧存储里按 expires_in 估算的偏差）。 */
function sessionExpiry(session: Session): number {
  const claims = decodeJwtPayload(session.accessToken);
  const exp = claims && typeof claims.exp === 'number' ? claims.exp * 1000 : 0;
  return exp > 0 ? exp : session.expiresAt;
}

/** 当前会话（同步读）；过期返回 null。 */
export function currentSession(): Session | null {
  if (AUTH_MODE === 'mock') {
    migrateLegacySession();
    return readStorage(MOCK_SIGNED_OUT_KEY) === '1' ? null : mockSession();
  }
  const raw = readStorage(SESSION_KEY);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as Session;
    if (!session?.accessToken) return null;
    const expiry = sessionExpiry(session);
    if (expiry > 0 && Date.now() > expiry - EXPIRY_SKEW_MS) return null;
    return session;
  } catch {
    return null;
  }
}

/** 启动时恢复会话：过期但有 refresh_token 时静默续期。 */
export async function restoreSession(): Promise<Session | null> {
  if (AUTH_MODE === 'mock') return currentSession();
  migrateLegacySession();
  const raw = readStorage(SESSION_KEY);
  if (!raw) return null;
  let stored: Session;
  try {
    stored = JSON.parse(raw) as Session;
  } catch {
    clearSession();
    return null;
  }
  const storedExpiry = stored?.accessToken ? sessionExpiry(stored) : 0;
  if (stored?.accessToken && (storedExpiry === 0 || Date.now() <= storedExpiry - EXPIRY_SKEW_MS)) {
    return stored;
  }
  const refreshed = await refreshSession(stored);
  return refreshed;
}

/**
 * 发起登录。
 *  - mock：直接返回演示会话（不跳转）；
 *  - oidc：生成 PKCE 上下文并跳转授权端点，返回 null（页面即将离开）。
 */
export async function startLogin(): Promise<Session | null> {
  if (AUTH_MODE === 'mock') {
    removeStorage(MOCK_SIGNED_OUT_KEY);
    const session = mockSession();
    saveSession(session);
    return session;
  }
  if (!OIDC.clientId) {
    throw new Error('缺少 VITE_OIDC_CLIENT_ID：请先在 OAuth 客户端登记回调地址并配置客户端 ID');
  }

  const verifier = randomToken(48); // 64 字符 base64url，落在 RFC 7636 的 43–128 区间
  const state = randomToken(16);
  const nonce = randomToken(16);
  const redirectUri = OIDC.redirectUri;

  writeStorage(PKCE_KEY, JSON.stringify({ verifier, state, nonce, redirectUri, at: Date.now() } satisfies PkceState));

  const url = new URL(OIDC.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', OIDC.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', OIDC.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', await challengeOf(verifier));
  url.searchParams.set('code_challenge_method', 'S256');

  window.location.assign(url.toString());
  return null;
}

/** 令牌端点错误：区分「网络/网关瞬时故障」与「确定失败（invalid_grant 等）」。 */
class TokenError extends Error {
  readonly transient: boolean;

  constructor(message: string, transient: boolean) {
    super(message);
    this.name = 'TokenError';
    this.transient = transient;
  }
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch(OIDC.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
  } catch (cause) {
    throw new TokenError(`无法连接令牌端点（${OIDC.tokenUrl}）：${(cause as Error).message}`, true);
  }
  const data = (await res.json().catch(() => null)) as TokenResponse | null;
  if (!res.ok || !data?.access_token) {
    const reason = data?.error_description || data?.error || `HTTP ${res.status}`;
    // 5xx / 0 = 瞬时；4xx（invalid_grant 等）= 确定失败
    throw new TokenError(`换取令牌失败：${reason}`, res.status >= 500 || res.status === 0);
  }
  return data;
}

/** 处理 `/oauth/callback?code=...&state=...`：校验 state、换票、校验 nonce、落会话。 */
export async function completeLogin(search: string = window.location.search): Promise<Session> {
  const query = new URLSearchParams(search);
  const error = query.get('error');
  if (error) {
    const desc = query.get('error_description');
    throw new Error(`授权被拒绝：${error}${desc ? ` · ${desc}` : ''}`);
  }
  const code = query.get('code');
  const state = query.get('state');
  if (!code) throw new Error('回调缺少 code 参数');

  const pkce = readPkce();
  if (!pkce) throw new Error('登录会话已失效（缺少 PKCE 上下文），请重新登录');
  if (!state || state !== pkce.state) throw new Error('state 校验失败（可能的 CSRF），请重新登录');
  if (Date.now() - pkce.at > 10 * 60_000) {
    removeStorage(PKCE_KEY);
    throw new Error('登录超时，请重新登录');
  }
  if (!OIDC.clientId) throw new Error('缺少 VITE_OIDC_CLIENT_ID');

  const data = await postToken(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: pkce.redirectUri,
      client_id: OIDC.clientId,
      code_verifier: pkce.verifier,
    }),
  );

  const claims = decodeJwtPayload(data.id_token) ?? decodeJwtPayload(data.access_token);
  const nonceClaim = pickString(claims, 'nonce');
  if (nonceClaim && nonceClaim !== pkce.nonce) {
    removeStorage(PKCE_KEY);
    throw new Error('nonce 校验失败（令牌可能被重放），请重新登录');
  }

  removeStorage(PKCE_KEY);

  const session: Session = {
    mode: 'oidc',
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token,
    idToken: data.id_token,
    expiresAt: expiresAtFromToken(data.access_token as string, data.expires_in),
    user: userFromClaims(claims, '已登录用户'),
  };
  saveSession(session);
  return session;
}

let refreshInFlight: Promise<Session | null> | null = null;

/** 用 refresh_token 续期；单飞（并发 401/定时刷新只发一次）。确定失败才清会话。 */
export function refreshSession(stored?: Session | null): Promise<Session | null> {
  if (AUTH_MODE === 'mock') return Promise.resolve(currentSession());
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefreshSession(stored).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function doRefreshSession(stored?: Session | null): Promise<Session | null> {
  let base = stored ?? null;
  if (!base) {
    const raw = readStorage(SESSION_KEY);
    if (!raw) return null;
    try {
      base = JSON.parse(raw) as Session;
    } catch {
      clearSession();
      return null;
    }
  }
  if (!base?.refreshToken || !OIDC.clientId) {
    clearSession();
    return null;
  }
  try {
    const data = await postToken(
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: base.refreshToken,
        client_id: OIDC.clientId,
      }),
    );
    const claims = decodeJwtPayload(data.id_token) ?? decodeJwtPayload(data.access_token);
    const session: Session = {
      mode: 'oidc',
      accessToken: data.access_token as string,
      refreshToken: data.refresh_token ?? base.refreshToken,
      idToken: data.id_token ?? base.idToken,
      expiresAt: expiresAtFromToken(data.access_token as string, data.expires_in),
      user: userFromClaims(claims, base.user?.name || '已登录用户'),
    };
    // identity 补全过的展示名不要被 token 里的 sub 尾段覆盖（每 5 分钟续期都会重建 user）。
    if (session.user.name.startsWith('…') && base.user?.name && !base.user.name.startsWith('…')) {
      session.user = { ...session.user, name: base.user.name, email: session.user.email || base.user.email };
    }
    // 令牌内没有租户/应用声明时，保留上一轮已知值，避免 X-Tenant-ID 丢失。
    if (!session.user.tenantId) session.user.tenantId = base.user?.tenantId ?? '';
    if (!session.user.appId) session.user.appId = base.user?.appId ?? '';
    saveSession(session);
    return session;
  } catch (err) {
    // 网络/网关瞬时故障：保留会话（延长 30s 让 UI 不立刻掉登录），下一次请求/定时器再续。
    if (err instanceof TokenError && err.transient) {
      const keep: Session = { ...base, expiresAt: Math.max(base.expiresAt, Date.now() + 30_000) };
      saveSession(keep);
      return keep;
    }
    clearSession();
    return null;
  }
}

/**
 * 主动续期：剩余有效期 < 5 分钟时刷新。
 * 供 App 定时器 / 页面重新可见时调用；无会话返回 null。
 */
export async function ensureFreshSession(): Promise<Session | null> {
  if (AUTH_MODE === 'mock') return currentSession();
  migrateLegacySession();
  const raw = readStorage(SESSION_KEY);
  if (!raw) return null;
  let stored: Session;
  try {
    stored = JSON.parse(raw) as Session;
  } catch {
    clearSession();
    return null;
  }
  if (!stored?.accessToken) return null;
  const expiry = sessionExpiry(stored);
  if (expiry === 0 || expiry - Date.now() > 5 * 60_000) return stored;
  return refreshSession(stored);
}

/** OAuth revoke 端点（与 token 同源：把 `/token` 换成 `/revoke`）。 */
function oauthRevokeUrl(): string {
  return OIDC.tokenUrl.replace(/\/token(\?.*)?$/, '/revoke');
}

/** 服务端吊销单个 token（fire-and-forget，3s 超时；失败不阻塞登出）。 */
async function revokeToken(token: string, hint: 'access_token' | 'refresh_token'): Promise<void> {
  if (!OIDC.clientId) return;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 3000);
  try {
    await fetch(oauthRevokeUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ token, token_type_hint: hint, client_id: OIDC.clientId }).toString(),
      signal: controller.signal,
      credentials: 'omit',
      keepalive: true,
    });
  } catch {
    /* 网络/超时忽略：本地会话仍会清除 */
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * 退出登录：先尝试服务端吊销 refresh/access token（与其它门户一致），再清本地会话。
 * `revoke:false` 用于 401 强制登出（token 已无效，避免无谓等待/噪声）。
 */
export async function signOut(options: { revoke?: boolean } = {}): Promise<void> {
  if (AUTH_MODE === 'oidc' && options.revoke !== false) {
    const raw = readStorage(SESSION_KEY);
    let stored: Session | null = null;
    try {
      stored = raw ? (JSON.parse(raw) as Session) : null;
    } catch {
      stored = null;
    }
    if (stored) {
      const tasks: Promise<void>[] = [];
      if (stored.refreshToken) tasks.push(revokeToken(stored.refreshToken, 'refresh_token'));
      if (stored.accessToken) tasks.push(revokeToken(stored.accessToken, 'access_token'));
      if (tasks.length) await Promise.allSettled(tasks);
    }
  }
  clearSession();
  removeStorage(PKCE_KEY);
  if (AUTH_MODE === 'mock') writeStorage(MOCK_SIGNED_OUT_KEY, '1');
}

/** 供 api 层调用：401 时尝试静默续期，成功则返回新会话。 */
export async function renewAfterUnauthorized(): Promise<Session | null> {
  return refreshSession();
}
