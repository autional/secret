import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Dropdown,
  Empty,
  Input,
  Layout,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { MenuProps, TableProps } from 'antd';
import { API_BASE, AUTH_MODE, DATA_MODE, isCallbackPath, OIDC, PLATFORM_URL, REQUIRE_AUTH, RUNTIME_MODE_LABEL } from './lib/config';
import { completeLogin, restoreSession, signOut, startLogin } from './lib/auth';
import type { Session } from './lib/auth';
import { UNAUTHORIZED_EVENT, checkApi, getSecretDetail, listSecrets } from './lib/api';
import type { ApiHealth, SecretDetail, SecretItem, SecretVersion } from './lib/api';
import './styles.css';

const { Text } = Typography;

type Page = 'overview' | 'secrets' | 'audit';

type HealthState = { state: 'checking' | 'ok' | 'error' | 'mock'; message: string };

/** 占位密钥（仅元数据；不含任何真实密钥值）。api 模式会尝试用只读接口替换。 */
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
    status: 'active',
    created_at: '2026-03-05T06:15:00Z',
    updated_at: '2026-08-01T02:05:00Z',
    expires_at: '2027-08-01T02:05:00Z',
  },
  {
    id: 'sec_01JDEMO000000000000000004',
    key: 'sms/provider/sign',
    description: '短信服务商签名密钥',
    version: 1,
    status: 'expired',
    created_at: '2025-06-11T09:00:00Z',
    updated_at: '2025-06-11T09:00:00Z',
    expires_at: '2026-06-11T09:00:00Z',
  },
  {
    id: 'sec_01JDEMO000000000000000005',
    key: 'storage/oss/access',
    description: '对象存储访问凭据（历史版本）',
    version: 4,
    status: 'revoked',
    created_at: '2025-02-19T07:30:00Z',
    updated_at: '2026-04-22T10:10:00Z',
    expires_at: null,
  },
];

/** 占位审计事件。 */
type AuditRow = { id: string; time: string; actor: string; action: string; target: string; result: string };

