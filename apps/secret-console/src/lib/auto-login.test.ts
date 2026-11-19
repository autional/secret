import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUTO_LOGIN_MAX_ATTEMPTS,
  AUTO_LOGIN_STORAGE_KEY,
  AUTO_LOGIN_WINDOW_MS,
  autoLoginAttemptedInThisDocument,
  countRecentAttempts,
  decideAutoLogin,
  markAutoLoginAttemptedInThisDocument,
  readAutoLoginRecord,
  recordAutoJump,
  resetAutoLoginDocumentFlag,
  resetAutoLoginRecord,
  type StorageLike,
} from './auto-login';

/** 内存版 sessionStorage（node 环境没有 sessionStorage）。 */
function memoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
  };
}

const NOW = 1_700_000_000_000;

/** 只要「该跳」的基准输入，各用例按需覆盖。 */
function signals(overrides: Partial<Parameters<typeof decideAutoLogin>[0]> = {}) {
  return decideAutoLogin({
    ready: true,
    needsLogin: true,
    alreadyJumpedThisPage: false,
    attempts: [],
    now: NOW,
    ...overrides,
  });
}

describe('decideAutoLogin', () => {
  it('a) 已就绪 + 需要登录 + 未跳过 ⇒ 自动跳', () => {
    expect(signals()).toEqual({ jump: true, reason: 'ok' });
  });

  it('b) 加载中（ready=false）⇒ 不跳', () => {
    expect(signals({ ready: false })).toEqual({ jump: false, reason: 'not-ready' });
  });

  it('c) 本页已自动跳过（标记在）⇒ 不跳', () => {
    expect(signals({ alreadyJumpedThisPage: true })).toEqual({ jump: false, reason: 'already-jumped' });
  });

  it('d) 60s 内已自动跳 3 次 ⇒ 不跳（循环保护）', () => {
    const attempts = [NOW - 30_000, NOW - 20_000, NOW - 1_000];
    expect(signals({ attempts })).toEqual({ jump: false, reason: 'loop-guard' });
  });

  it('不需要登录（REQUIRE_AUTH=0 且 mock 数据）⇒ 不跳', () => {
    expect(signals({ needsLogin: false })).toEqual({ jump: false, reason: 'no-need' });
  });

  it('上一次登录失败/被拒（error 非空）⇒ 不跳，把错误与按钮交给用户', () => {
    expect(signals({ lastError: 'access_denied' })).toEqual({ jump: false, reason: 'error' });
    expect(signals({ lastError: '   ' }).jump).toBe(true);
  });

  it('窗口外的旧记录不计入：仅 1 次在窗口内 ⇒ 仍跳（不是「一次就永久停」）', () => {
    const attempts = [NOW - AUTO_LOGIN_WINDOW_MS - 5_000, NOW - 2_000];
    expect(countRecentAttempts(attempts, NOW)).toBe(1);
    expect(signals({ attempts })).toEqual({ jump: true, reason: 'ok' });
  });

  it('恰好 2 次在窗口内 ⇒ 仍跳（阈值是 ≥3）', () => {
    const attempts = [NOW - 10_000, NOW - 5_000];
    expect(signals({ attempts })).toEqual({ jump: true, reason: 'ok' });
  });

  it('临界：第 3 次刚发生（窗口内 3 次）⇒ 停；窗口滑过后恢复', () => {
    const attempts = [NOW - 5_000, NOW - 3_000, NOW - 1_000];
    expect(signals({ attempts })).toEqual({ jump: false, reason: 'loop-guard' });
    // 时间推进 61s：三条记录全部滑出窗口 → 自动跳恢复
    expect(signals({ attempts, now: NOW + AUTO_LOGIN_WINDOW_MS + 1 }).jump).toBe(true);
  });

  it('阈值常量与文档一致', () => {
    expect(AUTO_LOGIN_MAX_ATTEMPTS).toBe(3);
    expect(AUTO_LOGIN_WINDOW_MS).toBe(60_000);
  });
});

describe('滑动窗口记录（sessionStorage）', () => {
  let store: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    store = memoryStorage();
    resetAutoLoginDocumentFlag();
  });

  it('recordAutoJump 追加时间戳并落盘', () => {
    recordAutoJump(NOW, store);
    // 跳转前写入：调用返回时 sessionStorage 里已有记录
    expect(store.getItem(AUTO_LOGIN_STORAGE_KEY)).toContain(String(NOW));
    expect(readAutoLoginRecord(store).attempts).toEqual([NOW]);
  });

  it('超过窗口的旧记录在写入时被剪枝', () => {
    recordAutoJump(NOW - AUTO_LOGIN_WINDOW_MS - 1, store);
    recordAutoJump(NOW, store);
    expect(readAutoLoginRecord(store).attempts).toEqual([NOW]);
  });

  it('连续跳 3 次后判定为 loop-guard；决定函数与记录联动', () => {
    recordAutoJump(NOW - 3_000, store);
    recordAutoJump(NOW - 2_000, store);
    recordAutoJump(NOW - 1_000, store);
    const decision = decideAutoLogin({
      ready: true,
      needsLogin: true,
      alreadyJumpedThisPage: false,
      attempts: readAutoLoginRecord(store).attempts,
      now: NOW,
    });
    expect(decision).toEqual({ jump: false, reason: 'loop-guard' });
  });

  it('损坏的 JSON 当空记录处理（不会永久挡人）', () => {
    store.setItem(AUTO_LOGIN_STORAGE_KEY, '{not json');
    expect(readAutoLoginRecord(store).attempts).toEqual([]);
    store.setItem(AUTO_LOGIN_STORAGE_KEY, JSON.stringify({ attempts: ['x', null, true, NOW] }));
    expect(readAutoLoginRecord(store).attempts).toEqual([NOW]);
  });

  it('resetAutoLoginRecord 清空', () => {
    recordAutoJump(NOW, store);
    resetAutoLoginRecord(store);
    expect(readAutoLoginRecord(store).attempts).toEqual([]);
  });

  it('storage 不可用（null）时退化为无记录，不抛错', () => {
    expect(readAutoLoginRecord(null).attempts).toEqual([]);
    expect(() => recordAutoJump(NOW, null)).not.toThrow();
    expect(() => resetAutoLoginRecord(null)).not.toThrow();
  });

  it('本页幂等标记（自动跳与手动点击共用）：默认 false，标记后 true，重置回 false', () => {
    expect(autoLoginAttemptedInThisDocument()).toBe(false);
    markAutoLoginAttemptedInThisDocument();
    expect(autoLoginAttemptedInThisDocument()).toBe(true);
    resetAutoLoginDocumentFlag();
    expect(autoLoginAttemptedInThisDocument()).toBe(false);
  });
});
