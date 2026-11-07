import { useCallback, useEffect, useState } from 'react';
import { AUTH_MODE, DATA_MODE, REQUIRE_AUTH, isCallbackPath } from '@/lib/config';
import { completeLogin, restoreSession, signOut, startLogin } from '@/lib/auth';
import type { Session } from '@/lib/auth';
import { UNAUTHORIZED_EVENT } from '@/lib/api';

type BootResult = { session: Session | null; error: string };

/**
 * 登录态引导：进程内只跑一次（StrictMode 二次挂载 / HMR 不会重复消费授权码）。
 * OIDC 回调页先换票，再把 URL 上的 code/state 清掉（避免刷新重放授权码）。
 */
let bootPromise: Promise<BootResult> | null = null;

function bootstrap(): Promise<BootResult> {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    try {
      if (AUTH_MODE === 'oidc' && isCallbackPath()) {
        const session = await completeLogin();
        window.history.replaceState(null, '', window.location.pathname);
        return { session, error: '' };
      }
      return { session: await restoreSession(), error: '' };
    } catch (err) {
      return { session: null, error: err instanceof Error ? err.message : String(err) };
    }
  })();
  return bootPromise;
}

export function useSession() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void bootstrap().then((result) => {
      if (!alive) return;
      setSession(result.session);
      setError(result.error);
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 令牌失效（401）：清会话，回到登录态
  useEffect(() => {
    const onUnauthorized = () => {
      void signOut().then(() => setSession(null));
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const login = useCallback(async () => {
    setError('');
    try {
      const next = await startLogin();
      if (next) setSession(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const logout = useCallback(async () => {
    await signOut();
    setSession(null);
  }, []);

  // api 模式必须有 JWT；mock 演示只有显式 REQUIRE_AUTH 才挡
  const needsLogin = !session && (REQUIRE_AUTH || DATA_MODE === 'api');

  return { ready, session, error, needsLogin, login, logout };
}