const MOCK_AUDIT: AuditRow[] = [
  { id: 'a1', time: '2026-11-06 10:12:31', actor: '密钥中心管理员', action: 'admin_list', target: '*', result: '成功' },
  { id: 'a2', time: '2026-11-05 18:44:02', actor: '密钥中心管理员', action: 'admin_detail', target: 'jwt/signing/primary', result: '成功' },
  { id: 'a3', time: '2026-11-04 09:03:17', actor: 'system', action: 'rotate', target: 'db/postgres/app', result: '成功' },
  { id: 'a4', time: '2026-11-02 15:28:55', actor: '安全审计员', action: 'admin_list', target: '*', result: '成功' },
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

function parseHash(): Page {
  const raw = window.location.hash.replace(/^#\/?/, '').split('?')[0].replace(/\/+$/, '');
  if (raw === 'secrets') return 'secrets';
  if (raw === 'audit') return 'audit';
  return 'overview';
}

function hashOf(page: Page): string {
  return page === 'overview' ? '#/' : `#/${page}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fmtTime(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
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
      // OIDC 回调页：用 code + PKCE 换票，然后清掉 URL 上的 code/state（避免刷新重放授权码）。
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

/** 顶层只负责挂 antd 的 App 上下文，业务状态在 Console（这样 Console 内可用 useApp 的 message）。 */
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
  const [page, setPage] = useState<Page>(() => parseHash());
  const [health, setHealth] = useState<HealthState>({ state: 'checking', message: '' });

  const [secrets, setSecrets] = useState<SecretItem[]>(MOCK_SECRETS);
  const [listLoading, setListLoading] = useState(DATA_MODE === 'api');
  const [listError, setListError] = useState('');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const [viewing, setViewing] = useState<SecretItem | null>(null);
  const [detail, setDetail] = useState<SecretDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const needsLogin = !session && (REQUIRE_AUTH || DATA_MODE === 'api');

  const loadSecrets = useCallback(async () => {
    if (DATA_MODE !== 'api') {
      setSecrets(MOCK_SECRETS);
      setListError('');
      setListLoading(false);
      return;
    }
    setListLoading(true);
    setListError('');
    try {
      const rows = await listSecrets({ page: 1, page_size: 50 });
      setSecrets(rows);
    } catch (err) {
      setListError(errorText(err));
      setSecrets(MOCK_SECRETS);
    } finally {
      setListLoading(false);
    }
  }, []);

  /* 登录态：处理 OIDC 回调（换票）或恢复已有会话。 */
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

  /* 令牌失效（401）→ 清会话、回登录态。 */
  useEffect(() => {
    const onUnauthorized = () => {
      void signOut().then(() => setSession(null));
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  /* 路由：hash 变化（含浏览器前进/后退）。 */
  useEffect(() => {
    const onHash = () => setPage(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  /* API 连通性探测：登录后执行一次。mock 模式不发起网络请求。 */
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

  /* 列表：api 模式需要已登录；mock 模式直接使用占位数据。 */
  useEffect(() => {
    if (!authReady) return;
    if (DATA_MODE === 'api' && !session) {
      setListLoading(false);
      return;
    }
    void loadSecrets();
  }, [authReady, session, loadSecrets]);

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
    setSession(null);
    setViewing(null);
    message.success('已退出登录');
  };

  const openDetail = async (row: SecretItem) => {
    setViewing(row);
    setDetail(null);
    setDetailError('');
    if (DATA_MODE !== 'api') return;
    setDetailLoading(true);
    try {
      setDetail(await getSecretDetail(row.key));
    } catch (err) {
      setDetailError(errorText(err));
    } finally {
      setDetailLoading(false);
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
              租户 {session.user.tenantId || '（令牌未带）'} · 应用 {session.user.appId || '平台'}
            </div>
          ),
        },
        { type: 'divider' },
        { key: 'logout', label: '退出登录', danger: true },
      ]
    : [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return secrets.filter((row) => {
      const statusOk = statusFilter === 'all' || (row.status ?? '').toLowerCase() === statusFilter;
      const textOk =
        !q ||
        [row.key, row.description ?? '', row.id ?? '', row.app_id ?? ''].some((value) => value.toLowerCase().includes(q));
      return statusOk && textOk;
    });
  }, [secrets, query, statusFilter]);

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
          <Tag color="gold">建设中</Tag>
          <Tag color={DATA_MODE === 'api' ? 'blue' : 'default'}>{RUNTIME_MODE_LABEL}</Tag>
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
          <a className="platform-link" href={PLATFORM_URL} target="_blank" rel="noreferrer">
            返回平台
          </a>
        </Space>
      </Layout.Header>

      <Layout.Content className="wrap">
        <Alert
          className="banner"
          type="info"
          showIcon
          message="密钥中心建设中"
          description={
            <Space size={10} wrap>
              <ApiBadge health={health} />
              <span className="hint">
                API：<code className="mono">{API_BASE}</code>
              </span>
              {health.message ? <span className="hint">{health.message}</span> : null}
            </Space>
          }
        />

        {page === 'overview' ? <Overview health={health} /> : null}
        {page === 'secrets' ? (
          <SecretsPage
            rows={filtered}
            total={secrets.length}
            loading={listLoading}
            error={listError}
            query={query}
            status={statusFilter}
            onQuery={setQuery}
            onStatus={setStatusFilter}
            onReload={() => void loadSecrets()}
            onView={(row) => void openDetail(row)}
          />
        ) : null}
        {page === 'audit' ? <AuditPage /> : null}
      </Layout.Content>

      <Drawer open={!!viewing} width={560} title="密钥详情" onClose={() => setViewing(null)} destroyOnHidden>
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
                { key: 'app', label: '应用', children: viewing.app_id || detail?.app_id || '平台' },
                { key: 'expires', label: '到期时间', children: fmtTime(viewing.expires_at ?? detail?.expires_at) },
                { key: 'created', label: '创建时间', children: fmtTime(viewing.created_at ?? detail?.created_at) },
                { key: 'updated', label: '更新时间', children: fmtTime(viewing.updated_at ?? detail?.updated_at) },
              ]}
            />

            <h3 className="sub-title">版本</h3>
            <VersionTable versions={detail?.versions ?? []} />

            <Alert
              className="banner top-gap"
              type="warning"
              showIcon
              message="密钥值不在本界面展示"
              description="创建 / 轮换 / 撤销等写入能力尚未开放；当前仅提供只读占位。"
            />
          </>
        ) : null}
      </Drawer>
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
          <p className="desc">密钥服务管理面需要 Autional 账号登录；当前版本为只读占位。</p>
          {error ? <Alert className="banner" type="error" showIcon message={error} /> : null}
          <Space size={12} wrap>
            <Button type="primary" onClick={onLogin}>
              使用 Autional 账号登录
            </Button>
            <a className="platform-link" href={PLATFORM_URL} target="_blank" rel="noreferrer">
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

/* -------------------------------- 概览 -------------------------------- */

const OVERVIEW_STATS = [
  { title: '密钥总数', value: 128, hint: '占位' },
  { title: '生效中', value: 120, hint: '占位' },
  { title: '30 天内到期', value: 6, hint: '占位' },
  { title: '待轮换', value: 2, hint: '占位' },
];

function Overview({ health }: { health: HealthState }) {
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page">密钥中心概览</h1>
          <p className="desc">集中查看密钥元数据、版本与到期情况；本版本为只读占位。</p>
        </div>
      </div>

      <Row gutter={12} className="stats">
        {OVERVIEW_STATS.map((item) => (
          <Col span={6} key={item.title}>
            <Card size="small">
              <Statistic title={item.title} value={item.value} />
              <Text type="secondary" className="hint">
                {item.hint}
              </Text>
            </Card>
          </Col>
        ))}
      </Row>

      <Alert
        className="banner top-gap"
        type="warning"
        showIcon
        message="统计为占位数据"
        description="接入密钥服务后，这里会展示真实的密钥数量、到期与轮换提醒。"
      />

      <Row gutter={12} className="top-gap">
        <Col span={14}>
          <Card size="small" title="能力规划">
            <ol className="struct">
              <li>
                <b>密钥列表</b>：按前缀 / 状态筛选，只展示元数据。
              </li>
              <li>
                <b>密钥详情</b>：版本历史、创建者、到期时间。
              </li>
              <li>
                <b>轮换与撤销</b>：写入能力规划中（需权限点与变更原因）。
              </li>
              <li>
                <b>审计</b>：读取 / 轮换 / 撤销事件留痕。
              </li>
            </ol>
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
              <div className="hint">数据模式：{RUNTIME_MODE_LABEL} · 鉴权：{AUTH_MODE === 'oidc' ? 'OIDC + PKCE' : '演示会话'}</div>
              <div className="hint">当前版本不展示密钥值，也不提供写入操作。</div>
            </Space>
          </Card>
        </Col>
      </Row>
    </>
  );
}

/* -------------------------------- 密钥 -------------------------------- */

function SecretsPage(props: {
  rows: SecretItem[];
  total: number;
  loading: boolean;
  error: string;
  query: string;
  status: string;
  onQuery: (value: string) => void;
  onStatus: (value: string) => void;
  onReload: () => void;
  onView: (row: SecretItem) => void;
}) {
  const { rows, total, loading, error, query, status, onQuery, onStatus, onReload, onView } = props;

  const columns: TableProps<SecretItem>['columns'] = [
    {
      title: '密钥路径',
      dataIndex: 'key',
      width: '32%',
      render: (value: string) => <code className="mono key-cell">{value}</code>,
    },
    { title: '描述', dataIndex: 'description', ellipsis: true, render: (value?: string) => <Text type="secondary">{value || '—'}</Text> },
    { title: '版本', dataIndex: 'version', width: 80, render: (value?: number) => (value ? `v${value}` : '—') },
    { title: '状态', dataIndex: 'status', width: 100, render: (value?: string) => statusTag(value) },
    { title: '更新时间', dataIndex: 'updated_at', width: 190, render: (value?: string) => fmtTime(value) },
    {
      title: '操作',
      width: 90,
      render: (_: unknown, row: SecretItem) => (
        <Button size="small" type="link" onClick={() => onView(row)}>
          查看
        </Button>
      ),
    },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page">密钥</h1>
          <p className="desc">只读占位列表：展示密钥元数据，不展示密钥值。</p>
        </div>
      </div>

      <Alert
        className="banner"
        type="info"
        showIcon
        message="只读占位"
        description="创建 / 轮换 / 撤销 / 删除等写入能力尚未开放；接入后需要权限点与变更原因。"
      />

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
            placeholder="搜索密钥路径 / 描述…"
            style={{ width: 280 }}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
          <Select
            style={{ width: 160 }}
            value={status}
            onChange={onStatus}
            options={[
              { value: 'all', label: '全部状态' },
              { value: 'active', label: '生效中' },
              { value: 'expired', label: '已过期' },
              { value: 'revoked', label: '已撤销' },
            ]}
          />
          <span className="hint">
            共 {total} 条（当前筛选 {rows.length} 条）{DATA_MODE === 'mock' ? ' · 占位数据' : ''}
          </span>
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
          pagination={{ pageSize: 20, showSizeChanger: false }}
          scroll={{ x: 900 }}
          locale={{ emptyText: <Empty description="没有匹配的密钥（占位）" /> }}
        />
      </Card>
    </>
  );
}

function VersionTable({ versions }: { versions: SecretVersion[] }) {
  if (!versions.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无版本信息（占位）" />;
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

/* -------------------------------- 审计 -------------------------------- */

function AuditPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page">审计</h1>
          <p className="desc">密钥读取与变更事件的审计留痕（占位）。</p>
        </div>
      </div>

      <Alert
        className="banner"
        type="info"
        showIcon
        message="审计为占位"
        description="接入密钥服务后，这里会展示 admin_list / admin_detail / rotate / revoke 等审计事件。"
      />

      <Card size="small">
        <Table
          size="small"
          rowKey="id"
          dataSource={MOCK_AUDIT}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          columns={[
            { title: '时间', dataIndex: 'time', width: 190 },
            { title: '操作者', dataIndex: 'actor', width: 180 },
            { title: '动作', dataIndex: 'action', width: 160, render: (value: string) => <code className="mono small">{value}</code> },
            { title: '对象', dataIndex: 'target', render: (value: string) => <code className="mono small">{value}</code> },
            {
              title: '结果',
              dataIndex: 'result',
              width: 100,
              render: (value: string) => <Tag color={value === '成功' ? 'green' : 'default'}>{value}</Tag>,
            },
          ]}
        />
      </Card>
    </>
  );
}
