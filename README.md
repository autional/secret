# 密钥中心控制台（Secret Center）

**仓库**：`autional/secret`（尚未创建）
**域名（规划）**：[secret.autional.com](https://secret.autional.com) · [secret.autional.cn](https://secret.autional.cn)
**Vercel 双项目（规划）**：`secret`（com，`API_ORIGIN=https://api.autional.com`）· `cn-secret`（cn，`API_ORIGIN=https://api.autional.cn`），配置见 `vercel.ts`。

密钥中心控制台的**最小可构建骨架**。技术栈：Vite + React 19 + Ant Design 6 + TypeScript。

当前版本是**只读占位**：只展示密钥元数据与审计占位，不展示密钥值，也不提供创建 / 轮换 / 撤销等写入操作。

## 页面

- **概览**：占位统计（密钥总数 / 生效中 / 30 天内到期 / 待轮换）与运行状态。
- **密钥**：只读列表 + 详情抽屉（元数据、版本列表；不含密钥值）。
- **审计**：占位审计事件表。
- 顶部导航：品牌 + 概览 / 密钥 / 审计 + 「返回平台」链接。
- 登录页：`使用 Autional 账号登录`（OIDC 授权码 + PKCE）。
- 登录后顶部横幅固定显示「**密钥中心建设中**」与 **API 连通性状态**。

## 运行

```bash
npm ci            # 或 npm install
npm run dev       # http://localhost:13121
npm run build     # 产物 dist/
npm run preview
```

## 环境变量

两个正交开关：数据从哪来（`VITE_DATA_MODE`）、会话从哪来（`VITE_AUTH_MODE`）。

| 变量 | 默认 | 说明 |
|---|---|---|
| `VITE_DATA_MODE` | `mock` | `mock` = 占位数据；`api` = 调密钥服务管理面（需后端 + JWT） |
| `VITE_AUTH_MODE` | `mock` | `mock` = 演示会话；`oidc` = 授权码 + PKCE |
| `VITE_API_BASE` | `/bff/secret/api/v1/admin/secrets` | 管理面基址。默认走同源 `/bff/...`，由 `vercel.ts` 的 rewrites 代理到 `API_ORIGIN`（com/cn 各自 API，服务端代理，无 CORS） |
| `VITE_TENANT_ID` | 空 | 租户兜底（JWT 已带 `tenant_id` 时以令牌为准） |
| `VITE_APP_ID` | 空 | 应用兜底（空 = 平台应用） |
| `VITE_REQUIRE_AUTH` | 空 | `1` = 未登录先进登录页；默认放开（mock 演示可直接看） |
| `VITE_OIDC_AUTHORIZE` | `https://auth.autional.com/oauth/api/v1/oauth/authorize` | 授权端点（浏览器跳转） |
| `VITE_OIDC_TOKEN` | `https://api.autional.com/bff/oauth/api/v1/oauth/token` | 令牌端点；生产建议用同源 `/bff/oauth/api/v1/oauth/token`，由 `vercel.ts` 代理，避免 CORS |
| `VITE_OIDC_CLIENT_ID` | 空 | OAuth 客户端 ID（公开客户端，`is_confidential=false`） |
| `VITE_OIDC_REDIRECT_URI` | `${origin}/oauth/callback` | 回调地址；必须与客户端登记的 `redirect_uris` 逐字一致 |
| `VITE_OIDC_SCOPE` | `openid profile email` | 授权范围 |
| `VITE_PLATFORM_URL` | 按域名推导 | 「返回平台」链接（`platform.autional.com` / `.cn`） |

样例见 `.env.example`。

### mock 模式（默认）

```bash
npm run dev                 # 无需后端
VITE_DATA_MODE=mock npm run build
```

无需登录即可查看占位页面；不会发起真实 API 请求。

### api 模式（接真实密钥服务）

前置条件：

1. 后端已部署 `secret-service` 管理面（`shared/service-secret`），网关已配 `/bff/secret/api/v1/admin/secrets`；
2. 有一个**应用专属** OAuth 客户端（公开客户端 + PKCE），回调地址登记为本站 `/oauth/callback`；
3. 账号在 rbac 侧具备密钥读取权限。

```bash
# .env.local（不要提交）
VITE_DATA_MODE=api
VITE_AUTH_MODE=oidc
VITE_REQUIRE_AUTH=1
VITE_OIDC_CLIENT_ID=client-xxxxxxxx
VITE_OIDC_REDIRECT_URI=https://secret.autional.com/oauth/callback
VITE_OIDC_AUTHORIZE=https://auth.autional.com/oauth/api/v1/oauth/authorize
VITE_OIDC_TOKEN=/bff/oauth/api/v1/oauth/token
# VITE_API_BASE 默认即可（同源 /bff，由 vercel.ts 代理）
# .cn 项目把域名/授权端点换成 secret.autional.cn / auth.autional.cn
```

api 模式下的只读行为：

- 列表：`GET /bff/secret/api/v1/admin/secrets?page=1&page_size=50`；
- 详情：`GET /bff/secret/api/v1/admin/secrets/detail?key=...`（元数据 + 版本，不含密钥值）；
- 连通性：登录后探测列表接口，结果显示在顶部横幅（已连通 / 不可达 / 演示）；
- 不调用任何写接口；读取失败时回落到占位数据并给出错误提示。

令牌存放与安全：`sessionStorage`（关标签即失效），PKCE `S256` + `state` + `nonce` 校验，
不使用 `client_secret`，不把令牌写入 localStorage。

## 部署

`main` 推送 → Vercel 自动部署（项目待创建）。`vercel.ts` 要求注入 `API_ORIGIN`，未设置时 **fail-closed**（构建直接报错，避免静默把 cn 流量打到 com API）。

## 结构

```
src/
├── App.tsx          # 布局 / 路由（hash）/ 概览 / 密钥 / 审计 / 登录
├── main.tsx
├── styles.css
└── lib/
    ├── config.ts    # VITE_* 运行期配置（数据/鉴权模式、API 基址、OIDC）
    ├── auth.ts      # OIDC 授权码 + PKCE 会话（sessionStorage）
    └── api.ts       # 只读管理面客户端 + 连通性探测
```

## 后续

- 接入真实的密钥写入（创建 / 轮换 / 撤销）与变更原因；
- 权限点与审计联动；
- 到期提醒与轮换策略。
