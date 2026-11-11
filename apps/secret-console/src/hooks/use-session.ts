import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { AUTH_MODE, DATA_MODE, REQUIRE_AUTH, isCallbackPath } from '@/lib/config';
import { SESSION_STORAGE_KEY, completeLogin, ensureFreshSession, patchSessionUser, restoreSession, signOut, startLogin } from '@/lib/auth';
import type { Session } from '@/lib/auth';
import { UNAUTHORIZED_EVENT } from '@/lib/api';
import { resolveProfile } from '@/lib/profile';

type BootResult = { session: Session | null; error: string };

/**
 * 登录态引导：进程内只跑一次（StrictMode 二次挂载 / HMR 不会重复消费授权码）。
 * OIDC 回调页先换票，再把 URL 上的 code/state 清掉（避免刷新重放授权码）。
 */
let bootPromise: Promise<BootResult> | null = null;

function bootstrap(navigate: (to: string, opts?: { replace?: boolean }) => void): Promise<BootResult> {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    try {
      if (AUTH_MODE === 'oidc' && isCallbackPath()) {
        const params = new URLSearchParams(window.location.search);
        // 只有真的带了 code 才换票；直接刷新 /oauth/callback 时不能当成回调
        const oauthError = params.get('error_description') || params.get('error') || '';
        const session = params.get('code') ? await completeLogin(params.toString()) : await restoreSession();
        // 关键：用**路由**离开 /oauth/callback（不是 history.replaceState —— 后者不通知
        // BrowserRouter，路由仍停在回调地址 → 渲染 * 的 404）。刷新也不会再重放授权码。
        navigate('/', { replace: true });
        return { session, error: oauthError };
      }
      return { session: await restoreSession(), error: '' };
    } catch (err) {
      // 换票失败也离开回调地址（否则刷新会用同一个坏 code 反复失败）
      if (isCallbackPath()) navigate('/', { replace: true });
      return { session: null, error: err instanceof Error ? err.message : String(err) };
    }
  })();
  return bootPromise;
}

export function useSession() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void bootstrap(navigate).then((result) => {
      if (!alive) return;
      setSession(result.session);
      setError(result.error);
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, [navigate]);

  // 展示名补全：token 里没有 name/email 时，用 identity 资料替换「…XXXXXX」。
  useEffect(() => {
    const user = session?.user;
    if (!session || !user?.sub || !session.accessToken) return;
    if (!user.name.startsWith('…')) return;
    let alive = true;
    void resolveProfile({
      sub: user.sub,
      token: session.accessToken,
      tenantId: user.tenantId,
      appId: user.appId,
    }).then((patch) => {
      if (!alive || !patch) return;
      const next = patchSessionUser(patch);
      if (next) setSession(next);
    });
    return () => {
      alive = false;
    };
  }, [session?.user.sub, session?.accessToken]);

  // 主动续期：剩余 < 5 分钟时刷新；页面重新可见时也检查一次（与旧版一致）
  useEffect(() => {
    if (!session || AUTH_MODE === 'mock') return;
    let alive = true;
    const tick = async () => {
      const next = await ensureFreshSession();
      if (!alive) return;
      if (!next) {
        setSession(null);
        return;
      }
      setSession((prev) => (prev && prev.accessToken === next.accessToken ? prev : next));
    };
    const timer = window.setInterval(() => void tick(), 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [session?.accessToken]);

  // 跨标签同步：其它标签登录/退出时同步本标签
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== SESSION_STORAGE_KEY) return;
      if (!event.newValue) {
        setSession(null);
        return;
      }
      try {
        setSession(JSON.parse(event.newValue) as Session);
      } catch {
        /* 忽略损坏值 */
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // 令牌失效（401）：清会话，回到登录态
  useEffect(() => {
    const onUnauthorized = () => {
      // 401 强制登出：令牌已失效，吊销只会白等 2 个请求（各 3s 超时），直接清本地。
      void signOut({ revoke: false }).then(() => setSession(null));
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
