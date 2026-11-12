// a11y 专用 flat config —— 无障碍闸门铺开（2026-11-12 · 分母体系 AC C-28 / ui-denominator G5·G6）
// 与 admin-console 试点同一份口径（`pnpm lint:a11y` 必须 0 error/warn）。
//
// 为什么单独一份，而不是塞进 eslint.config.mjs：
//   1. 本仓还没有接入共享配置 `@autional/eslint-config`（此前也没有任何 eslint 配置与依赖），
//      a11y 闸门就是仓内当前唯一的 lint 入口；等共享配置发布并接入后，本文件可并入一条
//      `export default config`。
//   2. 存量 lint（no-explicit-any / no-unused-vars）噪音大；a11y 闸门要能独立回答
//      「这次有没有新增无障碍回归」，否则会被无关告警埋掉。
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config({
	files: ['**/*.{ts,tsx,js,jsx}'],
	languageOptions: {
		parser: tseslint.parser,
		parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
	},
	// react-hooks 只登记插件、不开规则：仓内历史 disable 注释引用了该插件，
	// 插件缺席时 ESLint 会把「禁用了未定义规则」直接报成 error。同时关掉
	// reportUnusedDisableDirectives：本配置不跑 react-hooks，那类 disable 在这里必然是假信号。
	linterOptions: { reportUnusedDisableDirectives: 'off' },
	plugins: { 'jsx-a11y': jsxA11y, 'react-hooks': reactHooks },
	rules: { ...jsxA11y.flatConfigs.recommended.rules },
});
