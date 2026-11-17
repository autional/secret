import { describe, expect, it } from 'vitest';
import { changeReasonOf } from './audit';

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
