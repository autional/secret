import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Input, Popconfirm, Select, Space, Tag, Typography } from 'antd';
import { Plus } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AppPageHeader, SectionCard } from '@autional/ui';
import { DataTable, Drawer } from '@autional/ui/antd';
import { DATA_MODE } from '@/lib/config';
import { useSession } from '@/hooks/use-session';
import {
  batchDeleteSecrets,
  batchRevokeSecrets,
  createSecret,
  deleteSecret,
  getSecretDetail,
  listAllScopes,
  listAllSecrets,
  revokeSecret,
  rotateSecret,
  updateSecretMeta,
  revealSecretVersion,
} from '@/lib/api';
import type { SecretDetail, SecretItem, SecretScope } from '@/lib/api';
import { MOCK_SECRETS } from '@/lib/mock';
import { ReasonModal } from '@/components/reason-modal';
import { SecretFormModal } from '@/components/secret-form-modal';
import type { SecretFormMode, SecretFormValues } from '@/components/secret-form-modal';

const STATUS_COLOR: Record<string, string> = { active: 'green', expired: 'orange', revoked: 'red' };
const PAGE_SIZE = 20;

type PendingAction =
  | { kind: 'create'; values: SecretFormValues }
  | { kind: 'rotate'; row: SecretItem; values: SecretFormValues }
  | { kind: 'edit'; row: SecretItem; values: SecretFormValues }
  | { kind: 'revoke'; row: SecretItem }
  | { kind: 'delete'; row: SecretItem }
  | { kind: 'batchRevoke'; keys: string[] }
  | { kind: 'batchDelete'; keys: string[] }
  | { kind: 'reveal'; row: SecretItem; version: number };

