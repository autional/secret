import { describe, expect, it } from 'vitest';
import zhCN from './locales/zh-CN.json';
import enUS from './locales/en-US.json';

const zhKeys = Object.keys(zhCN).sort();
const enKeys = Object.keys(enUS).sort();

describe('i18n 资源', () => {
  it('中英 key 集合完全一致', () => {
    expect(enKeys).toEqual(zhKeys);
  });

  it('每个 key 都有非空文案', () => {
    const empty = [...zhKeys, ...enKeys].filter(
      (key) => !String((zhCN as Record<string, string>)[key] ?? '').trim() || !String((enUS as Record<string, string>)[key] ?? '').trim(),
    );
    expect([...new Set(empty)]).toEqual([]);
  });

  it('英文资源里不应残留中文', () => {
    const cjk = enKeys.filter((key) => /[\u4e00-\u9fff]/.test(String((enUS as Record<string, string>)[key] ?? '')));
    expect(cjk).toEqual([]);
  });

  it('插值占位符两侧一致', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    const mismatched = zhKeys.filter((key) => {
      const a = placeholders(String((zhCN as Record<string, string>)[key] ?? '')).join(',');
      const b = placeholders(String((enUS as Record<string, string>)[key] ?? '')).join(',');
      return a !== b;
    });
    expect(mismatched).toEqual([]);
  });
});
