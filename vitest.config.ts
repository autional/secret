import { defineConfig } from 'vitest/config';

/**
 * 纯逻辑单测（lib/ 下的纯函数：命名空间推导 / 门户 URL / 作用域存储）。
 * 环境用 `node`：被测模块不触碰 DOM（config.ts 已对 `window` 缺失做兜底）。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    reporters: 'default',
  },
});
