import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 认证**流程契约**（配置中心与密钥中心共用同一份用例，仅 PROFILE 不同）。
 *
 * 为什么要有它：两站的 `lib/auth.ts` 是同一套 OIDC PKCE 流程的两份实现。
 * 已统一的只有纯函数（jwt / pkce / claims 映射），流程仍各写一遍。
 * 这份用例把「两站都必须遵守的行为」写成**字面量断言**：
 *   - 任何人改了一站的流程，那一站的 CI 立刻红（而不是等线上掉登录才发现）；
 *   - 断言值故意不写成变量，避免「改常量顺手把断言也改了」。
 *
 * 站点差异（存储位置、revoke、瞬时故障延长）不写进共同契约，只在注释里标注。
 */

// ── PROFILE：仅此处两站不同 ───────────────────────────────────────────────
const PROFILE = {
	/** 会话落盘的 key */
	sessionKey: 'secret-center:auth:v2',
	/** PKCE 上下文的 key */
	pkceKey: 'secret-center:pkce:v1',
	/** 会话与 PKCE 落在哪个 storage（config=session，secret=local） */
	storage: 'local' as 'local' | 'session',
};
// ─────────────────────────────────────────────────────────────────────────

type MemStorage = {
	getItem: (key: string) => string | null;
	setItem: (key: string, value: string) => void;
	removeItem: (key: string) => void;
	clear: () => void;
};

function memoryStorage(): MemStorage {
	const map = new Map<string, string>();
	return {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => void map.set(key, String(value)),
		removeItem: (key: string) => void map.delete(key),
		clear: () => map.clear(),
	};
}

