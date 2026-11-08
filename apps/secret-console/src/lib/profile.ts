import type { SessionUser } from './auth';
import { IDENTITY_BASE } from './config';

/**
 * 用 identity 服务补全展示名（token 里没有 name/email 时顶栏只剩 sub 尾段）。
 *
 * 刻意**不走** `lib/api` 的 request()：identity 若返回 401，共享层会当作会话失效
 * 触发登出。这里独立 fetch，任何失败一律静默。
 */
export async function resolveProfile(input: {
  sub: string;
  token: string;
  tenantId?: string;
  appId?: string;
}): Promise<Partial<SessionUser> | null> {
  const { sub, token, tenantId, appId } = input;
  if (!sub || !token) return null;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
  };
  if (tenantId) headers['X-Tenant-ID'] = tenantId;
  if (appId) headers['X-App-ID'] = appId;
  try {
    const res = await fetch(`${IDENTITY_BASE}/users/${encodeURIComponent(sub)}`, {
      headers,
      credentials: 'omit',
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as
      | { data?: { user?: { username?: string; email?: string } } }
      | null;
    const user = body?.data?.user ?? null;
    const username = typeof user?.username === 'string' ? user.username.trim() : '';
    const email = typeof user?.email === 'string' ? user.email.trim() : '';
    if (!username && !email) return null;
    const patch: Partial<SessionUser> = { name: username || email };
    if (email) patch.email = email;
    return patch;
  } catch {
    return null;
  }
}
