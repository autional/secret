/**
 * 假 OIDC 提供方（仅测试用，零依赖）。
 *
 * 为什么需要它：认证流程（PKCE / state / nonce / 换票 / 落会话）只能靠**浏览器 + 真实
 * 跳转**验证，单测和 mock 模式都碰不到。真 IdP 要求回调地址已在客户端登记，
 * 本地 dev server 过不了 redirect_uri 校验，所以用这个跑在 localhost 的假 IdP：
 *
 *   1. `/authorize` 校验 `code_challenge_method=S256` 且带 challenge，
 *      然后 302 回 `redirect_uri?code=...&state=...`（state 原样回传）；
 *   2. `/token` **真的验 PKCE**：sha256(code_verifier) 必须等于授权时的 challenge，
 *      不等就直接 400 invalid_grant —— 前端 PKCE 写错会当场红，而不是"看起来能登录"；
 *   3. `/revoke` 返回 200（登出路径要求）；
 *   4. `/health` 给 Playwright 的 webServer 探活。
 *
 * 刻意支持 CORS（`*`）：开发页在 :13923，IdP 在 :13930，令牌端点是跨域 POST。
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.FAKE_OIDC_PORT || 13931);
const ISSUER = `http://127.0.0.1:${PORT}`;

/** 授权码 → 授权时记录的上下文（一次一用）。 */
const codes = new Map();

const b64url = (buf) =>
	Buffer.from(buf)
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');

const jwt = (payload) => {
	const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
	const body = b64url(JSON.stringify(payload));
	return `${header}.${body}.sig`;
};

const now = () => Math.floor(Date.now() / 1000);

function issueTokens({ nonce }) {
	const accessToken = jwt({
		sub: 'qa-oidc-user',
		exp: now() + 3600,
		tenant_id: 't-oidc',
		roles: ['super_admin'],
	});
	const idToken = jwt({
		sub: 'qa-oidc-user',
		name: '守门测试账号',
		email: 'qa-oidc@example.test',
		tenant_id: 't-oidc',
		roles: ['super_admin'],
		nonce,
		exp: now() + 3600,
	});
	return {
		access_token: accessToken,
		refresh_token: `refresh-${randomUUID()}`,
		id_token: idToken,
		token_type: 'Bearer',
		expires_in: 3600,
		scope: 'openid profile email offline_access read',
	};
}

function cors(res) {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Headers', 'content-type, accept');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function json(res, status, body) {
	cors(res);
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
	const url = new URL(req.url ?? '/', ISSUER);

	if (req.method === 'OPTIONS') {
		cors(res);
		res.writeHead(204);
		res.end();
		return;
	}

	if (url.pathname === '/health') {
		json(res, 200, { ok: true });
		return;
	}

	if (url.pathname === '/authorize') {
		const p = url.searchParams;
		const redirectUri = p.get('redirect_uri') ?? '';
		const state = p.get('state') ?? '';
		const challenge = p.get('code_challenge') ?? '';
		const method = p.get('code_challenge_method') ?? '';

		if (p.get('response_type') !== 'code') {
			json(res, 400, { error: 'unsupported_response_type' });
			return;
		}
		if (!challenge || method !== 'S256') {
			// 前端没带 PKCE（或用了明文 method）→ 直接失败，别让"不安全的登录"看起来成功
			json(res, 400, { error: 'invalid_request', error_description: 'PKCE(S256) required' });
			return;
		}
		if (!/^https?:\/\/127\.0\.0\.1(:\d+)?\//.test(redirectUri)) {
			json(res, 400, { error: 'invalid_request', error_description: 'redirect_uri must be loopback' });
			return;
		}

		const code = `code-${randomUUID()}`;
		codes.set(code, { challenge, nonce: p.get('nonce') ?? '', redirectUri, at: Date.now() });

		const back = new URL(redirectUri);
		back.searchParams.set('code', code);
		back.searchParams.set('state', state);
		cors(res);
		res.writeHead(302, { location: back.toString() });
		res.end();
		return;
	}

	if (url.pathname === '/token' && req.method === 'POST') {
		let raw = '';
		req.on('data', (chunk) => {
			raw += chunk;
		});
		req.on('end', () => {
			const form = new URLSearchParams(raw);
			const grant = form.get('grant_type');

			if (grant === 'refresh_token') {
				if (!form.get('refresh_token')) {
					json(res, 400, { error: 'invalid_request', error_description: 'refresh_token required' });
					return;
				}
				json(res, 200, issueTokens({ nonce: '' }));
				return;
			}

			if (grant !== 'authorization_code') {
				json(res, 400, { error: 'unsupported_grant_type' });
				return;
			}

			const code = form.get('code') ?? '';
			const verifier = form.get('code_verifier') ?? '';
			const entry = codes.get(code);
			if (!entry) {
				json(res, 400, { error: 'invalid_grant', error_description: 'unknown code' });
				return;
			}
			if (form.get('redirect_uri') !== entry.redirectUri) {
				json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
				return;
			}

			// 真验 PKCE：sha256(verifier) 必须等于授权时的 challenge
			const derived = b64url(createHash('sha256').update(verifier).digest());
			if (!verifier || derived !== entry.challenge) {
				json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
				return;
			}

			codes.delete(code); // 授权码一次一用
			json(res, 200, issueTokens({ nonce: entry.nonce }));
		});
		return;
	}

	if (url.pathname === '/revoke' && req.method === 'POST') {
		req.resume();
		req.on('end', () => json(res, 200, {}));
		return;
	}

	json(res, 404, { error: 'not_found', path: url.pathname });
});

server.listen(PORT, '127.0.0.1', () => {
	process.stdout.write(`[fake-oidc] listening on ${ISSUER}\n`);
});
