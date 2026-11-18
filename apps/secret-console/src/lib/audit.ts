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
 * 审计事件的「结果」语义判定（唯一真源，勿在视图里另写一套）。
 *
 * 服务端口径（`shared/service-audit/internal/repository/audit_repository.go:269`
 * `statusClassOr`，及 `internal/handler/dto/dto.go:49` 的 `Status int` 字段注释）：
 * - 成功 = `status ∈ {0}` ∪ `[200, 300)`
 * - 失败 = `status ∈ {1}` ∪ `[400, ∞)`
 *
 * 也就是说 `status` 是**业务状态码**（`0=成功 / 1=失败`），不是 HTTP 语义；
 * 「兼容旧 HTTP 码」只覆盖 `2xx`。历史上前端按 `200 ≤ status < 400` 判断，
 * 既把 `0` 误判为失败（成功事件显示红标），又把 `3xx` 误判为成功。
 *
 * `status == null`（字段缺失）视为成功：老事件 / 非请求类事件没有状态码。
 */
export function isAuditSuccess(status?: number | null): boolean {
  if (status == null) return true;
  if (status === 0) return true;
  return status >= 200 && status < 300;
}
