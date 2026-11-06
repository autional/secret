import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { completeLogin, restoreSession, signOut, startLogin } from './lib/auth';
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
  listAppScopes,
  listAudit,
  listSecrets,
  revokeSecret,
  rotateSecret,
  updateSecretMeta,
  upsertSecretPolicy,
} from './lib/api';
import type { ApiHealth, AuditLogItem, SecretDetail, SecretItem, SecretPolicy, SecretVersion } from './lib/api';
import { clearScope, defaultScope, isCrossTenant, resolveScope, saveScope, SYSTEM_TENANT } from './lib/scope';
import type { Scope } from './lib/scope';
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

type WriteState = { mode: WriteMode; key?: string; keys?: string[] };

/** 占位密钥（仅元数据；不含任何真实密钥值）。 */
const MOCK_SECRETS: SecretItem[] = [
  {
    id: 'sec_01JDEMO000000000000000001',
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
    key: 'db/postgres/app',
    description: 'PostgreSQL 应用账号口令',
    version: 7,
    status: 'active',
    created_at: '2025-12-02T03:20:00Z',
    updated_at: '2026-09-18T11:40:00Z',
    expires_at: null,
  },
  {
    id: 'sec_01JDEMO000000000000000003',
    key: 'oauth/client/default',
    description: '默认 OAuth 客户端密钥',
    version: 2,
    status: 'revoked',
    created_at: '2026-03-05T06:15:00Z',
    updated_at: '2026-08-01T02:05:00Z',
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

/** 顶层只负责挂 antd 的 App 上下文，业务状态在 Console。 */
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
  const [stats, setStats] = useState({ active: 0, revoked: 0, expired: 0 });

  const [scope, setScope] = useState<Scope>(() => resolveScope());
  const [scopeDraft, setScopeDraft] = useState<Scope>(() => resolveScope());
  const [appOptions, setAppOptions] = useState<{ value: string; label: string }[]>([]);

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
  const [auditAction, setAuditAction] = useState('all');

  const needsLogin = !session && (REQUIRE_AUTH || DATA_MODE === 'api');
  const crossTenant = isCrossTenant(scope);
  /** 只读角色（security_admin 且非超管/管理员）。令牌未带 roles 时不判定，交由服务端 403 兜底。 */
  const readOnly = useMemo(() => {
    const roles = session?.user.roles ?? [];
    if (roles.length === 0) return false;
    return roles.includes('security_admin') && !roles.includes('super_admin') && !roles.includes('admin');
  }, [session]);
  /** 平台管理员：审计页按数据作用域跨租户查询（服务端 /platform/logs）。 */
  const platformAudit = DATA_MODE === 'api' && session?.user.tenantId === PLATFORM_TENANT_ID;

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
      const res = await listSecrets({
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
  }, [prefix, statusFilter, pageNo, pageSize]);

  const loadStats = useCallback(async () => {
    if (DATA_MODE !== 'api') return;
    try {
      const [active, revoked, expired] = await Promise.all([
        listSecrets({ status: 'active', page: 1, page_size: 1 }),
        listSecrets({ status: 'revoked', page: 1, page_size: 1 }),
        listSecrets({ status: 'expired', page: 1, page_size: 1 }),
      ]);
      setStats({ active: active.total, revoked: revoked.total, expired: expired.total });
    } catch {
      /* 统计失败不打断主流程 */
    }
  }, []);

  const loadPolicy = useCallback(async () => {
    if (DATA_MODE !== 'api') return;
    setPolicyError('');
    try {
      setPolicy(await getSecretPolicy());
    } catch (err) {
      setPolicyError(errorText(err));
    }
    try {
      setEncryptionKey((await getEncryptionKeys()).current);
    } catch {
      /* 密钥环信息缺失不影响主流程 */
    }
  }, []);

  const loadAudit = useCallback(async () => {
    if (DATA_MODE !== 'api') return;
    setAuditLoading(true);
    setAuditError('');
    const base = {
      action: auditAction === 'all' ? undefined : auditAction,
      page: auditPage,
      page_size: 20,
    };
    try {
      let res;
      if (session?.user.tenantId === PLATFORM_TENANT_ID) {
        // 平台管理员：按当前数据作用域跨租户查询；端点不可用（403/旧版本）时回退租户视角。
        try {
          res = await listAudit({ ...base, platform: true, tenantId: scope.tenantId });
        } catch (err) {
          const status = (err as { status?: number })?.status;
          // 403：角色不足；404：audit-service 旧版本尚无该端点 → 回退租户视角。
          if (status !== 403 && status !== 404) throw err;
          res = await listAudit(base);
        }
      } else {
        res = await listAudit(base);
      }
      setAuditRows(res.items);
      setAuditTotal(res.total);
    } catch (err) {
      setAuditError(errorText(err));
      setAuditRows([]);
      setAuditTotal(0);
    } finally {
      setAuditLoading(false);
    }
  }, [auditAction, auditPage, session, scope.tenantId]);

  /* 登录态 */
  useEffect(() => {
    let alive = true;
    void bootstrapAuth().then((result) => {
      if (!alive) return;
      setAuthError(result.error);
      setSession(result.session);
      setAuthReady(true);
      if (result.session) {
        const next = defaultScope();
        setScope(next);
        setScopeDraft(next);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  /* 401 → 清会话 */
  useEffect(() => {
    const onUnauthorized = () => {
      void signOut().then(() => {
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
  }, [authReady, session, scope]);

  /* 列表 / 统计 / 策略 */
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
    void loadStats();
    void loadPolicy();
  }, [authReady, session, scope, loadStats, loadPolicy]);

  /* 应用作用域枚举：切换租户后刷新（供 X-App-ID 选择器） */
  useEffect(() => {
    if (!authReady || !session || DATA_MODE !== 'api') {
      setAppOptions([]);
      return;
    }
    let alive = true;
    void listAppScopes()
      .then((rows) => {
        if (!alive) return;
        setAppOptions(
          rows.map((row) => ({
            value: row.app_id,
            label: `${row.app_id}（${row.secret_count} 条）`,
          })),
        );
      })
      .catch(() => {
        if (alive) setAppOptions([]);
      });
    return () => {
      alive = false;
    };
  }, [authReady, session, scope]);

  /* 审计：进入页面或筛选变化时加载 */
  useEffect(() => {
    if (page !== 'audit' || !authReady || !session) return;
    void loadAudit();
  }, [page, authReady, session, scope, loadAudit]);

  /* 详情：登录后补拉 */
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
    void getSecretDetail(viewing.key)
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

  const applyScope = () => {
    const next = saveScope(scopeDraft);
    setScope(next);
    setScopeDraft(next);
    setPageNo(1);
    setSelectedKeys([]);
    setViewing(null);
    message.success(`数据作用域：${next.tenantId}${next.appId ? ` / ${next.appId}` : ' / （app 为空）'}`);
  };

  const resetScope = () => {
    const next = defaultScope();
    const saved = saveScope(next);
    setScope(saved);
    setScopeDraft(saved);
    setPageNo(1);
    message.info('已恢复为登录会话默认作用域');
  };

  /* -------------------------------- 写入 -------------------------------- */

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
          // 只填日期时补成 UTC 零点，避免后端 RFC3339 解析 400。
          const expiresAt = /^\d{4}-\d{2}-\d{2}$/.test(rawExpiry) ? `${rawExpiry}T00:00:00Z` : rawExpiry;
          await createSecret({
            key: String(values.key ?? '').trim(),
            value: String(values.value ?? ''),
            description: String(values.description ?? '').trim() || undefined,
            expires_at: expiresAt || undefined,
            reason,
          });
          message.success('已创建密钥');
          break;
        }
        case 'edit': {
          if (!write.key) return;
          const description = String(values.description ?? '').trim();
          if (!description && !reason) {
            message.error('描述与变更原因至少填一项');
            setWriteLoading(false);
            return;
          }
          await updateSecretMeta(write.key, { description, reason });
          message.success('已更新元信息');
          break;
        }
        case 'rotate': {
          if (!write.key) return;
          await rotateSecret(write.key, String(values.value ?? ''), reason);
          message.success(`已轮换 ${write.key}`);
          break;
        }
        case 'revoke': {
          if (!write.key) return;
          await revokeSecret(write.key, reason);
          message.success(`已吊销 ${write.key}`);
          break;
        }
        case 'delete': {
          if (!write.key) return;
          await deleteSecret(write.key, reason);
          message.success(`已删除 ${write.key}`);
          break;
        }
        case 'batch-revoke': {
          const result = await batchRevokeSecrets(write.keys ?? [], reason);
          const failed = result.errors?.length ?? 0;
          if (failed) message.warning(`批量吊销：成功 ${result.succeeded?.length ?? 0}，失败 ${failed}`);
          else message.success(`已吊销 ${result.succeeded?.length ?? 0} 条`);
          break;
        }
        case 'batch-delete': {
          const result = await batchDeleteSecrets(write.keys ?? [], reason);
          const failed = result.errors?.length ?? 0;
          if (failed) message.warning(`批量删除：成功 ${result.succeeded?.length ?? 0}，失败 ${failed}`);
          else message.success(`已删除 ${result.succeeded?.length ?? 0} 条`);
          break;
        }
      }
      setWrite(null);
      setSelectedKeys([]);
      await loadSecrets();
      await loadStats();
      if (viewing) {
        const stillVisible = write.mode !== 'delete' && write.mode !== 'revoke';
        if (stillVisible) setViewing({ key: viewing.key });
      }
    } catch (err) {
      message.error(errorText(err));
    } finally {
      setWriteLoading(false);
    }
  };

  const savePolicy = async (input: { auto_rotate_days?: number; notification_days_before?: number; max_versions?: number }) => {
    try {
      setPolicy(await upsertSecretPolicy(input));
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
          label: (
            <div className="hint">
              会话租户 {session.user.tenantId || '（令牌未带）'} · 数据作用域 {scope.tenantId}
              {scope.appId ? ` / ${scope.appId}` : ''}
            </div>
          ),
        },
        { type: 'divider' },
        {
          key: 'reset-scope',
          label: '恢复默认作用域',
          onClick: resetScope,
        },
        { key: 'logout', label: '退出登录', danger: true },
      ]
    : [];

  const filtered = secrets;

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
          type={crossTenant ? 'warning' : 'info'}
          showIcon
          message={crossTenant ? '跨租户作用域' : '密钥中心'}
          description={
            <Space size={10} wrap>
              <ApiBadge health={health} />
              <span className="hint">
                API：<code className="mono">{API_BASE}</code>
              </span>
              <span className="hint">
                X-Tenant-ID：<code className="mono">{scope.tenantId}</code>
              </span>
              <span className="hint">
                X-App-ID：<code className="mono">{scope.appId || '（空）'}</code>
              </span>
              {crossTenant ? <span className="hint">跨租户需要平台 super_admin / admin；否则服务端 403。</span> : null}
              {health.message ? <span className="hint">{health.message}</span> : null}
            </Space>
          }
        />

        <ScopeBar
          draft={scopeDraft}
          current={scope}
          appOptions={appOptions}
          onChange={setScopeDraft}
          onApply={applyScope}
          onReset={resetScope}
          loading={listLoading}
        />

        {page === 'overview' ? (
          <Overview
            stats={stats}
            total={total}
            policy={policy}
            policyError={policyError}
            encryptionKey={encryptionKey}
            health={health}
            readOnly={readOnly}
            onSavePolicy={savePolicy}
            onOpenSecrets={() => go('secrets')}
          />
        ) : null}

        {page === 'secrets' ? (
          <SecretsPage
            rows={filtered}
            total={total}
            loading={listLoading}
            error={listError}
            prefix={prefixInput}
            status={statusFilter}
            pageNo={pageNo}
            pageSize={pageSize}
            selectedKeys={selectedKeys}
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
            onPage={(next, size) => {
              setPageNo(next);
              setPageSize(size);
            }}
            onReload={() => void loadSecrets()}
            onView={openDetail}
            onSelected={setSelectedKeys}
            readOnly={readOnly}
            onCreate={() => openWrite({ mode: 'create' })}
            onEdit={(row) => openWrite({ mode: 'edit', key: row.key }, { description: row.description ?? '' })}
            onRotate={(row) => openWrite({ mode: 'rotate', key: row.key }, { key: row.key })}
            onRevoke={(row) => openWrite({ mode: 'revoke', key: row.key }, { key: row.key })}
            onDelete={(row) => openWrite({ mode: 'delete', key: row.key }, { key: row.key })}
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
            platform={platformAudit}
            tenantId={scope.tenantId}
            onAction={(value) => {
              setAuditAction(value);
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
                { key: 'desc', label: '描述', children: viewing.description || detail?.description || '—' },
                { key: 'status', label: '状态', children: statusTag(viewing.status ?? detail?.status) },
                { key: 'version', label: '当前版本', children: `v${viewing.version ?? detail?.version ?? '—'}` },
                { key: 'app', label: '应用作用域', children: viewing.app_id || detail?.app_id || '（空）' },
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
                  <Button size="small" onClick={() => openWrite({ mode: 'rotate', key: viewing.key }, { key: viewing.key })}>
                    轮换
                  </Button>
                  <Button size="small" onClick={() => openWrite({ mode: 'edit', key: viewing.key }, { description: viewing.description ?? '' })}>
                    改描述
                  </Button>
                  <Button size="small" danger onClick={() => openWrite({ mode: 'revoke', key: viewing.key }, { key: viewing.key })}>
                    吊销
                  </Button>
                  <Button size="small" danger onClick={() => openWrite({ mode: 'delete', key: viewing.key }, { key: viewing.key })}>
                    删除
                  </Button>
                </Space>
              )}
            </div>

            <h3 className="sub-title">版本</h3>
            <VersionTable versions={detail?.versions ?? []} />

            <Alert
              className="banner top-gap"
              type="warning"
              showIcon
              message="密钥值不在本界面展示"
              description="本版本只提供元数据与版本号；明文读取接口（/versions/value）有意未接入。"
            />
          </>
        ) : null}
      </Drawer>

      <WriteDialog
        state={write}
        form={form}
        loading={writeLoading}
        onCancel={() => setWrite(null)}
        onSubmit={() => void submitWrite()}
      />
    </Layout>
  );
}

/* ------------------------------ 作用域栏 ------------------------------ */

function ScopeBar(props: {
  draft: Scope;
  current: Scope;
  appOptions: { value: string; label: string }[];
  loading: boolean;
  onChange: (next: Scope) => void;
  onApply: () => void;
  onReset: () => void;
}) {
  const { draft, current, appOptions, loading, onChange, onApply, onReset } = props;
  const preset = [PLATFORM_TENANT_ID, SYSTEM_TENANT].includes(draft.tenantId) ? draft.tenantId : 'custom';
  const dirty = draft.tenantId !== current.tenantId || draft.appId !== current.appId;

  return (
    <Card size="small" className="scope-card">
      <Space wrap size={10} align="center">
        <Text type="secondary">数据作用域</Text>
        <Select
          style={{ width: 200 }}
          value={preset}
          onChange={(value) => {
            if (value === 'custom') {
              onChange({ ...draft, tenantId: preset === 'custom' ? draft.tenantId : '' });
              return;
            }
            onChange({ ...draft, tenantId: value });
          }}
          options={[
            { value: PLATFORM_TENANT_ID, label: '平台租户（platform）' },
            { value: SYSTEM_TENANT, label: '系统租户（_system，服务密钥）' },
            { value: 'custom', label: '指定租户…' },
          ]}
        />
        {preset === 'custom' ? (
          <Input
            style={{ width: 260 }}
            placeholder="租户 ULID（如 01K...）"
            value={draft.tenantId}
            onChange={(event) => onChange({ ...draft, tenantId: event.target.value })}
            allowClear
          />
        ) : null}
        <AutoComplete
          style={{ width: 260 }}
          placeholder="应用作用域 X-App-ID（如 secret-service）"
          value={draft.appId}
          options={appOptions}
          filterOption={(input, option) =>
            String(option?.value ?? '')
              .toLowerCase()
              .includes(input.toLowerCase())
          }
          onChange={(value) => onChange({ ...draft, appId: value })}
          allowClear
        />
        <Button type="primary" size="small" disabled={!dirty || !draft.tenantId.trim()} loading={loading} onClick={onApply}>
          应用
        </Button>
        <Button size="small" onClick={onReset}>
          恢复默认
        </Button>
        <span className="hint">
          服务密钥：租户 <code className="mono">_system</code> + 应用 <code className="mono">&lt;服务名&gt;</code>
        </span>
      </Space>
    </Card>
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
          <p className="desc">需要 Autional 管理面账号（super_admin / admin）与 secret:admin 权限。</p>
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
  stats: { active: number; revoked: number; expired: number };
  total: number;
  policy: SecretPolicy | null;
  policyError: string;
  encryptionKey: string;
  health: HealthState;
  readOnly: boolean;
  onSavePolicy: (input: { auto_rotate_days?: number; notification_days_before?: number; max_versions?: number }) => void;
  onOpenSecrets: () => void;
}) {
  const { stats, total, policy, policyError, encryptionKey, health, readOnly, onSavePolicy, onOpenSecrets } = props;
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
          <p className="desc">平台级密钥盘点：跨租户切换作用域，服务密钥位于 _system 租户。</p>
        </div>
        <Button type="primary" onClick={onOpenSecrets}>
          进入密钥列表
        </Button>
      </div>

      <Row gutter={12} className="stats">
        <Col span={6}>
          <Card size="small">
            <Statistic title="密钥总数（当前作用域）" value={total} />
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
            title="密钥策略"
            extra={
              <Button
                size="small"
                type="primary"
                disabled={readOnly}
                loading={saving}
                onClick={() => {
                  setSaving(true);
                  void form.validateFields().then((values) => {
                    onSavePolicy({
                      auto_rotate_days: Number(values.auto_rotate_days ?? 0),
                      notification_days_before: Number(values.notification_days_before ?? 0),
                      max_versions: Number(values.max_versions ?? 10),
                    });
                    setSaving(false);
                  }).catch(() => setSaving(false));
                }}
              >
                保存
              </Button>
            }
          >
            {policyError ? <Alert className="banner" type="warning" showIcon message="策略读取失败" description={policyError} /> : null}
            <Form form={form} layout="inline" className="policy-form">
              <Form.Item name="auto_rotate_days" label="自动轮换（天，0=不自动）">
                <InputNumber min={0} max={36500} style={{ width: 140 }} />
              </Form.Item>
              <Form.Item name="notification_days_before" label="提前提醒（天）">
                <InputNumber min={0} max={3650} style={{ width: 120 }} />
              </Form.Item>
              <Form.Item name="max_versions" label="版本保留数">
                <InputNumber min={1} max={10000} style={{ width: 100 }} />
              </Form.Item>
            </Form>
            <div className="hint top-gap">策略按租户保存；切换作用域后请重新查看。</div>
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
        message="本界面不展示密钥值"
        description="密钥值只写不读；创建 / 轮换使用新值覆盖，历史版本只保留版本号与创建者。"
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
  pageNo: number;
  pageSize: number;
  selectedKeys: string[];
  readOnly: boolean;
  onPrefix: (value: string) => void;
  onSearch: () => void;
  onStatus: (value: string) => void;
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
    pageNo,
    pageSize,
    selectedKeys,
    readOnly,
    onPrefix,
    onSearch,
    onStatus,
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
      width: '30%',
      render: (value: string, row) => (
        <Button type="link" size="small" className="key-link" onClick={() => onView(row)}>
          <code className="mono key-cell">{value}</code>
        </Button>
      ),
    },
    { title: '描述', dataIndex: 'description', ellipsis: true, render: (value?: string) => <Text type="secondary">{value || '—'}</Text> },
    { title: '版本', dataIndex: 'version', width: 70, render: (value?: number) => (value ? `v${value}` : '—') },
    { title: '状态', dataIndex: 'status', width: 90, render: (value?: string) => statusTag(value) },
    { title: '到期', dataIndex: 'expires_at', width: 170, render: (value?: string | null) => fmtTime(value) },
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
          <p className="desc">元数据与版本；密钥值只写不读。服务密钥请切到 _system + 服务名。</p>
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
          <Input.Search
            allowClear
            placeholder="按前缀搜索密钥路径…"
            style={{ width: 280 }}
            value={prefix}
            onChange={(event) => onPrefix(event.target.value)}
            onSearch={() => onSearch()}
          />
          <Select
            style={{ width: 150 }}
            value={status}
            onChange={onStatus}
            options={[
              { value: 'all', label: '全部状态' },
              { value: 'active', label: '生效中' },
              { value: 'expired', label: '已过期' },
              { value: 'revoked', label: '已撤销' },
            ]}
          />
          <span className="hint">共 {total} 条</span>
          <div className="grow" />
          {loading ? <Spin size="small" /> : null}
          <Button size="small" onClick={onReload} loading={loading}>
            刷新
          </Button>
        </Space>

        <Table
          size="small"
          rowKey={(row) => row.key}
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
          scroll={{ x: 1080 }}
          locale={{ emptyText: <Empty description="当前作用域下没有密钥" /> }}
        />
      </Card>
    </>
  );
}

