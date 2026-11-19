/**
 * 未登录时**自动**启动登录（免点击）的判定与限流。
 *
 * 背景：闸门页要求用户点一下按钮才跳授权端点，首访多一步；但「无脑自动跳」会带来
 * 更糟的问题 —— 授权端点配错 / client 未登记 / 用户拒绝授权时，站点会「跳出去、
 * 弹回来、还是没登录、再跳出去」，形成浏览器不可见的 JS 跳转循环。
 *
 * 因此这里借鉴 auth 站 `requireauth-loop-guard.ts` 的同一思路，做**两层**防护：
 *
 *   1. **本页幂等**：同一份文档（一次页面加载）内只自动跳一次 ——
 *      React StrictMode 二次挂载 / 重渲染 / effect 重跑都不会重复跳；
 *   2. **滑动窗口**：`sessionStorage` 记最近若干次自动跳转的时间戳，60 秒内已跳
 *      ≥3 次即判定为循环，**停止自动跳并回落闸门页**（保留手动按钮），只 warn 一次。
 *      记录写在 `sessionStorage`（跳转**前**写入），所以刷新不会把计数清零 ——
 *      这就是「刷新后不会无限重跳」的来源。
 *
 * 与 auth 站实现的差异（有意）：用**滑动窗口**而非固定时间桶。固定桶在边界上有
 * 假通过（59.9s 跳一次、60.1s 立刻再跳），滑动窗口没有这个缝。
 *
 * 手动点击**不受限**：它是用户主动动作，也是循环保护生效后的恢复路径 ——
 * 所以「保护」不是「永远只跳一次」，冷却 60 秒或用户点击即可恢复。
 */

/** sessionStorage 键（值 = `{ attempts: number[] }`）。 */
export const AUTO_LOGIN_STORAGE_KEY = 'secret-console:auto-login:v1';

/** 循环保护的统计窗口。 */
export const AUTO_LOGIN_WINDOW_MS = 60_000;

/** 窗口内允许的自动跳转次数上限；第 4 次起停止自动跳。 */
export const AUTO_LOGIN_MAX_ATTEMPTS = 3;

export type AutoLoginReason = 'ok' | 'no-need' | 'not-ready' | 'already-jumped' | 'loop-guard' | 'error';

export interface AutoLoginDecision {
  /** true = 本次应当自动启动登录。 */
  jump: boolean;
  /** 判定依据（用于日志与单测断言；生产只在 loop-guard 时打 warn）。 */
  reason: AutoLoginReason;
}

export interface AutoLoginSignals {
  /** 会话引导是否已完成（加载中一律不跳：还不知道到底要不要登录）。 */
  ready: boolean;
  /** 是否处于「必须登录才能用」的状态。 */
  needsLogin: boolean;
  /** 本次文档加载内是否已经自动跳过（幂等标记）。 */
  alreadyJumpedThisPage: boolean;
  /** 历史自动跳转时间戳（毫秒）。 */
  attempts: number[];
  /** 上一次登录失败/被拒的错误文案；非空 ⇒ 不再自动跳（错误要交给用户看）。 */
  lastError?: string;
  /** 当前时间（毫秒），显式传入便于测试。 */
  now: number;
}

/** sessionStorage 的最小接口（便于在 node 单测里注入内存实现）。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AutoLoginRecord {
  /** 时间戳（毫秒），无需消费者关心是否已剪枝。 */
  attempts: number[];
}

/** 时间戳是否落在窗口内；非有限数字一律丢弃（损坏值不应导致永久放行或永久封禁）。 */
function inWindow(ts: unknown, now: number): ts is number {
  return typeof ts === 'number' && Number.isFinite(ts) && ts > 0 && now - ts < AUTO_LOGIN_WINDOW_MS;
}

/** 只保留窗口内的记录（滑动窗口剪枝）。 */
export function pruneAttempts(attempts: readonly unknown[], now: number): number[] {
  return attempts.filter((ts): ts is number => inWindow(ts, now));
}

/** 窗口内的自动跳转次数。 */
export function countRecentAttempts(attempts: readonly unknown[], now: number): number {
  return pruneAttempts(attempts, now).length;
}

