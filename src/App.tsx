import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  AutoComplete,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Dropdown,
  Empty,
  Form,
  Input,
  InputNumber,
  Layout,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { FormInstance, MenuProps, TableProps } from 'antd';
import {
  API_BASE,
  API_NAMESPACE,
  AUTH_MODE,
  DATA_MODE,
  isCallbackPath,
  OIDC,
  PLATFORM_TENANT_ID,
  REQUIRE_AUTH,
  RUNTIME_MODE_LABEL,
} from './lib/config';
import { SESSION_STORAGE_KEY, completeLogin, ensureFreshSession, restoreSession, signOut, startLogin } from './lib/auth';
import type { Session } from './lib/auth';
import {
  UNAUTHORIZED_EVENT,
  batchDeleteSecrets,
  batchRevokeSecrets,
  checkApi,
  createSecret,
  deleteSecret,
  getEncryptionKeys,
  getSecretDetail,
  getSecretPolicy,
  getTenant,
  getUser,
  listAllScopes,
  listAllSecrets,
  listAudit,
  listTenants,
  revealSecretVersion,
  revokeSecret,
  rotateSecret,
  updateSecretMeta,
  upsertSecretPolicy,
} from './lib/api';
import type {
  ApiHealth,
  AuditLogItem,
  ScopeOverride,
  SecretDetail,
  SecretItem,
  SecretPolicy,
  SecretScope,
  SecretVersion,
} from './lib/api';
import { clearScope } from './lib/scope';
import {
  CURRENT_PORTAL_CODE,
  buildPortalUrl,
  fallbackPlatformUrl,
  fetchPortals,
  filterPortals,
  rootDomainOf,
} from './lib/portal';
import type { PortalApplication } from './lib/portal';
import './styles.css';

const { Text } = Typography;

type Page = 'overview' | 'secrets' | 'audit';

type HealthState = { state: 'checking' | 'ok' | 'error' | 'mock'; message: string };

type WriteMode = 'create' | 'edit' | 'rotate' | 'revoke' | 'delete' | 'batch-revoke' | 'batch-delete';

type WriteState = {
  mode: WriteMode;
  key?: string;
  keys?: string[];
  scope?: ScopeOverride;
};

/** 占位密钥（mock 模式；仅元数据，不含真实值）。 */
const MOCK_SECRETS: SecretItem[] = [
  {
    id: 'sec_01JDEMO000000000000000001',
    tenant_id: '_system',
    app_id: 'identity-service',
    key: 'jwt/signing/primary',
    description: 'JWT 签名主密钥',
    version: 3,
    status: 'active',
    created_at: '2026-01-12T08:00:00Z',
    updated_at: '2026-10-28T09:12:00Z',
    expires_at: '2027-10-28T09:12:00Z',
  },
  {
    id: 'sec_01JDEMO000000000000000002',
    tenant_id: '_system',
    app_id: 'communication-service',
    key: 'sms/provider/sign',
    description: '短信服务商签名密钥',
    version: 1,
    status: 'active',
    created_at: '2025-06-11T09:00:00Z',
    updated_at: '2025-06-11T09:00:00Z',
    expires_at: null,
  },
];

const STATUS_META: Record<string, { color: string; label: string }> = {
  active: { color: 'green', label: '生效中' },
  expired: { color: 'orange', label: '已过期' },
  revoked: { color: 'red', label: '已撤销' },
};

const PAGE_TITLE: Record<Page, string> = {
  overview: '概览',
  secrets: '密钥',
  audit: '审计',
};

function parseHash(): { page: Page; query: URLSearchParams } {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [path, search] = raw.split('?');
  const clean = path.replace(/\/+$/, '');
  const page: Page = clean === 'secrets' ? 'secrets' : clean === 'audit' ? 'audit' : 'overview';
  return { page, query: new URLSearchParams(search ?? '') };
}

