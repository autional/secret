import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLATFORM_TENANT_ID } from './config';
import { SYSTEM_TENANT, clearScope, defaultScope, resolveScope, saveScope } from './scope';

/** 最小 sessionStorage 桩：scope 模块只用到 get/set/remove。 */
class MemoryStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

beforeEach(() => {
  (globalThis as unknown as { window: unknown }).window = { sessionStorage: new MemoryStorage() };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('scope', () => {
  it('未存储时回落到默认作用域（平台租户）', () => {
    const scope = resolveScope();
    expect(scope.tenantId).toBe(PLATFORM_TENANT_ID);
    expect(scope.appId).toBe('');
  });

  it('保存后可读回，且首尾空白被裁掉', () => {
    saveScope({ tenantId: ' _system ', appId: ' secret-service ' });
    expect(resolveScope()).toEqual({ tenantId: SYSTEM_TENANT, appId: 'secret-service' });
  });

  it('存储损坏时回落默认', () => {
    const storage = (globalThis as unknown as { window: { sessionStorage: MemoryStorage } }).window.sessionStorage;
    storage.setItem('secret-center:scope:v1', '{not json');
    expect(resolveScope().tenantId).toBe(PLATFORM_TENANT_ID);
  });

  it('清除后回到默认', () => {
    saveScope({ tenantId: SYSTEM_TENANT, appId: 'svc' });
    clearScope();
    expect(resolveScope().tenantId).toBe(PLATFORM_TENANT_ID);
  });

  it('defaultScope 在演示会话下是平台租户', () => {
    expect(defaultScope().tenantId).toBe(PLATFORM_TENANT_ID);
  });
});
