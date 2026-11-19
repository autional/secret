import { useEffect, useMemo, useRef } from 'react';
import {
  autoLoginAttemptedInThisDocument,
  decideAutoLogin,
  markAutoLoginAttemptedInThisDocument,
  readAutoLoginRecord,
  recordAutoJump,
  type AutoLoginDecision,
} from '@/lib/auto-login';

/**
 * 未登录时自动启动登录（免点击）。
 *
 * 只在「会话已就绪 + 需要登录 + 本页还没发起过登录跳转 + 没有待展示的登录错误」时
 * 触发**一次**；跨页面的循环由 `lib/auto-login` 的滑动窗口保护（60s 内 ≥3 次即停，
 * 回落闸门页）。
 *
 * 判定在渲染期用纯函数 `decideAutoLogin` 算（只多一次同步 sessionStorage 读），
 * 这样首帧直接显示「正在跳转…」，不会先闪一下登录按钮；副作用（打标记 / 写记录 /
 * 发起跳转）放在 effect 里，StrictMode 双执行也只跳一次。
 *
 * 返回 `pending`：本次正在自动跳转（调用方据此渲染等待态而不是闸门页）。
 */
export function useAutoLogin({
  ready,
  needsLogin,
  error,
  onLogin,
}: {
  ready: boolean;
  needsLogin: boolean;
  /** 上一次登录失败/被拒的错误文案；非空时不再自动跳（把错误和按钮交给用户）。 */
  error: string;
  onLogin: () => void;
}): boolean {
  const onLoginRef = useRef(onLogin);
  const warnedRef = useRef(false);

  useEffect(() => {
    onLoginRef.current = onLogin;
  }, [onLogin]);

  const decision = useMemo<AutoLoginDecision>(() => {
    if (!ready || !needsLogin) return { jump: false, reason: 'no-need' };
    return decideAutoLogin({
      ready,
      needsLogin,
      alreadyJumpedThisPage: autoLoginAttemptedInThisDocument(),
      attempts: readAutoLoginRecord().attempts,
      lastError: error,
      now: Date.now(),
    });
  }, [ready, needsLogin, error]);

  useEffect(() => {
    if (decision.reason === 'loop-guard' && !warnedRef.current) {
      warnedRef.current = true;
      console.warn(
        '[secret-console] 自动登录在 60 秒内已触发 3 次，已停止自动跳转并回落登录页；请手动点击登录按钮。',
      );
    }
    if (!decision.jump) return;
    // StrictMode 会执行两次 effect：幂等标记保证只跳一次。
    if (autoLoginAttemptedInThisDocument()) return;
    // 顺序很重要：先打标记 + 先写 sessionStorage，再发起跳转
    // （oidc 会整页离开，跳转之后的代码不一定还会执行）。
    markAutoLoginAttemptedInThisDocument();
    recordAutoJump();
    onLoginRef.current();
  }, [decision]);

  return decision.jump;
}