function hashOf(page: Page, query?: Record<string, string | undefined>): string {
  const base = page === 'overview' ? '#/' : `#/${page}`;
  if (!query) return base;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fmtTime(value?: string | number | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
}

function statusTag(status?: string) {
  const meta = STATUS_META[(status ?? '').toLowerCase()] ?? { color: 'default', label: status || '未知' };
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

/** 登录态引导（进程内只跑一次）：StrictMode 二次挂载 / 热更新不会重复消费授权码。 */
type BootResult = { session: Session | null; error: string };
let authBoot: Promise<BootResult> | null = null;

function bootstrapAuth(): Promise<BootResult> {
  if (authBoot) return authBoot;
  authBoot = (async (): Promise<BootResult> => {
    try {
      if (AUTH_MODE === 'oidc' && isCallbackPath()) {
        const session = await completeLogin();
        window.history.replaceState(null, '', `/${window.location.hash || ''}`);
        return { session, error: '' };
      }
      return { session: await restoreSession(), error: '' };
    } catch (err) {
      return { session: null, error: errorText(err) };
    }
  })();
  return authBoot;
}

/** 顶层只负责挂 antd 的 App 上下文。 */
export default function Root() {
  return (
    <AntdApp>
      <Console />
    </AntdApp>
  );
}

function Console() {
  const { message } = AntdApp.useApp();
  const [authReady, setAuthReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [authError, setAuthError] = useState('');
  const [page, setPage] = useState<Page>(() => parseHash().page);
  const [health, setHealth] = useState<HealthState>({ state: 'checking', message: '' });
  const [stats, setStats] = useState({ total: 0, active: 0, revoked: 0, expired: 0 });

  const [scopes, setScopes] = useState<SecretScope[]>([]);
  const [tenantFilter, setTenantFilter] = useState('');
  const [appFilter, setAppFilter] = useState('');

  const [secrets, setSecrets] = useState<SecretItem[]>(DATA_MODE === 'api' ? [] : MOCK_SECRETS);
  const [total, setTotal] = useState(DATA_MODE === 'api' ? 0 : MOCK_SECRETS.length);
  const [listLoading, setListLoading] = useState(DATA_MODE === 'api');
  const [listError, setListError] = useState('');
  const [prefixInput, setPrefixInput] = useState('');
  const [prefix, setPrefix] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [pageNo, setPageNo] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);

  const [viewing, setViewing] = useState<SecretItem | null>(null);
  const [detail, setDetail] = useState<SecretDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const [revealTarget, setRevealTarget] = useState<{ key: string; version: number; scope: ScopeOverride } | null>(null);
  const [revealReason, setRevealReason] = useState('');
  const [revealValue, setRevealValue] = useState<string | null>(null);
  const [revealLoading, setRevealLoading] = useState(false);
  const [revealError, setRevealError] = useState('');
  const revealTimer = useRef<number | null>(null);

  const [write, setWrite] = useState<WriteState | null>(null);
  const [writeLoading, setWriteLoading] = useState(false);
  const [form] = Form.useForm();

  const [policy, setPolicy] = useState<SecretPolicy | null>(null);
  const [policyError, setPolicyError] = useState('');
  const [encryptionKey, setEncryptionKey] = useState('');

  const [auditRows, setAuditRows] = useState<AuditLogItem[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState('');
  const [auditPage, setAuditPage] = useState(1);
  const [auditAction, setAuditAction] = useState('');
  const [auditTenant, setAuditTenant] = useState('');
  const [auditStart, setAuditStart] = useState('');
  const [auditEnd, setAuditEnd] = useState('');
  const [tenantNames, setTenantNames] = useState<Record<string, string>>({});
  const [userNames, setUserNames] = useState<Record<string, string>>({});

  const needsLogin = !session && (REQUIRE_AUTH || DATA_MODE === 'api');
  const readOnly = useMemo(() => {
    const roles = session?.user.roles ?? [];
    if (roles.length === 0) return false;
    return roles.includes('security_admin') && !roles.includes('super_admin') && !roles.includes('admin');
  }, [session]);
  const platformSession = session?.user.tenantId === PLATFORM_TENANT_ID;

  /* ------------------------------ 作用域选项 ------------------------------ */

  const tenantOptions = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of scopes) {
      const key = row.tenant_id || '（空）';
      map.set(key, (map.get(key) ?? 0) + (row.secret_count ?? 0));
    }
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, label: `${value}（${count}）` }));
  }, [scopes]);

  const appOptions = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of scopes) {
      if (tenantFilter && row.tenant_id !== tenantFilter) continue;
      const key = row.app_id || '（空）';
      map.set(key, (map.get(key) ?? 0) + (row.secret_count ?? 0));
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, label: `${value}（${count}）` }));
  }, [scopes, tenantFilter]);

  /* ------------------------------ 数据加载 ------------------------------ */

  const loadSecrets = useCallback(async () => {
    if (DATA_MODE !== 'api') {
      setSecrets(MOCK_SECRETS);
      setTotal(MOCK_SECRETS.length);
      setListError('');
      setListLoading(false);
      return;
    }
    setListLoading(true);
    setListError('');
    try {
      const res = await listAllSecrets({
        tenant_id: tenantFilter || undefined,
        app_id: appFilter || undefined,
        prefix: prefix.trim() || undefined,
        status: statusFilter === 'all' ? undefined : statusFilter,
        page: pageNo,
        page_size: pageSize,
      });
      setSecrets(res.items);
      setTotal(res.total);
      setSelectedKeys([]);
    } catch (err) {
      setListError(errorText(err));
      setSecrets([]);
      setTotal(0);
    } finally {
      setListLoading(false);
    }
  }, [tenantFilter, appFilter, prefix, statusFilter, pageNo, pageSize]);

  const loadScopes = useCallback(async () => {
    if (DATA_MODE !== 'api') return;
    try {
      setScopes(await listAllScopes());
    } catch {
      setScopes([]);
    }
  }, []);

  const loadStats = useCallback(async () => {
    if (DATA_MODE !== 'api') return;
    try {
      const [all, active, expired, revoked] = await Promise.all([
        listAllSecrets({ page: 1, page_size: 1 }),
        listAllSecrets({ status: 'active', page: 1, page_size: 1 }),
        listAllSecrets({ status: 'expired', page: 1, page_size: 1 }),
        listAllSecrets({ status: 'revoked', page: 1, page_size: 1 }),
      ]);
      setStats({ total: all.total, active: active.total, expired: expired.total, revoked: revoked.total });
    } catch {
      /* 统计失败不打断主流程 */
    }
  }, []);

  const loadPolicy = useCallback(async () => {
    if (DATA_MODE !== 'api') return;
    setPolicyError('');
    if (!tenantFilter) {
      setPolicy(null);
      return;
    }
    try {
      setPolicy(await getSecretPolicy({ tenantId: tenantFilter }));
    } catch (err) {
      setPolicy(null);
      setPolicyError(errorText(err));
    }
  }, [tenantFilter]);

  const loadEncryptionKey = useCallback(async () => {
    if (DATA_MODE !== 'api' || !session) return;
    try {
      setEncryptionKey((await getEncryptionKeys()).current);
    } catch {
      /* 缺失不影响主流程 */
    }
  }, [session]);

  const loadAudit = useCallback(async () => {
    if (DATA_MODE !== 'api' || !session) return;
    setAuditLoading(true);
    setAuditError('');
    const base = {
      action: auditAction.trim() || undefined,
      start_date: auditStart || undefined,
      end_date: auditEnd || undefined,
      page: auditPage,
      page_size: 20,
    };
    try {
      if (platformSession) {
        const tenantId = auditTenant || tenantFilter || '';
        const res = await listAudit({ ...base, platform: true, tenantId });
        setAuditRows(res.items);
        setAuditTotal(res.total);
      } else {
        const res = await listAudit(base);
        setAuditRows(res.items);
        setAuditTotal(res.total);
      }
    } catch (err) {
      setAuditError(errorText(err));
      setAuditRows([]);
      setAuditTotal(0);
    } finally {
      setAuditLoading(false);
    }
  }, [auditAction, auditStart, auditEnd, auditPage, auditTenant, tenantFilter, platformSession, session]);

  /* 登录态 */
  useEffect(() => {
    let alive = true;
    void bootstrapAuth().then((result) => {
      if (!alive) return;
      setAuthError(result.error);
      setSession(result.session);
      setAuthReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  /* 主动续期：剩余 < 5 分钟时刷新；页面重新可见时也检查一次 */
  useEffect(() => {
    if (!session || AUTH_MODE === 'mock') return;
    let alive = true;
    const tick = async () => {
      const next = await ensureFreshSession();
      if (!alive) return;
      if (!next) {
        setSession(null);
        return;
      }
      setSession((prev) => (prev && prev.accessToken === next.accessToken ? prev : next));
    };
    const timer = window.setInterval(() => void tick(), 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [session?.accessToken]);

  /* 跨标签同步：其它标签登录/退出时同步本标签 */
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== SESSION_STORAGE_KEY) return;
      if (!event.newValue) {
        setSession(null);
        return;
      }
      try {
        setSession(JSON.parse(event.newValue) as Session);
      } catch {
        /* 忽略损坏值 */
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  /* 401 → 清会话 */
  useEffect(() => {
    const onUnauthorized = () => {
      void signOut({ revoke: false }).then(() => {
        clearScope();
        setSession(null);
        setSecrets([]);
        setTotal(0);
      });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  /* 路由（含深链 ?key=） */
  useEffect(() => {
    const onHash = () => {
      const next = parseHash();
      setPage(next.page);
      const key = next.query.get('key');
      if (key && next.page === 'secrets') setViewing({ key });
    };
    window.addEventListener('hashchange', onHash);
    const boot = parseHash();
    if (boot.page === 'secrets') {
      const key = boot.query.get('key');
      if (key) setViewing({ key });
    }
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  /* 首次登录：拉作用域 / 统计 / 密钥环 */
  useEffect(() => {
    if (!authReady || !session) return;
    void loadScopes();
    void loadStats();
    void loadEncryptionKey();
  }, [authReady, session, loadScopes, loadStats, loadEncryptionKey]);

  /* 审计展示：租户名（平台会话可见） */
  useEffect(() => {
    if (DATA_MODE !== 'api' || !session || !platformSession) return;
    let alive = true;
    void listTenants()
      .then((rows) => {
        if (!alive) return;
        const map: Record<string, string> = { _system: '系统租户' };
        for (const t of rows) map[t.id] = t.display_name || t.name || t.id;
        setTenantNames(map);
      })
      .catch(() => {
        /* 解析失败回退显示 ID */
      });
    return () => {
      alive = false;
    };
  }, [session, platformSession]);

  /* 审计展示：租户名兜底（列表最多 100 条；按事件租户补查） */
  useEffect(() => {
    if (!platformSession || !auditRows.length) return;
    const missing = [...new Set(auditRows.map((r) => r.tenant_id).filter((id): id is string => !!id))].filter(
      (id) => id !== '_system' && !tenantNames[id],
    );
    if (!missing.length) return;
    let alive = true;
    void (async () => {
      const next: Record<string, string> = {};
      for (const id of missing) {
        const tenant = await getTenant(id);
        if (tenant) next[id] = tenant.display_name || tenant.name || id;
      }
      if (alive && Object.keys(next).length) setTenantNames((prev) => ({ ...prev, ...next }));
    })();
    return () => {
      alive = false;
    };
  }, [auditRows, platformSession, tenantNames]);

  /* 审计展示：操作者名（按事件租户解析；失败再按平台租户，最后回退 ID） */
  useEffect(() => {
    if (!platformSession || !auditRows.length) return;
    const missing = [...new Set(auditRows.map((r) => r.operator_id).filter((id): id is string => !!id))].filter(
      (id) => !userNames[id],
    );
    if (!missing.length) return;
    let alive = true;
    void (async () => {
      const next: Record<string, string> = {};
      for (const id of missing) {
        const row = auditRows.find((r) => r.operator_id === id);
        // 先按平台租户解析（密钥中心操作者通常是平台账号），失败再按事件租户；
        // 避免每页先打一次必然 404 的事件租户请求。
        let user = await getUser(id, { tenantId: PLATFORM_TENANT_ID });
        const tenantId = row?.tenant_id ?? '';
        if (!user && tenantId) user = await getUser(id, { tenantId });
        if (user) next[id] = user.username || user.email || id;
      }
      if (alive && Object.keys(next).length) setUserNames((prev) => ({ ...prev, ...next }));
    })();
    return () => {
      alive = false;
    };
  }, [auditRows, platformSession, userNames]);

  /* 列表 / 策略 */
  useEffect(() => {
    if (!authReady) return;
    if (DATA_MODE === 'api' && !session) {
      setListLoading(false);
      return;
    }
    void loadSecrets();
  }, [authReady, session, loadSecrets]);

  useEffect(() => {
    if (!authReady || !session) return;
    void loadPolicy();
  }, [authReady, session, loadPolicy]);

  /* 连通性 */
  useEffect(() => {
    if (!authReady || !session) {
      setHealth({ state: 'mock', message: '未登录：未检测 API' });
      return;
    }
    let alive = true;
    setHealth({ state: 'checking', message: '正在检测 API 连通性…' });
    void checkApi().then((result: ApiHealth) => {
      if (!alive) return;
      if (result.mode === 'mock') setHealth({ state: 'mock', message: result.message });
      else setHealth({ state: result.ok ? 'ok' : 'error', message: result.message });
    });
    return () => {
      alive = false;
    };
  }, [authReady, session]);

  /* 审计 */
  useEffect(() => {
    if (page !== 'audit' || !authReady || !session) return;
    void loadAudit();
  }, [page, authReady, session, loadAudit]);

  /* 详情 */
  useEffect(() => {
    if (!viewing) {
      setDetail(null);
      setDetailError('');
      return;
    }
    if (DATA_MODE !== 'api' || !session) return;
    let alive = true;
    setDetailLoading(true);
    setDetailError('');
    const scope: ScopeOverride = { tenantId: viewing.tenant_id ?? '', appId: viewing.app_id ?? '' };
    void getSecretDetail(viewing.key, scope)
      .then((data) => {
        if (alive) setDetail(data);
      })
      .catch((err) => {
        if (alive) setDetailError(errorText(err));
      })
      .finally(() => {
        if (alive) setDetailLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [viewing, session]);

  /* ------------------------------ 交互 ------------------------------ */

  const go = (next: Page) => {
    window.location.hash = hashOf(next);
    setPage(next);
    window.scrollTo({ top: 0 });
  };

  const login = async () => {
    setAuthError('');
    try {
      const next = await startLogin();
      if (next) setSession(next);
    } catch (err) {
      setAuthError(errorText(err));
    }
  };

  const logout = async () => {
    await signOut();
    clearScope();
    setSession(null);
    setViewing(null);
    setSecrets([]);
    setTotal(0);
    message.success('已退出登录');
  };

  const openDetail = (row: SecretItem) => {
    setViewing(row);
    if (page !== 'secrets') {
      window.location.hash = hashOf('secrets', { key: row.key });
      setPage('secrets');
    } else {
      window.history.replaceState(null, '', `${window.location.pathname}${hashOf('secrets', { key: row.key })}`);
    }
  };

  const closeDetail = () => {
    setViewing(null);
    if (page === 'secrets') {
      window.history.replaceState(null, '', `${window.location.pathname}${hashOf('secrets')}`);
    }
  };

  const scopeOf = (row: SecretItem): ScopeOverride => ({
    tenantId: row.tenant_id ?? '',
    appId: row.app_id ?? '',
  });

  const clearRevealTimer = () => {
    if (revealTimer.current !== null) {
      window.clearTimeout(revealTimer.current);
      revealTimer.current = null;
    }
  };

  const closeReveal = () => {
    clearRevealTimer();
    setRevealTarget(null);
    setRevealReason('');
    setRevealValue(null);
    setRevealError('');
  };

  const openReveal = (row: SecretItem, version: number) => {
    clearRevealTimer();
    setRevealTarget({ key: row.key, version, scope: scopeOf(row) });
    setRevealReason('');
    setRevealValue(null);
    setRevealError('');
  };

  const confirmReveal = async () => {
    if (!revealTarget) return;
    const reason = revealReason.trim();
    if (!reason) {
      setRevealError('请填写操作原因，以便审计。');
      return;
    }
    setRevealLoading(true);
    setRevealError('');
    try {
      const res = await revealSecretVersion(revealTarget.key, revealTarget.version, reason, revealTarget.scope);
      setRevealValue(res?.value ?? '');
      clearRevealTimer();
      revealTimer.current = window.setTimeout(() => {
        setRevealValue(null);
        message.info('明文已自动隐藏（30 秒）');
      }, 30000);
    } catch (err) {
      setRevealError(errorText(err));
    } finally {
      setRevealLoading(false);
    }
  };

  useEffect(
    () => () => {
      if (revealTimer.current !== null) window.clearTimeout(revealTimer.current);
    },
    [],
  );

  const openWrite = (state: WriteState, initial?: Record<string, unknown>) => {
    form.resetFields();
    form.setFieldsValue(initial ?? {});
    setWrite(state);
  };

  const submitWrite = async () => {
    if (!write) return;
    if (readOnly) {
      message.info('只读角色（security_admin）不可写');
      return;
    }
    if (DATA_MODE !== 'api') {
      message.info('演示模式不支持写入：设置 VITE_DATA_MODE=api 并登录后可用');
      return;
    }
    let values: Record<string, unknown>;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const reason = String(values.reason ?? '').trim();
    setWriteLoading(true);
    try {
      switch (write.mode) {
        case 'create': {
          const rawExpiry = String(values.expires_at ?? '').trim();
          const expiresAt = /^\d{4}-\d{2}-\d{2}$/.test(rawExpiry) ? `${rawExpiry}T00:00:00Z` : rawExpiry;
          const tenantId = String(values.tenant_id ?? '').trim();
          const appId = String(values.app_id ?? '').trim();
          if (!tenantId) {
            message.error('请选择/填写租户');
            setWriteLoading(false);
            return;
          }
          await createSecret(
            {
              key: String(values.key ?? '').trim(),
              value: String(values.value ?? ''),
              description: String(values.description ?? '').trim() || undefined,
              expires_at: expiresAt || undefined,
              reason,
            },
            { tenantId, appId },
          );
          message.success('已创建密钥');
          break;
        }
        case 'edit': {
          if (!write.key || !write.scope) return;
          const description = String(values.description ?? '').trim();
          if (!description && !reason) {
            message.error('描述与变更原因至少填一项');
            setWriteLoading(false);
            return;
          }
          await updateSecretMeta(write.key, { description, reason }, write.scope);
          message.success('已更新元信息');
          break;
        }
        case 'rotate': {
          if (!write.key || !write.scope) return;
          await rotateSecret(write.key, String(values.value ?? ''), reason, write.scope);
          message.success(`已轮换 ${write.key}`);
          break;
        }
        case 'revoke': {
          if (!write.key || !write.scope) return;
          await revokeSecret(write.key, reason, write.scope);
          message.success(`已吊销 ${write.key}`);
          break;
        }
        case 'delete': {
          if (!write.key || !write.scope) return;
          await deleteSecret(write.key, reason, write.scope);
          message.success(`已删除 ${write.key}`);
          break;
        }
        case 'batch-revoke':
        case 'batch-delete': {
          // 批量接口按 header 作用域执行：跨租户/跨应用需分组多次调用。
          const wanted = new Set(write.keys ?? []);
          const groups = new Map<string, { scope: ScopeOverride; keys: string[] }>();
          for (const row of secrets) {
            if (!wanted.has(row.key)) continue;
            const scope = scopeOf(row);
            const id = `${scope.tenantId}/${scope.appId ?? ''}`;
            const entry = groups.get(id) ?? { scope, keys: [] };
            entry.keys.push(row.key);
            groups.set(id, entry);
          }
          let succeeded = 0;
          let failed = 0;
          for (const group of groups.values()) {
            const result =
              write.mode === 'batch-revoke'
                ? await batchRevokeSecrets(group.keys, reason, group.scope)
                : await batchDeleteSecrets(group.keys, reason, group.scope);
            succeeded += result.succeeded?.length ?? 0;
            failed += result.errors?.length ?? 0;
          }
          if (failed) message.warning(`批量操作：成功 ${succeeded}，失败 ${failed}`);
          else message.success(`批量操作完成：${succeeded} 条`);
          break;
        }
      }
      setWrite(null);
      setSelectedKeys([]);
      await loadSecrets();
      await loadStats();
      await loadScopes();
      if (viewing && write.mode !== 'delete' && write.mode !== 'revoke') setViewing({ ...viewing });
    } catch (err) {
      message.error(errorText(err));
    } finally {
      setWriteLoading(false);
    }
  };

  const savePolicy = async (input: { auto_rotate_days?: number; notification_days_before?: number; max_versions?: number }) => {
    if (!tenantFilter) {
      message.info('先在「密钥」页选择租户，再维护该租户的密钥策略');
      return;
    }
    try {
      setPolicy(await upsertSecretPolicy(input, undefined, { tenantId: tenantFilter }));
      message.success('已保存密钥策略');
    } catch (err) {
      message.error(errorText(err));
    }
  };

  const userMenuItems: MenuProps['items'] = session
    ? [
        {
          key: 'who',
          disabled: true,
          label: (
            <div className="user-who">
              <b>{session.user.name}</b>
              <div className="hint">{session.user.email || '—'}</div>
            </div>
          ),
        },
        {
          key: 'scope',
          disabled: true,
          label: <div className="hint">会话租户 {session.user.tenantId || '（令牌未带）'}</div>,
        },
        { type: 'divider' },
        { key: 'logout', label: '退出登录', danger: true },
      ]
    : [];

  if (!authReady) {
    return (
      <Layout className="app">
        <div className="boot">
          <Spin size="large" />
          <div className="hint">正在校验登录状态…</div>
        </div>
      </Layout>
    );
  }

  if (needsLogin) {
    return <LoginPage error={authError} onLogin={() => void login()} />;
  }

  return (
    <Layout className="app">
      <Layout.Header className="topbar">
        <div className="brand">
          <span className="mark">A</span>
          <span>密钥中心</span>
          <Text type="secondary" className="sub">
            Secret Center
          </Text>
        </div>
        <nav className="nav">
          {(['overview', 'secrets', 'audit'] as Page[]).map((item) => (
            <a
              key={item}
              className={page === item ? 'on' : ''}
              href={hashOf(item)}
              onClick={(event) => {
                event.preventDefault();
                go(item);
              }}
            >
              {PAGE_TITLE[item]}
            </a>
          ))}
        </nav>
        <div className="grow" />
        <Space size={8} wrap>
          <Tag color={DATA_MODE === 'api' ? 'blue' : 'default'}>{RUNTIME_MODE_LABEL}</Tag>
          {readOnly ? <Tag>只读（security_admin）</Tag> : null}
          <Tag color="gold">ns: {API_NAMESPACE}</Tag>
          <PortalMenu session={session} />
          {session ? (
            <Dropdown
              trigger={['click']}
              menu={{
                items: userMenuItems,
                onClick: ({ key }) => {
                  if (key === 'logout') void logout();
                },
              }}
            >
              <Button size="small">{session.user.name}</Button>
            </Dropdown>
          ) : (
            <Button size="small" type="primary" onClick={() => void login()}>
              登录
            </Button>
          )}
          <a className="platform-link" href={fallbackPlatformUrl(window.location.hostname)} target="_blank" rel="noreferrer">
            返回平台
          </a>
        </Space>
      </Layout.Header>

      <Layout.Content className="wrap">
        <Alert
          className="banner"
          type={platformSession ? 'info' : 'warning'}
          showIcon
          message={platformSession ? '平台级盘点（全部租户 / 全部应用）' : '非平台租户会话：可能无法读取全部数据'}
          description={
            <Space size={10} wrap>
              <ApiBadge health={health} />
              <span className="hint">
                API：<code className="mono">{API_BASE}</code>
              </span>
              <span className="hint">
                作用域：{scopes.length} 组（{tenantOptions.length} 个租户）
              </span>
              {health.message ? <span className="hint">{health.message}</span> : null}
            </Space>
          }
        />

        {page === 'overview' ? (
          <Overview
            stats={stats}
            policy={policy}
            policyError={policyError}
            encryptionKey={encryptionKey}
            health={health}
            readOnly={readOnly}
            tenantFilter={tenantFilter}
            tenantOptions={tenantOptions}
            onTenantFilter={(value) => {
              setTenantFilter(value);
              setAppFilter('');
              setPageNo(1);
            }}
            onSavePolicy={savePolicy}
            onOpenSecrets={() => go('secrets')}
          />
        ) : null}

        {page === 'secrets' ? (
          <SecretsPage
            rows={secrets}
            total={total}
            loading={listLoading}
            error={listError}
            prefix={prefixInput}
            status={statusFilter}
            tenantFilter={tenantFilter}
            appFilter={appFilter}
            tenantOptions={tenantOptions}
            appOptions={appOptions}
            pageNo={pageNo}
            pageSize={pageSize}
            selectedKeys={selectedKeys}
            readOnly={readOnly}
            onPrefix={(value) => {
              setPrefixInput(value);
              if (!value) {
                setPrefix('');
                setPageNo(1);
              }
            }}
            onSearch={() => {
              setPrefix(prefixInput.trim());
              setPageNo(1);
            }}
            onStatus={(value) => {
              setStatusFilter(value);
              setPageNo(1);
            }}
            onTenant={(value) => {
              setTenantFilter(value);
              setAppFilter('');
              setPageNo(1);
            }}
            onApp={(value) => {
              setAppFilter(value);
              setPageNo(1);
            }}
            onPage={(next, size) => {
              setPageNo(next);
              setPageSize(size);
            }}
            onReload={() => void loadSecrets()}
            onView={openDetail}
            onSelected={setSelectedKeys}
            onCreate={() =>
              openWrite({ mode: 'create' }, { tenant_id: tenantFilter || '', app_id: appFilter || '' })
            }
            onEdit={(row) => openWrite({ mode: 'edit', key: row.key, scope: scopeOf(row) }, { description: row.description ?? '' })}
            onRotate={(row) => openWrite({ mode: 'rotate', key: row.key, scope: scopeOf(row) }, { key: row.key })}
            onRevoke={(row) => openWrite({ mode: 'revoke', key: row.key, scope: scopeOf(row) }, { key: row.key })}
            onDelete={(row) => openWrite({ mode: 'delete', key: row.key, scope: scopeOf(row) }, { key: row.key })}
            onBatchRevoke={() => openWrite({ mode: 'batch-revoke', keys: selectedKeys })}
            onBatchDelete={() => openWrite({ mode: 'batch-delete', keys: selectedKeys })}
          />
        ) : null}

        {page === 'audit' ? (
          <AuditPage
            rows={auditRows}
            total={auditTotal}
            loading={auditLoading}
            error={auditError}
            pageNo={auditPage}
            action={auditAction}
            startDate={auditStart}
            endDate={auditEnd}
            platform={platformSession}
            tenantId={auditTenant}
            tenantOptions={tenantOptions}
            tenantNames={tenantNames}
            userNames={userNames}
            onTenant={(value) => {
              setAuditTenant(value);
              setAuditPage(1);
            }}
            onAction={(value) => {
              setAuditAction(value);
              setAuditPage(1);
            }}
            onStartDate={(value) => {
              setAuditStart(value);
              setAuditPage(1);
            }}
            onEndDate={(value) => {
              setAuditEnd(value);
              setAuditPage(1);
            }}
            onPage={setAuditPage}
            onReload={() => void loadAudit()}
          />
        ) : null}
      </Layout.Content>

      <Drawer open={!!viewing} width={640} title="密钥详情" onClose={closeDetail} destroyOnHidden>
        {viewing ? (
          <>
            {detailLoading ? (
              <div className="page-state small-gap">
                <Spin size="small" />
                <span className="hint">正在读取详情…</span>
              </div>
            ) : null}
            {detailError ? <Alert className="banner" type="error" showIcon message={detailError} /> : null}
            <Descriptions
              size="small"
              bordered
              column={1}
              items={[
                { key: 'key', label: '密钥路径', children: <code className="mono">{viewing.key}</code> },
                { key: 'id', label: 'ID', children: <span className="mono small">{viewing.id || detail?.id || '—'}</span> },
                { key: 'tenant', label: '租户', children: <code className="mono small">{viewing.tenant_id || detail?.tenant_id || '—'}</code> },
                { key: 'app', label: '应用作用域', children: viewing.app_id || detail?.app_id || '（空）' },
                { key: 'desc', label: '描述', children: viewing.description || detail?.description || '—' },
                { key: 'status', label: '状态', children: statusTag(viewing.status ?? detail?.status) },
                { key: 'version', label: '当前版本', children: `v${viewing.version ?? detail?.version ?? '—'}` },
                { key: 'expires', label: '到期时间', children: fmtTime(viewing.expires_at ?? detail?.expires_at) },
                { key: 'created', label: '创建时间', children: fmtTime(viewing.created_at ?? detail?.created_at) },
                { key: 'updated', label: '更新时间', children: fmtTime(viewing.updated_at ?? detail?.updated_at) },
              ]}
            />

            <div className="drawer-actions">
              {readOnly ? (
                <Tag>只读角色：不可写</Tag>
              ) : (
                <Space wrap>
                  <Button
                    size="small"
                    onClick={() => openWrite({ mode: 'rotate', key: viewing.key, scope: scopeOf(viewing) }, { key: viewing.key })}
                  >
                    轮换
                  </Button>
                  <Button
                    size="small"
                    onClick={() =>
                      openWrite(
                        { mode: 'edit', key: viewing.key, scope: scopeOf(viewing) },
                        { description: viewing.description ?? '' },
                      )
                    }
                  >
                    改描述
                  </Button>
                  <Button
                    size="small"
                    danger
                    onClick={() => openWrite({ mode: 'revoke', key: viewing.key, scope: scopeOf(viewing) }, { key: viewing.key })}
                  >
                    吊销
                  </Button>
                  <Button
                    size="small"
                    danger
                    onClick={() => openWrite({ mode: 'delete', key: viewing.key, scope: scopeOf(viewing) }, { key: viewing.key })}
                  >
                    删除
                  </Button>
                </Space>
              )}
            </div>

            <h3 className="sub-title">版本</h3>
            <VersionTable
              versions={detail?.versions ?? []}
              onReveal={(version) => viewing && openReveal(viewing, version)}
              revealDisabled={readOnly}
            />

            <Alert
              className="banner top-gap"
              type="warning"
              showIcon
              message="密钥明文默认不展示"
              description="查看明文需填写原因并写入审计（version_read）；明文只在本次会话内展示 30 秒。"
            />
          </>
        ) : null}
      </Drawer>

      <Modal
        open={!!revealTarget}
        title="查看密钥明文"
        onCancel={closeReveal}
        footer={
          revealValue !== null ? (
            <Button onClick={closeReveal}>关闭</Button>
          ) : (
            <Space>
              <Button onClick={closeReveal}>取消</Button>
              <Button type="primary" loading={revealLoading} onClick={() => void confirmReveal()}>
                查看明文
              </Button>
            </Space>
          )
        }
        destroyOnHidden
      >
        {revealValue !== null ? (
          <>
            <Alert type="info" showIcon message="明文已显示，将在 30 秒后自动隐藏。" />
            <Input.TextArea value={revealValue} readOnly rows={6} className="mono" />
            {revealTarget ? (
              <div className="hint">
                版本 v{revealTarget.version} · 本次查看已写入审计
              </div>
            ) : null}
          </>
        ) : (
          <>
            {revealError ? <Alert type="error" showIcon message={revealError} /> : null}
            <p className="hint">查看明文会记录操作原因与审计事件，明文只在本次会话内展示 30 秒。</p>
            <Input.TextArea
              value={revealReason}
              onChange={(event) => setRevealReason(event.target.value)}
              rows={3}
              maxLength={512}
              showCount
              placeholder="填写查看明文的原因（写入审计）"
            />
          </>
        )}
      </Modal>

      <WriteDialog
        state={write}
        form={form}
        loading={writeLoading}
        tenantOptions={tenantOptions}
        appOptions={appOptions}
        onCancel={() => setWrite(null)}
        onSubmit={() => void submitWrite()}
      />
    </Layout>
  );
}

/* ------------------------------ 登录 / 状态 ------------------------------ */

function LoginPage({ error, onLogin }: { error: string; onLogin: () => void }) {
  return (
    <Layout className="app">
      <div className="boot">
        <Card className="login-card">
          <div className="brand">
            <span className="mark">A</span>
            <span>密钥中心</span>
            <Text type="secondary" className="sub">
              Secret Center
            </Text>
          </div>
          <h1 className="page">登录后管理密钥</h1>
          <p className="desc">需要 Autional 管理面账号（super_admin / admin）与 secret:read / secret:admin 权限。</p>
          {error ? <Alert className="banner" type="error" showIcon message={error} /> : null}
          <Space size={12} wrap>
            <Button type="primary" onClick={onLogin}>
              使用 Autional 账号登录
            </Button>
            <a className="platform-link" href={fallbackPlatformUrl(window.location.hostname)} target="_blank" rel="noreferrer">
              返回平台
            </a>
          </Space>
          <div className="hint top-gap">
            {AUTH_MODE === 'mock' ? '当前为演示鉴权（VITE_AUTH_MODE=mock）。' : `OIDC 授权码 + PKCE · ${OIDC.authorizeUrl}`}
          </div>
        </Card>
      </div>
    </Layout>
  );
}

function ApiBadge({ health }: { health: HealthState }) {
  if (health.state === 'checking') return <Tag color="blue">API 检测中…</Tag>;
  if (health.state === 'ok') return <Tag color="green">API 已连通</Tag>;
  if (health.state === 'mock') return <Tag>演示数据 · 未连 API</Tag>;
  return <Tag color="red">API 不可达</Tag>;
}

/* ------------------------------ 门户切换 ------------------------------ */

function PortalMenu({ session }: { session: Session | null }) {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'degraded'; portals: PortalApplication[] }>({
    status: 'loading',
    portals: [],
  });

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    const token = session?.accessToken ?? '';
    if (!token) {
      setState({ status: 'degraded', portals: [] });
      return () => controller.abort();
    }
    setState({ status: 'loading', portals: [] });
    void (async () => {
      try {
        const rows = await fetchPortals({ tenantId: PLATFORM_TENANT_ID, accessToken: token, signal: controller.signal });
        if (!alive) return;
        const visible = filterPortals(rows, { tenantId: PLATFORM_TENANT_ID, roles: session?.user.roles })
          .slice()
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        const hasOther = visible.some((item) => item.code !== CURRENT_PORTAL_CODE);
        setState(hasOther ? { status: 'ready', portals: visible } : { status: 'degraded', portals: [] });
      } catch {
        if (alive) setState({ status: 'degraded', portals: [] });
      }
    })();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [session]);

  const loading = state.status === 'loading';
  const degraded = state.status === 'degraded';
  const hostname = window.location.hostname;
  const rootDomain = rootDomainOf(hostname);

  const items: MenuProps['items'] = degraded
    ? [{ key: 'fallback:platform', label: '平台控制台' }]
    : state.portals.map((portal) => ({
        key: portal.code,
        disabled: portal.code === CURRENT_PORTAL_CODE,
        label: (
          <div className="portal-item">
            <span>
              {portal.name || portal.code}
              {portal.code === CURRENT_PORTAL_CODE ? (
                <Tag color="blue" className="portal-current">
                  当前
                </Tag>
              ) : null}
            </span>
            {portal.description ? <span className="hint">{portal.description}</span> : null}
          </div>
        ),
      }));

  const openPortal = (key: string) => {
    if (degraded) {
      window.location.assign(fallbackPlatformUrl(hostname));
      return;
    }
    const entry = state.portals.find((item) => item.code === key);
    if (!entry || entry.code === CURRENT_PORTAL_CODE) return;
    const url = buildPortalUrl(entry, rootDomain, window.location.protocol);
    if (url) window.location.assign(url);
  };

  return (
    <Tooltip title={degraded ? '门户目录不可用（已降级到平台控制台）' : '切换门户'}>
      <Dropdown trigger={['click']} disabled={loading} menu={{ items, onClick: ({ key }) => openPortal(key), style: { minWidth: 220 } }}>
        <Button size="small" loading={loading}>
          门户
        </Button>
      </Dropdown>
    </Tooltip>
  );
}

/* -------------------------------- 概览 -------------------------------- */

function Overview(props: {
  stats: { total: number; active: number; revoked: number; expired: number };
  policy: SecretPolicy | null;
  policyError: string;
  encryptionKey: string;
  health: HealthState;
  readOnly: boolean;
  tenantFilter: string;
  tenantOptions: { value: string; label: string }[];
  onTenantFilter: (value: string) => void;
  onSavePolicy: (input: { auto_rotate_days?: number; notification_days_before?: number; max_versions?: number }) => void;
  onOpenSecrets: () => void;
}) {
  const {
    stats,
    policy,
    policyError,
    encryptionKey,
    health,
    readOnly,
    tenantFilter,
    tenantOptions,
    onTenantFilter,
    onSavePolicy,
    onOpenSecrets,
  } = props;
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    form.setFieldsValue({
      auto_rotate_days: policy?.auto_rotate_days ?? 0,
      notification_days_before: policy?.notification_days_before ?? 7,
      max_versions: policy?.max_versions ?? 10,
    });
  }, [policy, form]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page">密钥中心概览</h1>
          <p className="desc">平台级盘点：全租户 / 全应用，无需切换作用域。</p>
        </div>
        <Button type="primary" onClick={onOpenSecrets}>
          进入密钥列表
        </Button>
      </div>

      <Row gutter={12} className="stats">
        <Col span={6}>
          <Card size="small">
            <Statistic title="密钥总数（全平台）" value={stats.total} />
            <Text type="secondary" className="hint">
              来自服务端 total
            </Text>
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="生效中" value={stats.active} valueStyle={{ color: '#15803d' }} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="已过期" value={stats.expired} valueStyle={{ color: '#c2410c' }} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="已吊销" value={stats.revoked} valueStyle={{ color: '#b91c1c' }} />
          </Card>
        </Col>
      </Row>

      <Row gutter={12} className="top-gap">
        <Col span={14}>
          <Card
            size="small"
            title="密钥策略（按租户）"
            extra={
              <Button
                size="small"
                type="primary"
                disabled={readOnly || !tenantFilter}
                loading={saving}
                onClick={() => {
                  setSaving(true);
                  void form
                    .validateFields()
                    .then((values) => {
                      onSavePolicy({
                        auto_rotate_days: Number(values.auto_rotate_days ?? 0),
                        notification_days_before: Number(values.notification_days_before ?? 0),
                        max_versions: Number(values.max_versions ?? 10),
                      });
                      setSaving(false);
                    })
                    .catch(() => setSaving(false));
                }}
              >
                保存
              </Button>
            }
          >
            <Space wrap className="filters">
              <Text type="secondary">选择租户</Text>
              <AutoComplete
                style={{ width: 300 }}
                placeholder="选择或输入租户 ULID"
                value={tenantFilter}
                options={tenantOptions}
                filterOption={(input, option) =>
                  String(option?.value ?? '')
                    .toLowerCase()
                    .includes(input.toLowerCase())
                }
                onChange={(value) => onTenantFilter(value)}
                allowClear
              />
              {!tenantFilter ? <span className="hint">先选租户才能查看/保存该租户的策略</span> : null}
            </Space>
            {policyError ? <Alert className="banner" type="warning" showIcon message="策略读取失败" description={policyError} /> : null}
            <Form form={form} layout="inline" className="policy-form">
              <Form.Item name="auto_rotate_days" label="自动轮换（天，0=不自动）">
                <InputNumber min={0} max={36500} style={{ width: 140 }} disabled={readOnly || !tenantFilter} />
              </Form.Item>
              <Form.Item name="notification_days_before" label="提前提醒（天）">
                <InputNumber min={0} max={3650} style={{ width: 120 }} disabled={readOnly || !tenantFilter} />
              </Form.Item>
              <Form.Item name="max_versions" label="版本保留数">
                <InputNumber min={1} max={10000} style={{ width: 100 }} disabled={readOnly || !tenantFilter} />
              </Form.Item>
            </Form>
          </Card>
        </Col>
        <Col span={10}>
          <Card size="small" title="运行状态">
            <Space direction="vertical" size={8}>
              <Space size={8}>
                <Text type="secondary">API</Text>
                <ApiBadge health={health} />
              </Space>
              <div className="hint mono">{API_BASE}</div>
              <div className="hint">
                数据模式：{RUNTIME_MODE_LABEL} · 鉴权：{AUTH_MODE === 'oidc' ? 'OIDC + PKCE' : '演示会话'}
              </div>
              <div className="hint">
                命名空间：<code className="mono">{API_NAMESPACE}</code>（必须 ∈ 实例 SECRET_NAMESPACES）
              </div>
              <div className="hint">
                当前加密密钥：<code className="mono">{encryptionKey || '—'}</code>
              </div>
            </Space>
          </Card>
        </Col>
      </Row>

      <Alert
        className="banner top-gap"
        type="info"
        showIcon
        message="密钥明文默认遮罩"
        description="创建 / 轮换后值默认不展示；查看明文需填写原因、写入审计，并在 30 秒后自动隐藏。"
      />
    </>
  );
}

/* -------------------------------- 密钥 -------------------------------- */

function SecretsPage(props: {
  rows: SecretItem[];
  total: number;
  loading: boolean;
  error: string;
  prefix: string;
  status: string;
  tenantFilter: string;
  appFilter: string;
  tenantOptions: { value: string; label: string }[];
  appOptions: { value: string; label: string }[];
  pageNo: number;
  pageSize: number;
  selectedKeys: string[];
  readOnly: boolean;
  onPrefix: (value: string) => void;
  onSearch: () => void;
  onStatus: (value: string) => void;
  onTenant: (value: string) => void;
  onApp: (value: string) => void;
  onPage: (page: number, size: number) => void;
  onReload: () => void;
  onView: (row: SecretItem) => void;
  onSelected: (keys: string[]) => void;
  onCreate: () => void;
  onEdit: (row: SecretItem) => void;
  onRotate: (row: SecretItem) => void;
  onRevoke: (row: SecretItem) => void;
  onDelete: (row: SecretItem) => void;
  onBatchRevoke: () => void;
  onBatchDelete: () => void;
}) {
  const {
    rows,
    total,
    loading,
    error,
    prefix,
    status,
    tenantFilter,
    appFilter,
    tenantOptions,
    appOptions,
    pageNo,
    pageSize,
    selectedKeys,
    readOnly,
    onPrefix,
    onSearch,
    onStatus,
    onTenant,
    onApp,
    onPage,
    onReload,
    onView,
    onSelected,
    onCreate,
    onEdit,
    onRotate,
    onRevoke,
    onDelete,
    onBatchRevoke,
    onBatchDelete,
  } = props;

  const columns: TableProps<SecretItem>['columns'] = [
    {
      title: '密钥路径',
      dataIndex: 'key',
      width: '24%',
      render: (value: string, row) => (
        <Button type="link" size="small" className="key-link" onClick={() => onView(row)}>
          <code className="mono key-cell">{value}</code>
        </Button>
      ),
    },
    {
      title: '租户',
      dataIndex: 'tenant_id',
      width: 230,
      ellipsis: true,
      render: (value?: string) => <code className="mono small">{value || '—'}</code>,
    },
    {
      title: '应用',
      dataIndex: 'app_id',
      width: 170,
      ellipsis: true,
      render: (value?: string) => (value ? <Tag>{value}</Tag> : <Text type="secondary">（空）</Text>),
    },
    { title: '状态', dataIndex: 'status', width: 90, render: (value?: string) => statusTag(value) },
    { title: '版本', dataIndex: 'version', width: 70, render: (value?: number) => (value ? `v${value}` : '—') },
    { title: '更新时间', dataIndex: 'updated_at', width: 170, render: (value?: string) => fmtTime(value) },
    {
      title: '操作',
      width: 230,
      render: (_: unknown, row) => (
        <Space size={0} wrap>
          <Button size="small" type="link" onClick={() => onView(row)}>
            查看
          </Button>
          {readOnly ? null : (
            <>
              <Button size="small" type="link" onClick={() => onRotate(row)} disabled={row.status === 'revoked'}>
                轮换
              </Button>
              <Button size="small" type="link" onClick={() => onEdit(row)}>
                改描述
              </Button>
              <Button size="small" type="link" danger onClick={() => onRevoke(row)} disabled={row.status === 'revoked'}>
                吊销
              </Button>
              <Button size="small" type="link" danger onClick={() => onDelete(row)}>
                删除
              </Button>
            </>
          )}
        </Space>
      ),
    },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page">密钥</h1>
          <p className="desc">全平台密钥（跨租户 / 跨应用）；可按租户、应用、前缀、状态过滤。</p>
        </div>
        <Space>
          {!readOnly && selectedKeys.length > 0 ? (
            <>
              <Button danger onClick={onBatchRevoke}>
                批量吊销（{selectedKeys.length}）
              </Button>
              <Button danger onClick={onBatchDelete}>
                批量删除（{selectedKeys.length}）
              </Button>
            </>
          ) : null}
          {readOnly ? (
            <Tag>只读角色：不可写</Tag>
          ) : (
            <Button type="primary" onClick={onCreate}>
              创建密钥
            </Button>
          )}
        </Space>
      </div>

      {error ? (
        <Alert
          className="banner"
          type="error"
          showIcon
          message="读取密钥列表失败"
          description={error}
          action={
            <Button size="small" onClick={onReload}>
              重试
            </Button>
          }
        />
      ) : null}

      <Card size="small">
        <Space wrap className="filters">
          <AutoComplete
            style={{ width: 280 }}
            placeholder="租户（全部）"
            value={tenantFilter}
            options={tenantOptions}
            filterOption={(input, option) =>
              String(option?.value ?? '')
                .toLowerCase()
                .includes(input.toLowerCase())
            }
            onChange={(value) => onTenant(value)}
            allowClear
          />
          <AutoComplete
            style={{ width: 220 }}
            placeholder="应用作用域（全部）"
            value={appFilter}
            options={appOptions}
            filterOption={(input, option) =>
              String(option?.value ?? '')
                .toLowerCase()
                .includes(input.toLowerCase())
            }
            onChange={(value) => onApp(value)}
            allowClear
          />
          <Input.Search
            allowClear
            placeholder="按前缀搜索密钥路径…"
            style={{ width: 240 }}
            value={prefix}
            onChange={(event) => onPrefix(event.target.value)}
            onSearch={() => onSearch()}
          />
          <Select
            style={{ width: 140 }}
            value={status}
            onChange={onStatus}
            options={[
              { value: 'all', label: '全部状态' },
              { value: 'active', label: '生效中' },
              { value: 'expired', label: '已过期' },
              { value: 'revoked', label: '已撤销' },
            ]}
          />
          <div className="grow" />
          {loading ? <Spin size="small" /> : null}
          <Button size="small" onClick={onReload} loading={loading}>
            刷新
          </Button>
        </Space>

        <Table
          size="small"
          rowKey={(row) => `${row.tenant_id ?? ''}/${row.app_id ?? ''}/${row.key}`}
          dataSource={rows}
          columns={columns}
          loading={loading}
          rowSelection={
            readOnly
              ? undefined
              : {
                  selectedRowKeys: selectedKeys,
                  onChange: (keys) => onSelected(keys.map(String)),
                }
          }
          pagination={{
            current: pageNo,
            pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50, 100],
            showTotal: (value) => `共 ${value} 条`,
            onChange: (next, size) => onPage(next, size),
          }}
          scroll={{ x: 1280 }}
          locale={{ emptyText: <Empty description={total === 0 ? '当前过滤条件下没有密钥' : '没有匹配的密钥'} /> }}
        />
      </Card>
    </>
  );
}

function VersionTable({
  versions,
  onReveal,
  revealDisabled,
}: {
  versions: SecretVersion[];
  onReveal?: (version: number) => void;
  revealDisabled?: boolean;
}) {
  if (!versions.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无版本信息" />;
  return (
    <Table
      size="small"
      rowKey={(row) => String(row.version)}
      dataSource={versions}
      pagination={false}
      columns={[
        { title: '版本', dataIndex: 'version', width: 90, render: (value: number) => `v${value}` },
        { title: '创建者', dataIndex: 'created_by', render: (value?: string) => value || '—' },
        { title: '创建时间', dataIndex: 'created_at', render: (value?: string) => fmtTime(value) },
        {
          title: '操作',
          width: 110,
          render: (_: unknown, row: SecretVersion) => (
            <Button
              size="small"
              type="link"
              disabled={revealDisabled || !onReveal}
              onClick={() => onReveal?.(row.version)}
            >
              查看明文
            </Button>
          ),
        },
      ]}
    />
  );
}

/* -------------------------------- 写入弹窗 -------------------------------- */

const WRITE_TITLE: Record<WriteMode, string> = {
  create: '创建密钥',
  edit: '修改元信息',
  rotate: '轮换密钥',
  revoke: '吊销密钥',
  delete: '删除密钥',
  'batch-revoke': '批量吊销',
  'batch-delete': '批量删除',
};

function WriteDialog(props: {
  state: WriteState | null;
  form: FormInstance;
  loading: boolean;
  tenantOptions: { value: string; label: string }[];
  appOptions: { value: string; label: string }[];
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { state, form, loading, tenantOptions, appOptions, onCancel, onSubmit } = props;
  const mode = state?.mode;
  const destructive = mode === 'revoke' || mode === 'delete' || mode === 'batch-revoke' || mode === 'batch-delete';
  const count = state?.keys?.length ?? 0;
  const [confirmText, setConfirmText] = useState('');

  useEffect(() => {
    setConfirmText('');
  }, [state?.mode, state?.key, state?.keys]);

  const confirmTarget =
    mode === 'revoke' || mode === 'delete'
      ? state?.key ?? ''
      : mode === 'batch-revoke'
        ? 'REVOKE'
        : mode === 'batch-delete'
          ? 'DELETE'
          : '';
  const confirmBlocked = destructive && confirmTarget !== '' && confirmText !== confirmTarget;

  return (
    <Modal
      open={!!state}
      title={mode ? WRITE_TITLE[mode] : ''}
      onCancel={onCancel}
      onOk={onSubmit}
      okText={destructive ? '确认' : '保存'}
      okButtonProps={{ danger: destructive, loading, disabled: confirmBlocked }}
      destroyOnHidden
      width={560}
    >
      <Form form={form} layout="vertical">
        {mode === 'create' ? (
          <>
            <Form.Item name="tenant_id" label="租户" rules={[{ required: true, message: '请选择/填写租户' }]}>
              <AutoComplete
                placeholder="选择或输入租户 ULID（服务密钥用 _system）"
                options={tenantOptions}
                filterOption={(input, option) =>
                  String(option?.value ?? '')
                    .toLowerCase()
                    .includes(input.toLowerCase())
                }
              />
            </Form.Item>
            <Form.Item name="app_id" label="应用作用域 X-App-ID" extra="服务密钥填服务名（如 identity-service）；留空表示该租户的全局行。">
              <AutoComplete placeholder="identity-service" options={appOptions} />
            </Form.Item>
            <Form.Item
              name="key"
              label="密钥路径"
              rules={[{ required: true, message: '请输入密钥路径' }, { max: 512, message: '最多 512 字符' }]}
              extra="建议使用斜杠分层路径，如 db/postgres/password。"
            >
              <Input placeholder="db/postgres/password" autoComplete="off" />
            </Form.Item>
            <Form.Item name="value" label="密钥值" rules={[{ required: true, message: '请输入密钥值' }]} extra="创建后默认不回显；查看明文需原因 + 审计（30 秒自动隐藏）。">
              <Input.Password autoComplete="new-password" placeholder="输入密钥值" />
            </Form.Item>
            <Form.Item name="description" label="描述">
              <Input.TextArea rows={2} placeholder="用途 / 消费方" />
            </Form.Item>
            <Form.Item name="expires_at" label="到期时间（可选）" extra="ISO 时间或 YYYY-MM-DD。">
              <Input placeholder="2027-01-01" autoComplete="off" />
            </Form.Item>
          </>
        ) : null}

        {state?.mode !== 'create' && (state?.scope || state?.key) ? (
          <Form.Item label="目标作用域">
            <Input
              value={`${state?.scope?.tenantId ?? ''}${state?.scope?.appId ? ` / ${state.scope.appId}` : ' / （全局）'}`}
              disabled
            />
          </Form.Item>
        ) : null}

        {mode === 'edit' ? (
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} />
          </Form.Item>
        ) : null}

        {mode === 'rotate' ? (
          <Form.Item name="value" label="新密钥值" rules={[{ required: true, message: '请输入新密钥值' }]} extra="轮换会推进版本；旧版本保留但不可读取。">
            <Input.Password autoComplete="new-password" placeholder="输入新密钥值" />
          </Form.Item>
        ) : null}

        {mode === 'revoke' || mode === 'delete' ? (
          <Alert
            className="banner"
            type="warning"
            showIcon
            message={mode === 'revoke' ? '吊销后无法再获取该密钥值' : '删除为软删除，保留期后永久清除'}
          />
        ) : null}

        {mode === 'batch-revoke' || mode === 'batch-delete' ? (
          <Alert
            className="banner"
            type="warning"
            showIcon
            message={`将${mode === 'batch-revoke' ? '吊销' : '删除'} ${count} 条密钥`}
            description="跨租户/跨应用会自动分组执行；吊销后无法再获取这些密钥值。"
          />
        ) : null}

        {destructive && confirmTarget ? (
          <Form.Item
            label={`输入 ${confirmTarget} 确认`}
            required
            validateStatus={confirmBlocked ? 'error' : undefined}
            help={confirmBlocked ? '需逐字输入目标名称/确认词后才能执行' : undefined}
          >
            <Input
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              placeholder={confirmTarget}
              autoComplete="off"
            />
          </Form.Item>
        ) : null}

        <Form.Item name="reason" label="变更原因（可选）" extra="写入审计事件 metadata.change_reason（创建/改描述另存 metadata.change_reason）。">
          <Input placeholder="例如：季度轮换 / 凭据泄露应急处置" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/* -------------------------------- 审计 -------------------------------- */

function AuditPage(props: {
  rows: AuditLogItem[];
  total: number;
  loading: boolean;
  error: string;
  pageNo: number;
  action: string;
  startDate: string;
  endDate: string;
  platform: boolean;
  tenantId: string;
  tenantOptions: { value: string; label: string }[];
  tenantNames: Record<string, string>;
  userNames: Record<string, string>;
  onTenant: (value: string) => void;
  onAction: (value: string) => void;
  onStartDate: (value: string) => void;
  onEndDate: (value: string) => void;
  onPage: (page: number) => void;
  onReload: () => void;
}) {
  const {
    rows,
    total,
    loading,
    error,
    pageNo,
    action,
    startDate,
    endDate,
    platform,
    tenantId,
    tenantOptions,
    tenantNames,
    userNames,
    onTenant,
    onAction,
    onStartDate,
    onEndDate,
    onPage,
    onReload,
  } = props;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page">审计</h1>
          <p className="desc">密钥管理面操作留痕（module=secret）。平台账号可按租户查询。</p>
        </div>
        <Button size="small" onClick={onReload} loading={loading}>
          刷新
        </Button>
      </div>

      <Alert
        className="banner"
        type="info"
        showIcon
        message={platform ? `审计范围：${tenantId || '全部租户（默认近 30 天）'}` : '审计范围：认证租户'}
        description={
          platform
            ? '平台管理员默认读取全部租户（近 30 天）；可输入租户 ULID 收窄。'
            : '服务端强制使用 JWT 租户查询；非平台账号只能看到本租户事件。'
        }
      />

      {error ? (
        <Alert
          className="banner"
          type="error"
          showIcon
          message="读取审计失败"
          description={`${error}（审计接口要求 audit:read 与 scope=read）`}
        />
      ) : null}

      <Card size="small">
        <Space wrap className="filters">
          {platform ? (
            <AutoComplete
              style={{ width: 320 }}
              placeholder="全部租户（可输入租户 ULID 过滤）"
              value={tenantId}
              options={tenantOptions}
              filterOption={(input, option) =>
                String(option?.value ?? '')
                  .toLowerCase()
                  .includes(input.toLowerCase())
              }
              onChange={(value) => onTenant(value)}
              allowClear
            />
          ) : null}
          <Input
            style={{ width: 200 }}
            placeholder="动作（如 revoke，留空=全部）"
            value={action}
            onChange={(event) => onAction(event.target.value)}
            allowClear
          />
          <span className="hint">起</span>
          <Input type="date" style={{ width: 160 }} value={startDate} onChange={(event) => onStartDate(event.target.value)} />
          <span className="hint">止</span>
          <Input type="date" style={{ width: 160 }} value={endDate} onChange={(event) => onEndDate(event.target.value)} />
          <span className="hint">共 {total} 条</span>
        </Space>
        <Table
          size="small"
          rowKey={(row) => String(row?.id ?? '')}
          dataSource={rows}
          loading={loading}
          pagination={{ current: pageNo, pageSize: 20, total, onChange: (next) => onPage(next), showSizeChanger: false }}
          scroll={{ x: 900 }}
          locale={{ emptyText: <Empty description="没有匹配的审计事件" /> }}
          columns={[
            { title: '时间', dataIndex: 'timestamp', width: 180, render: (value?: number) => fmtTime(value) },
            {
              title: '对象',
              dataIndex: 'target_id',
              ellipsis: true,
              render: (value?: string, row?: AuditLogItem) => (
                <span>
                  <code className="mono small">{value || '—'}</code>
                  {row?.target_type ? <Text type="secondary" className="small"> · {row.target_type}</Text> : null}
                </span>
              ),
            },
            {
              title: '动作',
              dataIndex: 'action',
              width: 160,
              render: (value?: string) => <code className="mono small">{value || '—'}</code>,
            },
            {
              title: '租户',
              dataIndex: 'tenant_id',
              width: 230,
              ellipsis: true,
              render: (value?: string) => {
                if (!value) return '—';
                const name = tenantNames[value];
                return (
                  <Tooltip title={value}>
                    <span>
                      {name || <code className="mono small">{value}</code>}
                      {name ? <div className="hint mono small">{value}</div> : null}
                    </span>
                  </Tooltip>
                );
              },
            },
            {
              title: '操作者',
              dataIndex: 'operator_id',
              width: 220,
              ellipsis: true,
              render: (value?: string) => {
                if (!value) return 'system';
                const name = userNames[value];
                return (
                  <Tooltip title={value}>
                    <span>
                      {name || <code className="mono small">{value}</code>}
                      {name ? <div className="hint mono small">{value}</div> : null}
                    </span>
                  </Tooltip>
                );
              },
            },
            {
              title: '结果',
              dataIndex: 'status',
              width: 100,
              render: (value?: number) => {
                const ok = typeof value !== 'number' || (value >= 200 && value < 400);
                return <Tag color={ok ? 'green' : 'red'}>{ok ? '成功' : String(value ?? '—')}</Tag>;
              },
            },
          ]}
        />
      </Card>
    </>
  );
}
