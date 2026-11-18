import { describe, expect, it } from 'vitest';
import { changeReasonOf, isAuditSuccess } from './audit';

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

// 服务端口径（shared/service-audit/.../audit_repository.go `statusClassOr`）：
// success = status ∈ {0} ∪ [200,300)；failure = status ∈ {1} ∪ [400,∞)。
describe('isAuditSuccess', () => {
  it('业务成功码 0 判定为成功（旧实现按 HTTP 语义会误判为失败）', () => {
    expect(isAuditSuccess(0)).toBe(true);
  });

  it('业务失败码 1 判定为失败', () => {
    expect(isAuditSuccess(1)).toBe(false);
  });

  it('无状态（null / undefined）视为成功（老事件无状态码）', () => {
    expect(isAuditSuccess(null)).toBe(true);
    expect(isAuditSuccess(undefined)).toBe(true);
  });

  it('兼容旧 HTTP 码：仅 2xx 成功（左闭右开）', () => {
    expect(isAuditSuccess(200)).toBe(true);
    expect(isAuditSuccess(299)).toBe(true);
    expect(isAuditSuccess(300)).toBe(false);
  });

  it('HTTP 错误码判定为失败', () => {
    expect(isAuditSuccess(404)).toBe(false);
    expect(isAuditSuccess(500)).toBe(false);
  });
});
