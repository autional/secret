import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // .env* 仍放在仓库根
  envDir: fileURLToPath(new URL('../../', import.meta.url)),
  server: { port: 13122 },
  preview: { port: 13122 },
  /**
   * 不做 manualChunks 按依赖拆包：2026-11-07 config 线上事故（commit 44305da）
   * —— antd / rc-* / react 拆成独立 chunk 后触发跨 chunk 循环初始化
   * （`antd-*.js` ReferenceError: Cannot access 'Pd' before initialization → 整页白屏）。
   * 首屏优化另立方案，先保证单包可用。
   */
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
  },
});
