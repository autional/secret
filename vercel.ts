import { routes, type Rewrite, type VercelConfig } from '@vercel/config/v1';

/**
 * 密钥中心控制台（com / cn 双区）的 Vercel 配置。
 *
 * 与 `sites/config` / `sites/platform` 同构：`API_ORIGIN` 由 Vercel 项目环境变量注入，
 * com 项目 = https://api.autional.com，cn 项目 = https://api.autional.cn。
 * 未设置时 **fail-closed**（避免静默把 cn 流量打到 com API）。
 */
const rawOrigin = process.env.API_ORIGIN;

if (!rawOrigin) {
  throw new Error('[secret] 缺少环境变量 API_ORIGIN（Vercel 项目设置里配置后重新部署）');
}

const ORIGIN = rawOrigin.replace(/\/+$/, '');

/** 安全响应头（与其它门户一致的最小集）。CSP 允许 antd 的内联样式；API 走同源 /bff。 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https://api.autional.com https://api.autional.cn",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  'upgrade-insecure-requests',
].join('; ');

const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: CSP },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'geolocation=(), microphone=(), camera=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
];

const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'public, max-age=0, must-revalidate';
const HTML_CACHE_HEADERS = [
  { key: 'Cache-Control', value: NO_CACHE },
  // 防止 Vercel Edge 长时间缓存旧 index.html（旧 HTML 会引用已删除的旧 bundle → 404/白屏）。
  { key: 'CDN-Cache-Control', value: 'no-store' },
  { key: 'Vercel-CDN-Cache-Control', value: 'no-store' },
];

const spaFallback: Rewrite = {
  source: '/(.*)',
  destination: '/index.html',
  has: [{ type: 'header', key: 'accept', value: { re: 'text/html' } }],
};

export const config: VercelConfig = {
  framework: 'vite',
  installCommand: 'pnpm install --frozen-lockfile',
  buildCommand: 'pnpm --filter @autional/secret-console build',
  outputDirectory: 'apps/secret-console/dist',
  headers: [
    routes.header('/(.*)', SECURITY_HEADERS),
    routes.header('/assets/(.*)', [{ key: 'Cache-Control', value: IMMUTABLE }]),
    routes.header('/', HTML_CACHE_HEADERS),
    routes.header('/index.html', HTML_CACHE_HEADERS),
    routes.header('/secrets', HTML_CACHE_HEADERS),
    routes.header('/audit', HTML_CACHE_HEADERS),
    routes.header('/oauth/callback', HTML_CACHE_HEADERS),
  ],
  rewrites: [
    routes.rewrite('/bff/:path*', `${ORIGIN}/bff/:path*`),
    routes.rewrite('/oauth/callback', '/index.html'),
    spaFallback,
  ],
};
