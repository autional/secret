import { describe, expect, it } from 'vitest';
import { rootDeepLinkTarget } from './root-deeplink';

describe('rootDeepLinkTarget（/?key= ⇒ /secrets?key=）', () => {
  it('有 key ⇒ 转到 /secrets 并保留 query', () => {
    expect(rootDeepLinkTarget('?key=abc')).toBe('/secrets?key=abc');
    // 不带前导 ? 也接受
    expect(rootDeepLinkTarget('key=abc')).toBe('/secrets?key=abc');
  });

  it('保留其它 query 参数（tenant/app/service）且不改动原字节', () => {
    expect(rootDeepLinkTarget('?key=abc&tenant=t1&app=a1')).toBe('/secrets?key=abc&tenant=t1&app=a1');
    // 已编码的 key 原样透传（与 /secrets 深链同源）
    expect(rootDeepLinkTarget('?key=jwt%2Fsigning%2Fprimary')).toBe('/secrets?key=jwt%2Fsigning%2Fprimary');
  });

  it('保留 hash', () => {
    expect(rootDeepLinkTarget('?key=abc', '#versions')).toBe('/secrets?key=abc#versions');
    expect(rootDeepLinkTarget('?key=abc', '#')).toBe('/secrets?key=abc');
  });

  it('无 key ⇒ 不重定向（根路径保持概览页）', () => {
    expect(rootDeepLinkTarget('')).toBeNull();
    expect(rootDeepLinkTarget('?')).toBeNull();
    expect(rootDeepLinkTarget('?tenant=t1')).toBeNull();
  });

  it('空 key ⇒ 不重定向', () => {
    expect(rootDeepLinkTarget('?key=')).toBeNull();
    expect(rootDeepLinkTarget('?key=&foo=1')).toBeNull();
    expect(rootDeepLinkTarget('?key')).toBeNull();
  });

  it('大小写敏感：KEY 不是 key（与 searchParams.get 口径一致）', () => {
    expect(rootDeepLinkTarget('?KEY=abc')).toBeNull();
  });
});