/** 造一个 payload 可解的最小 JWT（不验签，只取声明）。 */
function jwt(payload: Record<string, unknown>): string {
	const b64 = (obj: unknown) =>
		Buffer.from(JSON.stringify(obj))
			.toString('base64')
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
	return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

/** 当前用例实际生效的那个 storage（按 PROFILE 选）。 */
let store: MemStorage;

function installWindow() {
	const local = memoryStorage();
	const session = memoryStorage();
	vi.stubGlobal('window', {
		localStorage: local,
		sessionStorage: session,
		location: { origin: 'https://secret.autional.cn', search: '' },
		setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
		clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
	});
	store = PROFILE.storage === 'local' ? local : session;
	return { local, session };
}

function seedSession(overrides: Record<string, unknown> = {}) {
	store.setItem(
		PROFILE.sessionKey,
		JSON.stringify({
			mode: 'oidc',
			accessToken: 'access-token',
			refreshToken: 'refresh-token',
			expiresAt: Date.now() + 3_600_000,
			user: { sub: 'u1', name: 'QA', email: 'qa@example.com', tenantId: 't1', appId: '', roles: ['super_admin'] },
			...overrides,
		}),
	);
}

function seedPkce(state = 's-1', nonce = 'n-1') {
	store.setItem(
		PROFILE.pkceKey,
		JSON.stringify({ verifier: 'v', state, nonce, redirectUri: 'https://x/oauth/callback', at: Date.now() }),
	);
}

function tokenResponse(extra: Record<string, unknown> = {}) {
	return new Response(
		JSON.stringify({
			access_token: jwt({ sub: 'u1', exp: 1_900_000_000, tenant_id: 't1', roles: ['super_admin'] }),
			refresh_token: 'rotated-refresh',
			id_token: jwt({ sub: 'u1', name: '来自 id_token', email: 'qa@example.com', nonce: 'n-1', exp: 1_900_000_000 }),
			token_type: 'Bearer',
			expires_in: 3600,
			...extra,
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } },
	);
}

function jsonError(status: number, body: Record<string, unknown>) {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('auth 流程契约（两站共用）', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.stubEnv('VITE_AUTH_MODE', 'oidc');
		vi.stubEnv('VITE_OIDC_CLIENT_ID', 'test-client');
	});

	describe('completeLogin', () => {
		it('state 不匹配 → 抛错且不落会话', async () => {
			installWindow();
			seedPkce('expected', 'n-1');
			vi.stubGlobal('fetch', vi.fn(async () => tokenResponse()));

			const { completeLogin } = await import('./auth');
			await expect(completeLogin('?code=c&state=other')).rejects.toThrow(/state/);
			expect(store.getItem(PROFILE.sessionKey)).toBeNull();
		});

		it('缺 code → 抛错', async () => {
			installWindow();
			const { completeLogin } = await import('./auth');
			await expect(completeLogin('?state=s')).rejects.toThrow(/code/);
		});

		it('授权端点回 error → 抛错并带错误码', async () => {
			installWindow();
			const { completeLogin } = await import('./auth');
			await expect(completeLogin('?error=access_denied&error_description=nope')).rejects.toThrow(/access_denied/);
		});

		it('nonce 不匹配 → 抛错且清 PKCE（防重放）', async () => {
			installWindow();
			seedPkce('s-1', 'expected-nonce');
			vi.stubGlobal('fetch', vi.fn(async () => tokenResponse()));

			const { completeLogin } = await import('./auth');
			await expect(completeLogin('?code=c&state=s-1')).rejects.toThrow(/nonce/);
			expect(store.getItem(PROFILE.pkceKey)).toBeNull();
		});

		it('正常换票 → 落会话，user 来自 id_token，expiresAt = exp * 1000', async () => {
			installWindow();
			seedPkce();
			vi.stubGlobal('fetch', vi.fn(async () => tokenResponse()));

			const { completeLogin } = await import('./auth');
			const session = await completeLogin('?code=c&state=s-1');

			expect(session.mode).toBe('oidc');
			expect(session.refreshToken).toBe('rotated-refresh');
			expect(session.expiresAt).toBe(1_900_000_000 * 1000);
			expect(session.user.name).toBe('来自 id_token');
			expect(session.user.tenantId).toBe('t1');
			expect(session.user.roles).toEqual(['super_admin']);
			expect(store.getItem(PROFILE.sessionKey)).not.toBeNull();
			expect(store.getItem(PROFILE.pkceKey)).toBeNull();
		});
	});

	describe('refreshSession', () => {
		it('并发续期只发一次令牌请求（单飞）', async () => {
			installWindow();
			seedSession();
			const fetchMock = vi.fn(async () => tokenResponse());
			vi.stubGlobal('fetch', fetchMock);

			const { refreshSession } = await import('./auth');
			const [a, b] = await Promise.all([refreshSession(), refreshSession()]);

			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(a?.refreshToken).toBe('rotated-refresh');
			expect(b?.refreshToken).toBe('rotated-refresh');
		});

		it('4xx（invalid_grant）→ 返回 null 并清会话', async () => {
			installWindow();
			seedSession();
			vi.stubGlobal('fetch', vi.fn(async () => jsonError(400, { error: 'invalid_grant' })));

			const { refreshSession } = await import('./auth');
			await expect(refreshSession()).resolves.toBeNull();
			expect(store.getItem(PROFILE.sessionKey)).toBeNull();
		});

		it('5xx（网关瞬时故障）→ 不抛错，且**不清**会话', async () => {
			installWindow();
			seedSession();
			vi.stubGlobal('fetch', vi.fn(async () => jsonError(502, { error: 'bad_gateway' })));

			const { refreshSession } = await import('./auth');
			await expect(refreshSession()).resolves.toBeDefined();
			expect(store.getItem(PROFILE.sessionKey)).not.toBeNull();
		});

		it('没有 refresh_token → 返回 null 并清会话', async () => {
			installWindow();
			seedSession({ refreshToken: undefined });
			vi.stubGlobal('fetch', vi.fn());

			const { refreshSession } = await import('./auth');
			await expect(refreshSession()).resolves.toBeNull();
			expect(store.getItem(PROFILE.sessionKey)).toBeNull();
		});
	});

	describe('currentSession', () => {
		it('无会话 → null', async () => {
			installWindow();
			const { currentSession } = await import('./auth');
			expect(currentSession()).toBeNull();
		});

		it('剩余有效期 < 60s → 视为过期返回 null（避免请求途中失效）', async () => {
			installWindow();
			seedSession({ accessToken: jwt({ sub: 'u1', exp: Math.floor((Date.now() + 30_000) / 1000) }) });
			const { currentSession } = await import('./auth');
			expect(currentSession()).toBeNull();
		});

		it('未过期 → 返回会话', async () => {
			installWindow();
			seedSession();
			const { currentSession } = await import('./auth');
			expect(currentSession()?.refreshToken).toBe('refresh-token');
		});
	});

	it('signOut → 清会话（是否 revoke 属站点差异，不在本契约）', async () => {
		installWindow();
		seedSession();
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

		const { signOut } = await import('./auth');
		await signOut();
		expect(store.getItem(PROFILE.sessionKey)).toBeNull();
	});

	it('mock 模式：signOut 后 currentSession 为 null（不自动回填演示会话）', async () => {
		vi.stubEnv('VITE_AUTH_MODE', 'mock');
		installWindow();
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

		const { currentSession, signOut } = await import('./auth');
		expect(currentSession()?.mode).toBe('mock');
		await signOut();
		expect(currentSession()).toBeNull();
	});
});
