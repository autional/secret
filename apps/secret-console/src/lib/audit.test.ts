import { describe, expect, it } from 'vitest';
import { auditResultDisplay, auditStatusKind, changeReasonOf, isAuditSuccess, isSystemOperator } from './audit';
import zhCN from '../i18n/locales/zh-CN.json';
import enUS from '../i18n/locales/en-US.json';

describe('changeReasonOf', () => {
  it('读取 metadata.change_reason 并去除首尾空白', () => {
    expect(changeReasonOf({ metadata: { change_reason: '  季度轮换  ', other: 'x' } })).toBe('季度轮换');
  });

  it('缺失 / 空值 / 非字符串结构时返回空串（表格渲染成 —）', () => {
    expect(changeReasonOf(undefined)).toBe('');
    expect(changeReasonOf(null)).toBe('');
    expect(changeReasonOf({})).toBe('');
    expect(changeReasonOf({ metadata: { change_reason: '   ' } })).toBe('');
    expect(changeReasonOf({ metadata: { change_reason: { nested: true } } })).toBe('');
    expect(changeReasonOf({ metadata: { change_reason: null } })).toBe('');
  });

  it('容错数字等标量（后端 fmt.Sprint 归一化前的历史数据）', () => {
    expect(changeReasonOf({ metadata: { change_reason: 0 } })).toBe('0');
    expect(changeReasonOf({ metadata: { change_reason: false } })).toBe('false');
  });
});

// 三态口径，与 admin-console 回归锁 A-197（__tests__/audit-logs-status.test.tsx）逐字一致：
// success = status ∈ {0} ∪ [200,300)；failure = status ∈ {1} ∪ [400,∞)；
// 其余（2..199、3xx 等）→ raw，视图原样展示数字，不猜语义。
describe('auditStatusKind', () => {
  it('无状态（null / undefined）视为成功（老事件 / 非请求类事件没有状态码）', () => {
    expect(auditStatusKind(null)).toBe('success');
    expect(auditStatusKind(undefined)).toBe('success');
  });

  it('事件管道：0=成功、1=失败', () => {
    expect(auditStatusKind(0)).toBe('success');
    expect(auditStatusKind(1)).toBe('failure');
  });

  it('请求管道：2xx 成功（左闭右开）', () => {
    expect(auditStatusKind(200)).toBe('success');
    expect(auditStatusKind(299)).toBe('success');
  });

  it('请求管道：>=400 失败', () => {
    expect(auditStatusKind(400)).toBe('failure');
    expect(auditStatusKind(404)).toBe('failure');
    expect(auditStatusKind(500)).toBe('failure');
  });

  it('3xx 及其它未覆盖码 → raw（原样展示，不判成功也不判失败）', () => {
    expect(auditStatusKind(300)).toBe('raw');
    expect(auditStatusKind(302)).toBe('raw');
    expect(auditStatusKind(399)).toBe('raw');
  });

  it('真值表全量对齐（判别性：旧 200<=x<400 实现会把 0 判失败、302 判成功）', () => {
    const table: Array<[number | null | undefined, 'success' | 'failure' | 'raw']> = [
      [null, 'success'],
      [undefined, 'success'],
      [0, 'success'],
      [200, 'success'],
      [299, 'success'],
      [1, 'failure'],
      [302, 'raw'],
      [300, 'raw'],
      [399, 'raw'],
      [400, 'failure'],
      [404, 'failure'],
      [500, 'failure'],
    ];
    for (const [status, expected] of table) {
      expect(auditStatusKind(status), `status=${String(status)}`).toBe(expected);
    }
  });
});

describe('isAuditSuccess（兼容导出）', () => {
  it('仅 success 一态为 true，raw / failure 为 false', () => {
    expect(isAuditSuccess(null)).toBe(true);
    expect(isAuditSuccess(0)).toBe(true);
    expect(isAuditSuccess(200)).toBe(true);
    expect(isAuditSuccess(1)).toBe(false);
    expect(isAuditSuccess(302)).toBe(false);
    expect(isAuditSuccess(500)).toBe(false);
  });
});

// 结果列三态的**展示映射**回归（F3）：线上样本只有 200/400/401，
// 第 3 分支（原样显示数字）没有真实流量，只能靠这里锁住。
describe('auditResultDisplay（结果列三态展示）', () => {
  it('200 → 成功态：绿色标签 + audit.success 文案', () => {
    const display = auditResultDisplay(200);
    expect(display).toEqual({ kind: 'label', labelKey: 'audit.success' });
    expect(zhCN['audit.success']).toBe('成功');
    expect(enUS['audit.success']).toBe('OK');
  });

  it('400 / 401 → 失败态：红色标签 + audit.fail 文案', () => {
    for (const status of [400, 401]) {
      const display = auditResultDisplay(status);
      expect(display, `status=${status}`).toEqual({ kind: 'label', labelKey: 'audit.fail' });
    }
    expect(zhCN['audit.fail']).toBe('失败');
    expect(enUS['audit.fail']).toBe('Failed');
  });

  it('302 / 300 / 399 → raw：原样显示数字，不得被误判成成功或失败', () => {
    for (const status of [302, 300, 399]) {
      const display = auditResultDisplay(status);
      expect(display, `status=${status}`).toEqual({ kind: 'raw', text: String(status) });
      // 判别性：只看 kind 也会误把 raw 当 label，故同时断言不是 label 分支
      expect(display.kind, `status=${status}`).not.toBe('label');
    }
  });

  it('202 属 2xx → 成功态（口径真源 statusClassOr；不要按「非 200 即原样」实现）', () => {
    // 任务书曾假设 202 应原样展示，但服务端 statusClassOr 与 admin-console A-197 都是
    // success = {0} ∪ [200,300)，202 落在成功区间；此处锁住，避免被改成 raw。
    expect(auditResultDisplay(202)).toEqual({ kind: 'label', labelKey: 'audit.success' });
  });
});

// F2：系统事件（operator_id = 'system'）与空操作者不发用户查询，直接显示本地化「系统」。
describe('isSystemOperator', () => {
  it("'system'（含大小写/空白变体）与空值为系统操作者", () => {
    expect(isSystemOperator('system')).toBe(true);
    expect(isSystemOperator(' SYSTEM ')).toBe(true);
    expect(isSystemOperator('')).toBe(true);
    expect(isSystemOperator(undefined)).toBe(true);
    expect(isSystemOperator(null)).toBe(true);
  });

  it('真实用户 ID 不被误判（仍走批量解析）', () => {
    expect(isSystemOperator('01HZX8Q2K7V3N5M4P6R8S0T2W9')).toBe(false);
    expect(isSystemOperator('system-admin')).toBe(false);
  });
});
