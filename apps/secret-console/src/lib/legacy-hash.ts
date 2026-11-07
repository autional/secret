/**
 * 旧 hash 路由 → 新 path：
 *   #/                → /
 *   #/secrets?key=x   → /secrets?key=x
 *   #/audit           → /audit
 */
export function legacyHashToPath(hash: string): string | null {
  const raw = hash.replace(/^#\/?/, '');
  if (!raw) return null;
  const [path, search] = raw.split('?');
  const clean = path.replace(/\/+$/, '');
  const page = clean === 'secrets' ? '/secrets' : clean === 'audit' ? '/audit' : null;
  if (!page) return null;
  return search ? `${page}?${search}` : page;
}
