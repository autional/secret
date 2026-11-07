# 密钥中心控制台（Secret Center）

**仓库**：`autional/secret`（public）
**域名**：[secret.autional.com](https://secret.autional.com) · [secret.autional.cn](https://secret.autional.cn)
**Vercel**：`secret`（com，`API_ORIGIN=https://api.autional.com`）· `cn-secret`（cn，`API_ORIGIN=https://api.autional.cn`）

技术栈：Vite + React 19 + Ant Design 6 + TypeScript。

## 功能

- **概览**：当前作用域的密钥总数 / 生效 / 过期 / 吊销统计；租户密钥策略（自动轮换天数、提前提醒、版本保留数）读写；加密密钥环当前 ID。
- **密钥**：全平台列表（跨租户/跨应用，按租户、应用、前缀、状态过滤；服务端分页）、详情抽屉（元数据 + 版本历史）、创建、改描述、轮换、吊销、删除、批量吊销 / 批量删除。
- **审计**：调用 audit-service 读取 `module=secret` 的操作留痕（动作筛选、分页）。
  平台管理员默认查全部租户（近 30 天，可输入租户收窄）；非平台账号只能看本租户。
- **平台盘点**：默认展示全部租户 / 全部应用，无需切换作用域；单条写操作按行携带目标租户/应用。
- **门户切换**：目录来自平台 `tenant_applications`（不维护本地域名表）；目录不可用时降级为「平台控制台」。
- **深链**：`#/secrets?key=<urlencoded key>` 直接打开详情（配置中心「去密钥中心」用这个）。

## 安全口径

- 密钥**明文默认不读**：列表与详情只返回元数据与版本号；查看明文需 `secret:admin` 权限、填写原因（写入审计 `version_read`），前端展示 30 秒后自动隐藏。
- 令牌存 **localStorage**（与 platform/admin/security 一致：刷新、新标签、跨页保持登录；退出/失效即清）；
PKCE `S256` + `state` + `nonce`；不使用 `client_secret`；剩余 < 5 分钟自动 refresh（单飞，401 亦会重试）；退出登录会调用 oauth `/revoke` 吊销 refresh/access token。
- 写操作可选「变更原因」：
  - 创建 / 改描述会写入 `metadata.change_reason`；
  - 所有写操作同时发送 `X-Change-Reason` 头，服务端写入审计 metadata；
  - 长度上限 512 字符（服务端截断）。
- 角色：`super_admin` / `admin` 可读写；`security_admin` 只读（读 `secret:read`、写 403）。令牌未带 roles 时按钮不隐藏，由服务端兜底。

## 运行

```bash
npm ci
npm run dev      # http://localhost:13122
npm run build    # tsc --noEmit + vite build → dist/
npm run preview
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `VITE_DATA_MODE` | `mock` | `mock` = 占位数据；`api` = 真实管理面 |
| `VITE_AUTH_MODE` | `mock` | `mock` = 演示会话；`oidc` = 授权码 + PKCE |
| `VITE_REQUIRE_AUTH` | 空 | `1` = 未登录先进登录页 |
| `VITE_API_BASE` | `/bff/secret/api/v1/admin/secrets` | 密钥管理面（同源，由 `vercel.ts` 代理） |
| `VITE_AUDIT_BASE` | `/bff/audit/api/v1/admin/audit` | 审计查询 |
| `VITE_TENANT_BASE` | `/bff/tenant/api/v1/admin` | 门户目录（applications） |
| `VITE_API_NAMESPACE` | 按域名推导 | **必须 ∈ 实例 `SECRET_NAMESPACES`**：`secret.autional.com/.cn` 推导为 `prod`，其余为 `dev`。不分区数据，只做门禁 |
| `VITE_TENANT_ID` | 空 | 会话未带租户时的兜底 |
| `VITE_APP_ID` | 空 | 会话未带应用时的兜底 |
| `VITE_OIDC_AUTHORIZE` | `https://auth.autional.com/oauth/api/v1/oauth/authorize` | 授权端点 |
| `VITE_OIDC_TOKEN` | `/bff/oauth/api/v1/oauth/token` | 令牌端点（同源代理） |
| `VITE_OIDC_CLIENT_ID` | 空 | 公开客户端（`01AR...008`） |
| `VITE_OIDC_REDIRECT_URI` | `${origin}/oauth/callback` | 必须与客户端登记逐字一致 |
| `VITE_OIDC_SCOPE` | `openid profile email offline_access read` | 缺 `read` → 读接口 403 |

样例见 `.env.example`。

## api 模式行为（已接入）

| 操作 | 接口 |
|---|---|
| 列表 | `GET /`（`prefix` / `status` / `page` / `page_size`） |
| 详情 | `GET /detail?key=`（元数据 + 版本） |
| 平台盘点列表 | `GET /all`（`tenant_id` / `app_id` / `prefix` / `status` 可选过滤） |
| 平台作用域枚举 | `GET /all/scopes`（全库 tenant×app + 条目数） |
| 作用域枚举（单租户） | `GET /scopes` |
| 创建 | `POST /` body `{key,value,description,expires_at,metadata}` |
| 改元信息 | `POST /update?key=` |
| 轮换 | `POST /rotate?key=` body `{value}` |
| 吊销 | `POST /revoke?key=` |
| 删除 | `DELETE /item/key/<key>`（软删） |
| 批量 | `POST /batch-revoke` / `POST /batch-delete` body `{keys}` |
| 策略 | `GET/PUT /policy` |
| 加密密钥环 | `GET /encryption-keys` |
| 审计（本租户） | `GET /bff/audit/api/v1/admin/audit/logs?module=secret` |
| 审计（平台跨租户） | `GET /bff/audit/api/v1/admin/audit/platform/logs?tenant_id=<tenant>&module=secret` |

所有请求带 `Authorization`、`X-Tenant-ID`、`X-App-ID`（空则省略）、`X-Namespace`。

### 数据作用域怎么用

- **列表/概览默认是平台全景**：不传 `tenant_id` / `app_id`，服务端返回全部租户、全部应用。
- **过滤**：租户、应用作用域、前缀、状态都在列表页；租户/应用下拉来自 `/all/scopes`。
- **写操作**：创建时选择租户 + 应用作用域（服务密钥通常是 `_system` + 服务名）；
  行内轮换/吊销/删除按该行的租户/应用自动带作用域。
- **策略**：按租户保存；在概览页选择租户后读写。
- **审计**：平台账号先选租户，再查该租户的 `module=secret` 事件。

## 已知限制

- **门户目录行**：`secret` 需在 `tenant_applications` 有 `type=portal/is_platform=true` 行，其它控制台的门户切换才会出现（波 3）。
- **服务端版本**：`/scopes` 与 `secret:read` 读权限属 2026-11-06 波 2 改动，需部署 secret-service 后才生效；未部署时作用域选择器退化为手填。

## 部署

`main` 推送 → Vercel 自动部署。`vercel.ts` 要求 `API_ORIGIN`，未设置时构建 **fail-closed**。

Vercel 环境变量（生产 / 预览 / 开发）：

```
API_ORIGIN=https://api.autional.com        # cn 项目 = https://api.autional.cn
VITE_DATA_MODE=api
VITE_AUTH_MODE=oidc
VITE_REQUIRE_AUTH=1
VITE_API_NAMESPACE=prod                     # ★ prod 栈必须；否则服务端 400
VITE_OIDC_CLIENT_ID=01AR0000000000000000000008
VITE_TENANT_ID=01KSQCBNVMS6SX64PJS937CE33
VITE_OIDC_REDIRECT_URI=https://secret.autional.com/oauth/callback   # cn 换 .cn
VITE_OIDC_AUTHORIZE=https://auth.autional.com/oauth/api/v1/oauth/authorize
VITE_OIDC_TOKEN=/bff/oauth/api/v1/oauth/token
VITE_OIDC_SCOPE=openid profile email offline_access read
```

## 结构

```
src/
├── App.tsx          # 布局 / hash 路由 / 概览 / 密钥 / 审计 / 作用域 / 门户切换
├── main.tsx
├── styles.css
└── lib/
    ├── config.ts    # VITE_* 运行期配置
    ├── auth.ts      # OIDC 授权码 + PKCE 会话（sessionStorage）
    ├── api.ts       # 密钥 / 审计 管理面客户端（读写）
    ├── scope.ts     # 数据作用域（X-Tenant-ID / X-App-ID）持久化
    └── portal.ts    # 门户目录 + URL 拼装 + 降级
```

## 后续

- 波 2（后端）：`security_admin` 只读、app 作用域枚举、变更原因入审计、跨租户审计。
- 波 3（门户）：`@autional/shared` / `@autional/ui` 发布 rc、9 站跟版、`tenant_applications` 加 `secret` 行、
  `scripts/checks/portal-registry.mjs` 期望清单更新。
