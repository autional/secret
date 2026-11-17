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
