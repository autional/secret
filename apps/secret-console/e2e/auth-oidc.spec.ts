import { expect, test, type Page } from '@playwright/test';

/**
 * 认证流程 e2e：真浏览器 + 本地假 OIDC 提供方。
 *
 * 覆盖的是单测/契约测试碰不到的部分：授权跳转、PKCE 换票（假 IdP 会真验
 * sha256(verifier)==challenge）、state/nonce 回传、会话落盘、刷新恢复。
 *
 * 2026-11 行为变更：未登录时站点会**自动**启动登录（免点击），不再停在闸门页等用户按按钮。
 * 闸门页只在两种情况出现 ——「下一次自动跳会构成循环」（60s 内已自动跳 ≥3 次）或
 * 上一次登录出错（error 非空）。因此本文件里「未登录 → 登录页按钮可见」的旧断言
 * 已改为「未登录 → 自动跳转授权端点」，另加一条「循环保护 ⇒ 回落闸门页 + 手动可恢复」。
 */

const SESSION_KEY = 'secret-center:auth:v2';
const AUTO_LOGIN_KEY = 'secret-console:auto-login:v1';
const IDP_AUTHORIZE = 'http://127.0.0.1:13931/authorize';

/** 登录闸门的唯一按钮（品牌名 + 登录动作）。自动跳生效时页面上没有它。 */
const gateButton = (page: Page) => page.getByRole('button', { name: /Autional/ });

/** 等会话落到 localStorage（自动跳与手动点击两条路径共用）。 */
async function waitForSession(page: Page) {
	await page.waitForFunction((key) => Boolean(window.localStorage.getItem(key)), SESSION_KEY, {
		timeout: 30_000,
	});
}

/** 登录：自动跳优先；只有在闸门页留着按钮时（循环保护/错误兜底）才点它。 */
async function login(page: Page) {
	await page.goto('/');
	const gate = gateButton(page);
	// 自动跳会立刻整页离开；这里只做兜底点击，点不到就交给自动跳。
	if (await gate.isVisible().catch(() => false)) await gate.click().catch(() => {});
	await waitForSession(page);
	// 授权跳转 → 回调 /oauth/callback → 路由回首页
	await page.waitForURL((url) => url.pathname === '/' && !url.searchParams.has('code'), { timeout: 30_000 });
	await expect(gate).toBeHidden();
}

test('未登录 → 自动跳转授权端点（无需点按钮）', async ({ page }) => {
	// 记录 authorize 请求：断言「一个按钮都没点」就发出了授权请求
	const authorizeHits: string[] = [];
	page.on('request', (req) => {
		if (req.url().startsWith(IDP_AUTHORIZE)) authorizeHits.push(req.url());
	});

	await page.goto('/');
	await waitForSession(page);

	expect(authorizeHits.length, '应自动发起一次授权请求').toBeGreaterThan(0);
	// 自动跳全程不需要闸门按钮
	await expect(gateButton(page)).toBeHidden();
});

test('循环保护：60s 内已自动跳 3 次 → 回落闸门页，手动点击可恢复', async ({ page }) => {
	// 预置「刚刚已经自动跳了 3 次」的会话记录（跳转前写入的同一份键）
	await page.addInitScript((key) => {
		const now = Date.now();
		sessionStorage.setItem(key, JSON.stringify({ attempts: [now - 3_000, now - 2_000, now - 1_000] }));
	}, AUTO_LOGIN_KEY);

	const authorizeHits: string[] = [];
	page.on('request', (req) => {
		if (req.url().startsWith(IDP_AUTHORIZE)) authorizeHits.push(req.url());
	});

	await page.goto('/');

	// 停在闸门页：按钮可见（旧断言挪到这里，语义变成「循环保护兜底」）
	await expect(gateButton(page)).toBeVisible();
	expect(authorizeHits, '被循环保护抑制时不应再发起授权请求').toEqual([]);

	// 循环保护不是「永远不再跳」：用户主动点击仍可登录
	await gateButton(page).click();
	await waitForSession(page);
	await page.waitForURL((url) => url.pathname === '/' && !url.searchParams.has('code'), { timeout: 30_000 });
	await expect(gateButton(page)).toBeHidden();
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
	await expect(gateButton(page)).toBeHidden();
	const raw = await page.evaluate((key) => window.localStorage.getItem(key), SESSION_KEY);
	expect(raw).toBeTruthy();
});
