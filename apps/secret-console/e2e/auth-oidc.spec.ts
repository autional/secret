import { expect, test, type Page } from '@playwright/test';

/**
 * 认证流程 e2e：真浏览器 + 本地假 OIDC 提供方。
 *
 * 覆盖的是单测/契约测试碰不到的部分：授权跳转、PKCE 换票（假 IdP 会真验
 * sha256(verifier)==challenge）、state/nonce 回传、会话落盘、刷新恢复。
 */

const SESSION_KEY = 'secret-center:auth:v2';

/** 点登录 → 等回调完成 → 断言已进入控制台。 */
async function login(page: Page) {
	await page.goto('/');
	await page.getByRole('button', { name: /Autional/ }).click();
	// 授权跳转 → 回调 /oauth/callback → 路由回首页
	await page.waitForURL((url) => url.pathname === '/' && !url.searchParams.has('code'), { timeout: 30_000 });
	await expect(page.getByRole('button', { name: /Autional/ })).toBeHidden();
}

test('未登录 → 登录页', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('button', { name: /Autional/ })).toBeVisible();
});

test('授权码 + PKCE 全流程 → 进入控制台，会话字段正确', async ({ page }) => {
	// 只收「真错误」：未捕获异常 + 非资源加载失败的控制台错误。
	// 说明：本地没有后端，门户可见性会请求 /bff/.../applications 并 404 —— 那是
	// Wave 2「数据优先、注册表回落」的预期路径（回落成功），不是失败。
	const errors: string[] = [];
	page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
	page.on('console', (msg) => {
		if (msg.type() !== 'error') return;
		if (/Failed to load resource/i.test(msg.text())) return;
		errors.push(msg.text());
	});

	await login(page);

	const raw = await page.evaluate((key) => window.localStorage.getItem(key), SESSION_KEY);
	expect(raw, '会话应落在 localStorage').toBeTruthy();
	const session = JSON.parse(raw as string);

	expect(session.mode).toBe('oidc');
	// 假 IdP 的 id_token 只给 name/email，tenant_id 在 access_token 里 ——
	// 这里同时验证了「合并两份令牌声明」，否则 tenantId 会是空串。
	expect(session.user.tenantId).toBe('t-oidc');
	expect(session.user.roles).toEqual(['super_admin']);
	expect(session.user.name).toBe('守门测试账号');
	expect(session.refreshToken).toMatch(/^refresh-/);
	expect(session.expiresAt).toBeGreaterThan(Date.now() + 10 * 60_000);

	// 回调里的 code/state 必须被清掉（防刷新重放授权码）
	expect(new URL(page.url()).search).toBe('');
	expect(errors, errors.join(' | ')).toEqual([]);
});

test('刷新页面仍保持登录（restoreSession）', async ({ page }) => {
	await login(page);
	await page.reload();
	await expect(page.getByRole('button', { name: /Autional/ })).toBeHidden();
	const raw = await page.evaluate((key) => window.localStorage.getItem(key), SESSION_KEY);
	expect(raw).toBeTruthy();
});
