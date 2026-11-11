import { defineConfig } from '@playwright/test';

/**
 * 认证流程 e2e（真浏览器 + 假 OIDC 提供方，无需真实账号）。
 *
 * 为什么单开一份配置：mock 冒烟（`playwright.config.ts`）跑的是 mock 会话，
 * 永远碰不到 PKCE / state / nonce / 换票。这里用 `e2e/support/fake-oidc.mjs`
 * 起一个本地 IdP，把**真实授权码流程**跑一遍。
 *
 * 端口与配置中心错开（config: 13923/13930 → secret: 13924/13931），两站可并行跑。
 */
export default defineConfig({
	testDir: './e2e',
	testMatch: /auth-oidc\.spec\.ts/,
	timeout: 60_000,
	expect: { timeout: 15_000 },
	fullyParallel: false, // 假的 IdP 有授权码状态，串行更稳
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [['github'], ['list']] : 'list',
	use: {
		baseURL: 'http://127.0.0.1:13924',
		...(process.env.CI ? {} : { channel: 'chrome' }),
		trace: 'retain-on-failure',
	},
	webServer: [
		{
			command: 'node e2e/support/fake-oidc.mjs',
			url: 'http://127.0.0.1:13931/health',
			reuseExistingServer: !process.env.CI,
			timeout: 30_000,
		},
		{
			command: 'pnpm exec vite --host 127.0.0.1 --port 13924 --strictPort --mode authe2e',
			url: 'http://127.0.0.1:13924',
			reuseExistingServer: !process.env.CI,
			timeout: 120_000,
		},
	],
});
