import { describe, expect, it } from 'vitest';
import { namespaceOfHost } from './config';

/**
 * 命名空间缺省值：prod 栈实例 `SECRET_NAMESPACES=prod`，缺省会 400（fail-closed）。
 * 正式域必须推导为 prod；本地/预览保持 dev。
 */
describe('namespaceOfHost', () => {
  it('正式域推导为 prod', () => {
    expect(namespaceOfHost('secret.autional.com')).toBe('prod');
    expect(namespaceOfHost('secret.autional.cn')).toBe('prod');
  });

  it('本地 / 预览 / 空值推导为 dev', () => {
    expect(namespaceOfHost('localhost')).toBe('dev');
    expect(namespaceOfHost('127.0.0.1')).toBe('dev');
    expect(namespaceOfHost('secret-git-main.vercel.app')).toBe('dev');
    expect(namespaceOfHost('')).toBe('dev');
  });

  it('大小写与前缀不误判', () => {
    expect(namespaceOfHost('SECRET.AUTIONAL.COM')).toBe('prod');
    expect(namespaceOfHost('secret.autional.com.evil.com')).toBe('dev');
  });
});
