/**
 * 数据作用域（X-Tenant-ID / X-App-ID）。
 *
 * 服务端 `service-secret` 的每个管理面请求都必须带 `X-Tenant-ID`，并按 `X-App-ID`
 * 精确过滤（`tenant_id = ? AND app_id = ?`）。平台管理员可以跨租户：
 * 认证租户为 platform 且具备 super_admin / admin 时，header 可指定其它租户
 * （含服务密钥所在的 `_system`）。
 *
 * 作用域存 sessionStorage（与本标签页的登录会话同生命周期），退出登录时清理。
 */
import { APP_ID, PLATFORM_TENANT_ID, TENANT_ID } from './config';
import { currentSession } from './auth';

export type Scope = {
  /** 数据租户：平台租户 ULID / `_system` / 任意租户 ULID */
  tenantId: string;
  /** 应用作用域：空 = 该租户下 app_id 为空的行；服务密钥填服务名 */
  appId: string;
};

/** 服务密钥的伪租户（service-core cross/registry SystemTenant）。 */
export const SYSTEM_TENANT = '_system';

const SCOPE_KEY = 'secret-center:scope:v1';

function readStorage(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* 无存储时退化为「每次刷新回默认作用域」 */
  }
}

/** 登录会话里的租户/应用 → 构建期环境变量 → 平台租户常量。 */
export function defaultScope(): Scope {
  const session = currentSession();
  return {
    tenantId: session?.user.tenantId || TENANT_ID || PLATFORM_TENANT_ID,
    appId: session?.user.appId || APP_ID || '',
  };
}

/** 当前生效作用域（存储值缺项时逐项回默认）。 */
export function resolveScope(): Scope {
  const fallback = defaultScope();
  const raw = readStorage(SCOPE_KEY);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<Scope> | null;
    return {
      tenantId: String(parsed?.tenantId ?? '').trim() || fallback.tenantId,
      appId: String(parsed?.appId ?? '').trim(),
    };
  } catch {
    return fallback;
  }
}

export function saveScope(scope: Scope): Scope {
  const next: Scope = {
    tenantId: String(scope.tenantId ?? '').trim(),
    appId: String(scope.appId ?? '').trim(),
  };
  writeStorage(SCOPE_KEY, JSON.stringify(next));
  return next;
}

export function clearScope(): void {
  try {
    window.sessionStorage.removeItem(SCOPE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * 是否跨租户：会话租户与所选租户不同。
 * 跨租户要求认证租户为 platform 且具备 super_admin / admin，否则服务端 403。
 */
export function isCrossTenant(scope: Scope): boolean {
  const sessionTenant = currentSession()?.user.tenantId;
  if (!sessionTenant) return false;
  return scope.tenantId !== sessionTenant;
}