export default function SecretsPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const { session } = useSession();

  const [rows, setRows] = useState<SecretItem[]>(DATA_MODE === 'api' ? [] : MOCK_SECRETS);
  const [total, setTotal] = useState(DATA_MODE === 'api' ? 0 : MOCK_SECRETS.length);
  const [loading, setLoading] = useState(DATA_MODE === 'api');
  const [error, setError] = useState('');
  const [scopes, setScopes] = useState<SecretScope[]>([]);

  const [tenant, setTenant] = useState('');
  const [appId, setAppId] = useState('');
  const [prefix, setPrefix] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);

  const [detail, setDetail] = useState<SecretDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [formMode, setFormMode] = useState<SecretFormMode | null>(null);
  const [formRow, setFormRow] = useState<SecretItem | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<{ key: string; version: number; value: string } | null>(null);
  const [revealError, setRevealError] = useState('');

  const load = useCallback(async () => {
    if (DATA_MODE !== 'api') {
      const filtered = MOCK_SECRETS.filter(
        (row) =>
          (!tenant || row.tenant_id === tenant) &&
          (!appId || row.app_id === appId) &&
          (!prefix || row.key.startsWith(prefix)) &&
          (status === 'all' || row.status === status),
      );
      setRows(filtered);
      setTotal(filtered.length);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await listAllSecrets({
        tenant_id: tenant || undefined,
        app_id: appId || undefined,
        prefix: prefix || undefined,
        status: status === 'all' ? undefined : status,
        page,
        page_size: PAGE_SIZE,
      });
      setRows(res.items);
      setTotal(res.total);
      setSelected([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [tenant, appId, prefix, status, page]);

  useEffect(() => {
    void load();
  }, [load]);

  // 明文只在页面上停留 30 秒（与 README 的安全口径一致），关闭抽屉时也清掉
  useEffect(() => {
    if (!revealed) return;
    const timer = window.setTimeout(() => setRevealed(null), 30_000);
    return () => window.clearTimeout(timer);
  }, [revealed]);

  useEffect(() => {
    if (DATA_MODE !== 'api') {
      const map = new Map<string, SecretScope>();
      for (const row of MOCK_SECRETS) {
        const id = row.tenant_id || '_system';
        const current = map.get(`${id}|${row.app_id}`) ?? { tenant_id: id, app_id: row.app_id ?? '', secret_count: 0 };
        current.secret_count += 1;
        map.set(`${id}|${row.app_id}`, current);
      }
      setScopes([...map.values()]);
      return;
    }
    listAllScopes()
      .then(setScopes)
      .catch(() => setScopes([]));
  }, []);

  const tenantOptions = useMemo(() => {
    const set = new Set(scopes.map((row) => row.tenant_id || '_system'));
    return [...set].sort().map((value) => ({ value, label: value }));
  }, [scopes]);

  const appOptions = useMemo(() => {
    const set = new Set(scopes.filter((row) => !tenant || row.tenant_id === tenant).map((row) => row.app_id || ''));
    return [...set].sort().map((value) => ({ value, label: value || t('secrets.emptyApp') }));
  }, [scopes, tenant, t]);

  const openDetail = useCallback(
    async (key: string) => {
      setDetailLoading(true);
      setRevealed(null);
      setRevealError('');
      try {
        if (DATA_MODE !== 'api') {
          const row = MOCK_SECRETS.find((item) => item.key === key) ?? null;
          setDetail(row ? { ...row, versions: [] } : null);
          return;
        }
        setDetail(await getSecretDetail(key, tenant ? { tenantId: tenant, appId: appId || undefined } : undefined));
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
      } finally {
        setDetailLoading(false);
      }
    },
    [tenant, appId, message],
  );

  // 深链：/secrets?key=xxx 直接打开详情
  useEffect(() => {
    const key = searchParams.get('key');
    if (key) void openDetail(key);
  }, [searchParams, openDetail]);

  const submitForm = (values: SecretFormValues) => {
    const mode = formMode;
    const row = formRow;
    setFormMode(null);
    if (!mode) return;
    if (mode === 'create') setPending({ kind: 'create', values });
    else if (mode === 'rotate' && row) setPending({ kind: 'rotate', row, values });
    else if (mode === 'edit' && row) setPending({ kind: 'edit', row, values });
  };

  const scopeOf = (row: SecretItem) => ({ tenantId: row.tenant_id || '', appId: row.app_id || undefined });

  const runPending = async (reason: string) => {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.kind === 'create') {
        await createSecret(
          { key: String(pending.values.key).trim(), value: String(pending.values.value ?? ''), description: pending.values.description },
          tenant ? { tenantId: tenant, appId: appId || undefined } : undefined,
        );
        message.success(t('secrets.created'));
      } else if (pending.kind === 'rotate') {
        await rotateSecret(pending.row.key, String(pending.values.value ?? ''), reason, scopeOf(pending.row));
        message.success(t('secrets.rotated'));
      } else if (pending.kind === 'edit') {
        await updateSecretMeta(pending.row.key, { description: pending.values.description ?? '', reason }, scopeOf(pending.row));
        message.success(t('secrets.updated'));
      } else if (pending.kind === 'revoke') {
        await revokeSecret(pending.row.key, reason, scopeOf(pending.row));
        message.success(t('secrets.revoked'));
      } else if (pending.kind === 'delete') {
        await deleteSecret(pending.row.key, reason, scopeOf(pending.row));
        message.success(t('secrets.deleted'));
      } else if (pending.kind === 'batchRevoke') {
        const res = await batchRevokeSecrets(pending.keys, reason);
        message.success(t('secrets.batchDone', { ok: res.succeeded?.length ?? 0, failed: res.errors?.length ?? 0 }));
      } else if (pending.kind === 'batchDelete') {
        const res = await batchDeleteSecrets(pending.keys, reason);
        message.success(t('secrets.batchDone', { ok: res.succeeded?.length ?? 0, failed: res.errors?.length ?? 0 }));
      } else if (pending.kind === 'reveal') {
        const res = await revealSecretVersion(pending.row.key, pending.version, reason, scopeOf(pending.row));
        setRevealed({ key: pending.row.key, version: pending.version, value: res.value ?? '' });
      }
      setPending(null);
      if (pending.kind === 'reveal') return;
      if (detail) void openDetail(detail.key);
      await load();
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (pending.kind === 'reveal') setRevealError(text);
      else message.error(text);
      if (pending.kind !== 'reveal') setPending(null);
    } finally {
      setBusy(false);
    }
  };

  const pendingTitle = (() => {
    if (!pending) return '';
    if (pending.kind === 'create') return t('secrets.createTitle');
    if (pending.kind === 'rotate') return t('secrets.rotateTitle');
    if (pending.kind === 'edit') return t('secrets.editTitle');
    if (pending.kind === 'revoke') return t('secrets.revokeTitle');
    if (pending.kind === 'delete') return t('secrets.deleteTitle');
    if (pending.kind === 'batchRevoke') return t('secrets.batchRevoke');
    if (pending.kind === 'batchDelete') return t('secrets.batchDelete');
    return t('secrets.revealTitle');
  })();

  // security_admin（且非 super_admin/admin）只读：界面不给写入口，服务端仍兜底 403
  const readOnly = useMemo(() => {
    const roles = session?.user.roles ?? [];
    if (roles.length === 0) return false;
    return roles.includes('security_admin') && !roles.includes('super_admin') && !roles.includes('admin');
  }, [session]);
  const canWrite = DATA_MODE === 'api' && !readOnly;

  return (
    <>
      <AppPageHeader
        title={t('secrets.title')}
        description={t('secrets.description')}
        actions={
          <Button type="primary" icon={<Plus size={14} />} disabled={!canWrite} onClick={() => { setFormRow(null); setFormMode('create'); }}>
            {t('secrets.create')}
          </Button>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select
          className="w-52"
          value={tenant}
          onChange={(value) => { setTenant(value ?? ''); setPage(1); }}
          allowClear
          placeholder={t('secrets.filterTenant')}
          options={tenantOptions}
        />
        <Select
          className="w-48"
          value={appId}
          onChange={(value) => { setAppId(value ?? ''); setPage(1); }}
          allowClear
          placeholder={t('secrets.filterApp')}
          options={appOptions}
        />
        <Input.Search className="w-64" allowClear placeholder={t('secrets.filterPrefix')} onSearch={(value) => { setPrefix(value.trim()); setPage(1); }} />
        <Select
          className="w-36"
          value={status}
          onChange={(value) => { setStatus(value); setPage(1); }}
          options={[
            { value: 'all', label: t('secrets.statusAll') },
            { value: 'active', label: t('secrets.statusActive') },
            { value: 'expired', label: t('secrets.statusExpired') },
            { value: 'revoked', label: t('secrets.statusRevoked') },
          ]}
        />
        <div className="flex-1" />
        {selected.length ? (
          <Space size={8}>
            <span className="text-sm text-[var(--color-text-secondary)]">{t('secrets.selected', { count: selected.length })}</span>
            <Button size="small" disabled={!canWrite} onClick={() => setPending({ kind: 'batchRevoke', keys: selected })}>
              {t('secrets.batchRevoke')}
            </Button>
            <Button size="small" danger disabled={!canWrite} onClick={() => setPending({ kind: 'batchDelete', keys: selected })}>
              {t('secrets.batchDelete')}
            </Button>
          </Space>
        ) : null}
      </div>

      {!canWrite ? <Alert className="mb-3" type="info" showIcon title={t('secrets.demoHint')} /> : null}
      {error ? <Alert className="mb-3" type="error" showIcon title={error} /> : null}

      <SectionCard padding="none">
        <DataTable
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={rows}
          scroll={{ x: 1100 }}
          rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected(keys as string[]) }}
          pagination={{ current: page, pageSize: PAGE_SIZE, total, showSizeChanger: false, onChange: setPage }}
          onRow={(row) => ({ onClick: () => void openDetail(row.key), style: { cursor: 'pointer' } })}
          columns={[
            { title: t('secrets.col.key'), dataIndex: 'key', render: (value: string) => <code className="font-mono text-xs">{value}</code> },
            { title: t('secrets.col.tenant'), dataIndex: 'tenant_id', width: 200, render: (value: string) => <span className="font-mono text-xs">{value || '—'}</span> },
            { title: t('secrets.col.app'), dataIndex: 'app_id', width: 170, render: (value: string) => value || '—' },
            { title: t('secrets.col.version'), dataIndex: 'version', width: 80 },
            {
              title: t('secrets.col.status'),
              dataIndex: 'status',
              width: 110,
              render: (value: string) => <Tag color={STATUS_COLOR[value ?? ''] ?? 'default'}>{t(`secrets.status.${value}`)}</Tag>,
            },
            { title: t('secrets.col.updated'), dataIndex: 'updated_at', width: 180, render: (value: string) => (value ? new Date(value).toLocaleString() : '—') },
          ]}
        />
      </SectionCard>

      <Drawer open={!!detail} onClose={() => setDetail(null)} size="lg" title={detail?.key} loading={detailLoading}>
        {detail ? (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div><Typography.Text type="secondary">{t('secrets.col.tenant')}</Typography.Text><div className="font-mono text-xs">{detail.tenant_id || '—'}</div></div>
              <div><Typography.Text type="secondary">{t('secrets.col.app')}</Typography.Text><div>{detail.app_id || '—'}</div></div>
              <div><Typography.Text type="secondary">{t('secrets.col.status')}</Typography.Text><div><Tag color={STATUS_COLOR[detail.status ?? ''] ?? 'default'}>{t(`secrets.status.${detail.status}`)}</Tag></div></div>
              <div><Typography.Text type="secondary">{t('secrets.col.version')}</Typography.Text><div>{detail.version}</div></div>
            </div>
            <div>
              <Typography.Text type="secondary">{t('secrets.col.description')}</Typography.Text>
              <div>{detail.description || '—'}</div>
            </div>

            <Space size={8} wrap>
              <Button size="small" disabled={!canWrite} onClick={() => { setFormRow(detail); setFormMode('rotate'); }}>{t('secrets.rotate')}</Button>
              <Button size="small" disabled={!canWrite} onClick={() => { setFormRow(detail); setFormMode('edit'); }}>{t('secrets.editDescription')}</Button>
              <Popconfirm title={t('secrets.revokeConfirm')} onConfirm={() => setPending({ kind: 'revoke', row: detail })}>
                <Button size="small" disabled={!canWrite}>{t('secrets.revoke')}</Button>
              </Popconfirm>
              <Popconfirm title={t('secrets.deleteConfirm')} onConfirm={() => setPending({ kind: 'delete', row: detail })}>
                <Button size="small" danger disabled={!canWrite}>{t('common.delete')}</Button>
              </Popconfirm>
            </Space>

            <div>
              <div className="mb-2 font-semibold">{t('secrets.versions')}</div>
              <DataTable
                size="small"
                rowKey={(row) => String(row.version)}
                dataSource={detail.versions ?? []}
                pagination={false}
                locale={{ emptyText: t('secrets.noVersions') }}
                columns={[
                  { title: t('secrets.col.version'), dataIndex: 'version', width: 90 },
                  { title: t('secrets.col.status'), dataIndex: 'status', width: 110, render: (value: string) => <Tag color={STATUS_COLOR[value ?? ''] ?? 'default'}>{value || '—'}</Tag> },
                  { title: t('secrets.col.createdAt'), dataIndex: 'created_at', width: 180, render: (value: string) => (value ? new Date(value).toLocaleString() : '—') },
                  {
                    title: '',
                    width: 100,
                    render: (_: unknown, row: { version: number }) => (
                      <Button size="small" type="link" disabled={!canWrite} onClick={() => setPending({ kind: 'reveal', row: detail, version: row.version })}>
                        {t('secrets.reveal')}
                      </Button>
                    ),
                  },
                ]}
              />
            </div>

            {revealed ? (
              <Alert
                type="success"
                showIcon
                title={t('secrets.revealedTitle', { version: revealed.version })}
                description={<code className="break-all font-mono text-xs">{revealed.value}</code>}
              />
            ) : null}
            {revealError ? <Alert type="error" showIcon title={revealError} /> : null}
            <Alert type="info" showIcon title={t('secrets.maskTitle')} description={t('secrets.maskDescription')} />
          </div>
        ) : null}
      </Drawer>

      <SecretFormModal
        mode={formMode ?? 'create'}
        open={!!formMode}
        secret={formRow}
        submitting={busy}
        onCancel={() => setFormMode(null)}
        onSubmit={submitForm}
      />

      {pending ? (
        <ReasonModal
          title={pendingTitle}
          description={<Alert type="warning" showIcon title={t('secrets.reasonHint')} />}
          confirmText={pending.kind === 'reveal' ? t('secrets.reveal') : t('common.confirm')}
          danger={pending.kind === 'delete' || pending.kind === 'batchDelete'}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={(reason) => void runPending(reason)}
        />
      ) : null}
    </>
  );
}
