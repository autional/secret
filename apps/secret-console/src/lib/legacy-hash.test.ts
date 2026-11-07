import { describe, expect, it } from 'vitest';
import { legacyHashToPath } from './legacy-hash';

describe('legacyHashToPath', () => {
  it('概览', () => {
    expect(legacyHashToPath('#/')).toBeNull();
  });

  it('密钥（含深链 query）', () => {
    expect(legacyHashToPath('#/secrets')).toBe('/secrets');
    expect(legacyHashToPath('#/secrets?key=jwt%2Fsigning%2Fprimary')).toBe('/secrets?key=jwt%2Fsigning%2Fprimary');
  });

  it('审计', () => {
    expect(legacyHashToPath('#/audit')).toBe('/audit');
  });

  it('未知 hash 原样返回 null，不猜', () => {
    expect(legacyHashToPath('')).toBeNull();
    expect(legacyHashToPath('#/unknown')).toBeNull();
  });
});
