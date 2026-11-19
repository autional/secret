/**
 * 根路径深链兼容：`/?key=<KEY>` 视同 `/secrets?key=<KEY>`。
 *
 * 背景：控制台/通知里的旧链接、以及部分手写链接把 `?key=` 挂在站点根，
 * 而深链逻辑只长在 `/secrets`。这里只回答「要不要转、转到哪」，渲染与跳转交给路由层，
 * 便于单测（本仓 vitest 是 node 环境，没有组件渲染基建）。
 */

const SECRETS_PATH = '/secrets';

/**
 * 计算根路径的重定向目标。
 *
 * - 有非空 `key` ⇒ 返回 `/secrets?...`（**原样保留** query 字节与 hash，不重排/不重编码）
 * - 无 `key` / `key` 为空串 ⇒ 返回 null（根路径保持原有渲染：概览页）
 *
 * @param search `window.location.search`（可带或不带前导 `?`）
 * @param hash   `window.location.hash`（可带或不带前导 `#`）
 */
export function rootDeepLinkTarget(search: string, hash = ''): string | null {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  if (!raw) return null;
  // 与 /secrets 的判定口径一致：searchParams.get('key') 为空（缺省或空串）就不算深链
  if (!new URLSearchParams(raw).get('key')) return null;
  const suffix = hash && hash !== '#' ? (hash.startsWith('#') ? hash : `#${hash}`) : '';
  return `${SECRETS_PATH}?${raw}${suffix}`;
}
