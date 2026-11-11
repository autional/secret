import { expect, test } from '@playwright/test';

type Lang = 'zh-CN' | 'en-US';

/**
 * 控制台浏览器级冒烟（mock 模式，无需登录）。
 *
 * 断言三件事：路由能开、侧栏导航能点到位、**控制台无报错**。
 * 故意不断言页面标题文案——标题随 mock 数据与角色变化，断言它会假红。
 */
const ROUTES: { path: string; zh: string; en: string }[] = [
	{ path: '/', zh: "概览", en: "Overview" },
	{ path: '/secrets', zh: "密钥", en: "Secrets" },
	{ path: '/audit', zh: "审计", en: "Audit" },
];

const LANGS: Lang[] = ['zh-CN', 'en-US'];

for (const lang of LANGS) {
	test.describe(`lang=${lang}`, () => {
		for (const route of ROUTES) {
			test(`${route.path} 可访问且无控制台错误`, async ({ page }) => {
				const errors: string[] = [];
				page.on('console', (msg) => {
					if (msg.type() === 'error') errors.push(msg.text());
				});
				page.on('pageerror', (err) => errors.push(err.message));

				await page.addInitScript((value) => {
					window.localStorage.setItem('secret-console-lang', value);
				}, lang);

				await page.goto(route.path);
				const navLabel = lang === 'zh-CN' ? route.zh : route.en;
				await expect(
					page.getByRole('navigation').getByText(navLabel, { exact: false }).first(),
				).toBeVisible();
				expect(errors, errors.join(' | ')).toEqual([]);
			});
		}
	});
}
