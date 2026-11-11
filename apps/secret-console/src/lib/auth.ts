/**
 * 登录会话：OIDC 授权码 + PKCE（S256，state + nonce）。
 *
 * **实现已统一**：流程在 `@autional/shared/console-auth` 的 `createConsoleAuth`，
 * 本文件只负责「本站的策略与常量」：
 *   - 令牌存 **localStorage**（与 platform/admin/security 等门户一致；sessionStorage
 *     按标签页隔离，新标签或跨页跳转即掉登录，是此前「刷新/换页就掉线」的根因）；
 *   - 旧会话（v1 在 sessionStorage）一次性迁移；
 *   - 演示会话 = 密钥中心管理员。
 */
import {
  createConsoleAuth,
  type ConsoleSession,
  type ConsoleSessionUser,
} from '@autional/shared/console-auth';
import { APP_ID, AUTH_MODE, OIDC, TENANT_ID } from './config';

export type SessionUser = ConsoleSessionUser;
export type Session = ConsoleSession;

export const SESSION_STORAGE_KEY = 'secret-center:auth:v2';

const auth = createConsoleAuth({
  authMode: AUTH_MODE,
  // 本站策略：令牌存 localStorage（换页/新标签不掉线）
  storage: 'local',
  keys: {
    session: SESSION_STORAGE_KEY,
    pkce: 'secret-center:pkce:v1',
    mockSignedOut: 'secret-center:auth:signed-out:v1',
  },
  oidc: {
    authorizeUrl: OIDC.authorizeUrl,
    tokenUrl: OIDC.tokenUrl,
    clientId: OIDC.clientId,
    scope: OIDC.scope,
    redirectUri: OIDC.redirectUri,
  },
  /** 旧会话（v1 存 sessionStorage）：只迁移一次，避免升级后强制重登。 */
  legacy: { key: 'secret-center:auth:v1', from: 'session' },
  /** 演示会话：密钥中心管理员（VITE_AUTH_MODE=mock 默认）。 */
  mockSession: () => ({
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
  }),
});

export const mockSession = auth.mockSession;
/** 当前会话（同步读）；过期返回 null。 */
export const currentSession = auth.currentSession;
/** 启动时恢复会话：过期但有 refresh_token 时静默续期。 */
export const restoreSession = auth.restoreSession;
/** 发起登录：mock 直接给演示会话；oidc 生成 PKCE 并跳转授权端点。 */
export const startLogin = auth.startLogin;
/** 处理 `/oauth/callback?code=...&state=...`：校验 state、换票、校验 nonce、落会话。 */
export const completeLogin = auth.completeLogin;
/** 用 refresh_token 续期；单飞（并发 401 / 定时刷新只发一次）。 */
export const refreshSession = auth.refreshSession;
/** 主动续期：剩余有效期 < 阈值（默认 5 分钟）时刷新；供定时器 / 页面重新可见调用。 */
export const ensureFreshSession = auth.ensureFreshSession;
/** 退出登录：先吊销 refresh/access 令牌（服务端），再清本地会话。 */
export const signOut = auth.signOut;
/** 供 api 层调用：401 时尝试静默续期，成功则返回新会话。 */
export const renewAfterUnauthorized = auth.renewAfterUnauthorized;

/** 把用户资料合并进当前会话并落盘（用于 identity 补全展示名）。 */
export function patchSessionUser(patch: Partial<SessionUser>): Session | null {
  return auth.patchUser(patch);
}