function VersionTable({ versions }: { versions: SecretVersion[] }) {
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
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { state, form, loading, onCancel, onSubmit } = props;
  const mode = state?.mode;
  const destructive = mode === 'revoke' || mode === 'delete' || mode === 'batch-revoke' || mode === 'batch-delete';
  const count = state?.keys?.length ?? 0;

  return (
    <Modal
      open={!!state}
      title={mode ? WRITE_TITLE[mode] : ''}
      onCancel={onCancel}
      onOk={onSubmit}
      okText={destructive ? '确认' : '保存'}
      okButtonProps={{ danger: destructive, loading }}
      destroyOnHidden
      width={560}
    >
      <Form form={form} layout="vertical">
        {mode === 'create' ? (
          <>
            <Form.Item
              name="key"
              label="密钥路径"
              rules={[{ required: true, message: '请输入密钥路径' }, { max: 512, message: '最多 512 字符' }]}
              extra="建议使用斜杠分层路径，如 db/postgres/password。"
            >
              <Input placeholder="db/postgres/password" autoComplete="off" />
            </Form.Item>
            <Form.Item name="value" label="密钥值" rules={[{ required: true, message: '请输入密钥值' }]} extra="只写不读；创建后只能轮换，不能回看。">
              <Input.Password autoComplete="new-password" placeholder="输入密钥值" />
            </Form.Item>
            <Form.Item name="description" label="描述">
              <Input.TextArea rows={2} placeholder="用途 / 消费方" />
            </Form.Item>
            <Form.Item name="expires_at" label="到期时间（可选）" extra="ISO 时间，如 2027-01-01T00:00:00Z。">
              <Input placeholder="2027-01-01T00:00:00Z" autoComplete="off" />
            </Form.Item>
          </>
        ) : null}

        {mode === 'edit' ? (
          <>
            <Form.Item label="密钥路径">
              <Input value={state?.key} disabled />
            </Form.Item>
            <Form.Item name="description" label="描述">
              <Input.TextArea rows={3} />
            </Form.Item>
          </>
        ) : null}

        {mode === 'rotate' ? (
          <>
            <Form.Item label="密钥路径">
              <Input value={state?.key} disabled />
            </Form.Item>
            <Form.Item name="value" label="新密钥值" rules={[{ required: true, message: '请输入新密钥值' }]} extra="轮换会推进版本；旧版本保留但不可读取。">
              <Input.Password autoComplete="new-password" placeholder="输入新密钥值" />
            </Form.Item>
          </>
        ) : null}

        {mode === 'revoke' || mode === 'delete' ? (
          <>
            <Form.Item label="密钥路径">
              <Input value={state?.key} disabled />
            </Form.Item>
            <Alert
              className="banner"
              type="warning"
              showIcon
              message={mode === 'revoke' ? '吊销后无法再获取该密钥值' : '删除为软删除，保留期后永久清除'}
            />
          </>
        ) : null}

        {mode === 'batch-revoke' || mode === 'batch-delete' ? (
          <Alert
            className="banner"
            type="warning"
            showIcon
            message={`将${mode === 'batch-revoke' ? '吊销' : '删除'} ${count} 条密钥`}
            description={mode === 'batch-revoke' ? '吊销后无法再获取这些密钥值。' : '软删除，保留期后永久清除。'}
          />
        ) : null}

        <Form.Item name="reason" label="变更原因（可选）" extra="当前写入审计事件的 X-Change-Reason 头；服务端落库待波 2。">
          <Input placeholder="例如：季度轮换 / 凭据泄露应急处置" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/* -------------------------------- 审计 -------------------------------- */

const AUDIT_ACTIONS = [
  'all',
  'admin_list',
  'admin_detail',
  'store',
  'update',
  'rotate',
  'revoke',
  'delete',
  'batch_revoke',
  'batch_delete',
  'policy_upsert',
];

function AuditPage(props: {
  rows: AuditLogItem[];
  total: number;
  loading: boolean;
  error: string;
  pageNo: number;
  action: string;
  platform: boolean;
  tenantId: string;
  onAction: (value: string) => void;
  onPage: (page: number) => void;
  onReload: () => void;
}) {
  const { rows, total, loading, error, pageNo, action, platform, tenantId, onAction, onPage, onReload } = props;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page">审计</h1>
          <p className="desc">密钥管理面操作留痕（module=secret）。租户由登录令牌决定。</p>
        </div>
        <Button size="small" onClick={onReload} loading={loading}>
          刷新
        </Button>
      </div>

      <Alert
        className="banner"
        type="info"
        showIcon
        message={platform ? `审计范围：平台跨租户 · ${tenantId}` : '审计范围：认证租户'}
        description={
          platform
            ? '平台管理员按当前数据作用域读取目标租户的审计事件（服务端 /platform/logs，要求 super_admin/admin）。'
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
          <Select
            style={{ width: 200 }}
            value={action}
            onChange={onAction}
            options={AUDIT_ACTIONS.map((value) => ({ value, label: value === 'all' ? '全部动作' : value }))}
          />
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
            { title: '操作者', dataIndex: 'operator_id', width: 200, ellipsis: true, render: (value?: string) => value || '—' },
            {
              title: '动作',
              dataIndex: 'action',
              width: 160,
              render: (value?: string) => <code className="mono small">{value || '—'}</code>,
            },
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
