import { defineConfig } from '@playwright/test';

/**
 * 控制台浏览器级冒烟（mock 模式，无需登录）。
 *
 * 目的：挡住只有浏览器里才看得见的问题——路由白屏、控制台报错、中英混排、
 * 窄视口页头被挤压（这类问题单测发现不了）。
 */
export default defineConfig({
  testDir: './e2e',
  // 认证流程 e2e 需要假 OIDC 提供方，走独立配置 playwright.auth.config.ts
  testIgnore: /auth-oidc\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:13922',
    // 本机用已安装的 Chrome；CI 用 Playwright 自带 Chromium。
    ...(process.env.CI ? {} : { channel: 'chrome' }),
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'laptop', use: { viewport: { width: 1024, height: 768 } } },
  ],
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 13922 --strictPort',
    url: 'http://127.0.0.1:13922',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { VITE_DATA_MODE: 'mock', VITE_AUTH_MODE: 'mock' },
  },
});