/**
 * 是否应当自动启动登录（纯函数，无 IO）。
 *
 * | ready | needsLogin | alreadyJumped | 窗口内次数 | 结果 |
 * |-------|------------|---------------|-----------|------|
 * | any   | false      | any           | any       | no-need |
 * | false | true       | any           | any       | not-ready |
 * | true  | true       | any           | any       | error（`lastError` 非空） |
 * | true  | true       | true          | any       | already-jumped |
 * | true  | true       | false         | >= 3      | loop-guard |
 * | true  | true       | false         | < 3       | ok（跳） |
 */
export function decideAutoLogin(signals: AutoLoginSignals): AutoLoginDecision {
  if (!signals.needsLogin) return { jump: false, reason: 'no-need' };
  if (!signals.ready) return { jump: false, reason: 'not-ready' };
  if ((signals.lastError ?? '').trim() !== '') return { jump: false, reason: 'error' };
  if (signals.alreadyJumpedThisPage) return { jump: false, reason: 'already-jumped' };
  if (countRecentAttempts(signals.attempts, signals.now) >= AUTO_LOGIN_MAX_ATTEMPTS) {
    return { jump: false, reason: 'loop-guard' };
  }
  return { jump: true, reason: 'ok' };
}

/** 浏览器端 sessionStorage；不可用（隐私模式 / 配额 / node 单测）时返回 null。 */
export function autoLoginStore(): StorageLike | null {
  try {
    if (typeof sessionStorage === 'undefined' || !sessionStorage) return null;
    return sessionStorage;
  } catch {
    return null;
  }
}

/** 读记录（损坏值一律当空记录，绝不让坏 JSON 把用户永久挡在门外）。 */
export function readAutoLoginRecord(store: StorageLike | null = autoLoginStore()): AutoLoginRecord {
  if (!store) return { attempts: [] };
  try {
    const raw = store.getItem(AUTO_LOGIN_STORAGE_KEY);
    if (!raw) return { attempts: [] };
    const parsed = JSON.parse(raw) as { attempts?: unknown } | null;
    if (!parsed || !Array.isArray(parsed.attempts)) return { attempts: [] };
    return { attempts: parsed.attempts.filter((ts): ts is number => typeof ts === 'number' && Number.isFinite(ts)) };
  } catch {
    return { attempts: [] };
  }
}

/**
 * 记一次自动跳转 —— **必须在真正跳转之前调用**（跳转后本页 JS 可能再也不执行）。
 * 返回写入后的记录（已剪枝）。
 */
export function recordAutoJump(now: number = Date.now(), store: StorageLike | null = autoLoginStore()): AutoLoginRecord {
  const attempts = [...pruneAttempts(readAutoLoginRecord(store).attempts, now), now];
  if (store) {
    try {
      store.setItem(AUTO_LOGIN_STORAGE_KEY, JSON.stringify({ attempts }));
    } catch {
      /* 写失败不影响本次跳转：最坏情况退化为「无循环保护」 */
    }
  }
  return { attempts };
}

/** 清空记录（登出/排障用；正常情况下靠窗口自然过期即可）。 */
export function resetAutoLoginRecord(store: StorageLike | null = autoLoginStore()): void {
  if (!store) return;
  try {
    store.removeItem(AUTO_LOGIN_STORAGE_KEY);
  } catch {
    /* 忽略 */
  }
}

/**
 * 「本次文档加载内已发起过登录跳转」标记：模块级内存变量。
 *
 * 自动跳与手动点击都会打这个标记（两者都是「已经交给 IdP 了」）：
 *   - 自动跳：同一份文档只自动跳一次；
 *   - 手动点击：避免点了之后 `error` 被清空 → 判定重新变「该跳」而再跳一次（双开 PKCE）。
 *
 * 为什么不用 sessionStorage：这份标记代表的正是「这一次页面加载」，刷新后应当
 * 重新评估（否则用户被一次失败永远困在闸门页）；跨页面的循环由滑动窗口兜底。
 */
let attemptedInThisDocument = false;

export function autoLoginAttemptedInThisDocument(): boolean {
  return attemptedInThisDocument;
}

export function markAutoLoginAttemptedInThisDocument(): void {
  attemptedInThisDocument = true;
}

/** 仅供测试/热更新重置。 */
export function resetAutoLoginDocumentFlag(): void {
  attemptedInThisDocument = false;
}
