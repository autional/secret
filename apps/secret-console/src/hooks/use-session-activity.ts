import { useSessionActivity as useSharedSessionActivity } from '@autional/shared';
import type { Session } from '@/lib/auth';

/**
 * 心跳端点：走管理面前缀（网关已对该前缀做 admin 平面 + 角色粗筛）；
 * sid 取自 token，服务端只允许续「自己的」会话。
 */
const ACTIVITY_URL = '/bff/session/api/v1/admin/sessions/me/activity';

/**
 * 会话活动心跳（NIST「activity resets inactivity」口径）。
 *
 * 实现已收进 `@autional/shared`（单一真源），这里只钉「端点 + 取 token 的方式」：
 * 本门户的 token 存 sessionStorage（`@/lib/auth`），不是 shared 的 auth store，
 * 所以必须注入 getToken —— 用默认实现会取不到 token，心跳静默停发。
 *
 * - 只在「页面可见 + 最近 5 分钟有真实交互」时上报；人不在就不发，交给服务端闲置过期。
 * - 只刷新闲置窗口，绝对上限（12h）由服务端固定，心跳无法突破。
 * - 失败静默：端点未上线/网关未放行时不影响业务请求。
 */
export function useSessionActivity(session: Session | null, enabled = true): void {
  useSharedSessionActivity({
    endpoint: ACTIVITY_URL,
    getToken: () => session?.accessToken ?? null,
    disabled: !enabled,
  });
}
