import type { AuditLogItem } from './api';

/**
 * 审计事件里的「变更原因」。
 *
 * 来源链路（唯一真源，勿改字段名）：
 * - 写操作前端发 `X-Change-Reason` 头；
 * - service-secret 中间件 `middleware.ChangeReason()` 调
 *   `audit_mw.SetMetadata(c, "change_reason", raw)`（shared/service-secret/internal/middleware/change_reason.go:34）；
 * - audit-service 把事件 metadata 原样回传（shared/service-audit/internal/handler/handler.go:364，
 *   `AuditLogResponse.Metadata` → JSON `metadata`）。
 *
 * 因此前端读 `metadata.change_reason`，不是顶层字段、也不是 `detail`。
 * 取不到（老事件 / 非写操作）返回空串，由表格渲染成 `—`。
 */
export function changeReasonOf(item?: Pick<AuditLogItem, 'metadata'> | null): string {
  const metadata = item?.metadata;
  if (!metadata || typeof metadata !== 'object') return '';
  const raw = (metadata as Record<string, unknown>).change_reason;
  if (typeof raw === 'string') return raw.trim();
  // 后端 auditconvert 用 fmt.Sprint 归一化，理论上总是字符串；这里容错数字/布尔。
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw).trim();
  return '';
}

/**
 * 审计「结果」的三态语义（唯一真源，勿在视图里另写一套）：
 * `success` = 成功、`failure` = 失败、`raw` = 语义未知，视图原样展示数字。
 */
export type AuditStatusKind = 'success' | 'failure' | 'raw';

/**
 * 审计事件的「结果」三态判定（唯一真源）。
 *
 * 服务端口径（`shared/service-audit/internal/repository/audit_repository.go:269`
 * `statusClassOr`，及 `internal/handler/dto/dto.go:49` 的 `Status int` 字段注释）：
 * - 成功 = `status ∈ {0}` ∪ `[200, 300)`
 * - 失败 = `status ∈ {1}` ∪ `[400, ∞)`
 * - 其余（`2..199`、`3xx`、其它中间码）= **原样展示数字**，不猜语义
 *
 * 与 `admin-console` 的审计日志口径逐字一致（回归锁
 * `sites/admin/apps/admin-console/src/app/__tests__/audit-logs-status.test.tsx` A-197）：
 * 事件管道 `status ∈ {0=成功, 1=失败}`，请求管道 `status` 为 HTTP 码，
 * 两管道共表，故 `3xx` 等未覆盖值必须原样展示而不是硬判成功/失败。
 *
 * 历史上前端按 `200 ≤ status < 400` 判断，既把 `0` 误判为失败（成功事件显示红标），
 * 又把 `3xx` 误判为成功。
 *
 * `status == null`（字段缺失）视为成功：老事件 / 非请求类事件没有状态码。
 */
export function auditStatusKind(status?: number | null): AuditStatusKind {
  if (status == null) return 'success';
  if (status === 0) return 'success';
  if (status >= 200 && status < 300) return 'success';
  if (status === 1 || status >= 400) return 'failure';
  return 'raw';
}

/**
 * 兼容导出：仅「成功」一态为 true（`raw` 归为 false）。
 * 新代码请直接用 `auditStatusKind`，以保留 `raw` 的原样展示语义。
 */
export function isAuditSuccess(status?: number | null): boolean {
  return auditStatusKind(status) === 'success';
}

/**
 * 「结果」列的展示单元（唯一真源，勿在视图里另写一套）。
 *
 * 三态映射：
 * - `success` → i18n `audit.success`
 * - `failure` → i18n `audit.fail`
 * - `raw`     → **原样展示状态码数字**（不猜语义）
 *
 * 为什么单独抽成纯函数：线上样本只有 200/400/401，第 3 分支（原样显示）
 * 长期没有回归覆盖；判定留在 JSX 里就无法被 vitest 覆盖，故提到 `lib/`。
 */
export type AuditResultDisplay = { kind: 'label'; labelKey: 'audit.success' | 'audit.fail' } | { kind: 'raw'; text: string };

export function auditResultDisplay(status?: number | null): AuditResultDisplay {
  const kind = auditStatusKind(status);
  if (kind === 'raw') return { kind: 'raw', text: String(status) };
  return { kind: 'label', labelKey: kind === 'success' ? 'audit.success' : 'audit.fail' };
}

/** 非真实用户的操作者标记（后端系统事件写 `operator_id = 'system'`）。 */
export const SYSTEM_OPERATOR_ID = 'system';

/**
 * 判定某个 `operator_id` 是否「不是真实用户」——即系统事件或空值。
 *
 * 为什么需要：审计列表会把系统事件的 `operator_id` 原样带出，旧逻辑把它当真实用户
 * 去查 `GET /bff/identity/api/v1/admin/users/system`，每页产生一条必然 404。
 * 这类行没有用户档案可解析，视图直接显示本地化的「系统」，**不发请求**。
 */
export function isSystemOperator(operatorId?: string | null): boolean {
  const value = String(operatorId ?? '').trim().toLowerCase();
  return value === '' || value === SYSTEM_OPERATOR_ID;
}
