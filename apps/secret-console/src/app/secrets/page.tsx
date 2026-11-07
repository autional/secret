import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Empty, Input, Select, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { Plus } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AppPageHeader } from '@autional/ui';
import { DataTable, Drawer, Modal } from '@autional/ui/antd';
import { DATA_MODE, PLATFORM_TENANT_ID } from '@/lib/config';
import {
  batchDeleteSecrets,
  batchRevokeSecrets,
  createSecret,
  deleteSecret,
  getSecretDetail,
  listAllScopes,
  listAllSecrets,
  revealSecretVersion,
  revokeSecret,
  rotateSecret,
  updateSecretMeta,
} from '@/lib/api';
import type { SecretDetail, SecretItem, SecretScope } from '@/lib/api';
import { MOCK_SECRETS } from '@/lib/mock';
import { useSession } from '@/hooks/use-session';
import { SecretWriteDialog } from '@/components/secret-write-dialog';
import type { WriteState, WriteValues } from '@/components/secret-write-dialog';
import { PageSection } from '@/components/page-section';

const PAGE_SIZES = [10, 20, 50, 100];
const DEFAULT_PAGE_SIZE = 20;

const STATUS_COLOR: Record<string, string> = { active: 'green', expired: 'orange', revoked: 'red' };

function fmtTime(value?: string | number | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
}

export default function SecretsPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { session } = useSession();
  const [searchParams] = useSearchParams();

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
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [selected, setSelected] = useState<string[]>([]);

  const [detail, setDetail] = useState<SecretDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [write, setWrite] = useState<WriteState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [revealed, setRevealed] = useState<{ key: string; version: number; value: string } | null>(null);
  const [revealError, setRevealError] = useState('');
  const [revealFor, setRevealFor] = useState<{ row: SecretDetail; version: number } | null>(null);
  const [revealReason, setRevealReason] = useState('');

  // security_admin（且非 super_admin / admin）只读：界面不给写入口，服务端仍兜底 403
  const readOnly = useMemo(() => {
    const roles = session?.user.roles ?? [];
    if (roles.length === 0) return false;
    return roles.includes('security_admin') && !roles.includes('super_admin') && !roles.includes('admin');
  }, [session]);
  const canWrite = DATA_MODE === 'api' && !readOnly;
  const isPlatformSession = session?.user.tenantId === PLATFORM_TENANT_ID;

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
        page_size: pageSize,
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
  }, [tenant, appId, prefix, status, page, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

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
    set.add(PLATFORM_TENANT_ID);
    set.add('_system');
    return [...set].sort().map((value) => ({ value, label: value }));
  }, [scopes]);

  const appOptions = useMemo(() => {
    const set = new Set(scopes.filter((row) => !tenant || row.tenant_id === tenant).map((row) => row.app_id || ''));
    return [...set].filter(Boolean).sort().map((value) => ({ value, label: value }));
  }, [scopes, tenant]);

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

  // 明文只在页面上停留 30 秒（与安全口径一致），关闭抽屉时也清掉
  useEffect(() => {
    if (!revealed) return;
    const timer = window.setTimeout(() => setRevealed(null), 30_000);
    return () => window.clearTimeout(timer);
  }, [revealed]);

  const scopeOf = (row: SecretItem) => ({ tenantId: row.tenant_id || '', appId: row.app_id || undefined });

  const submitWrite = async (values: WriteValues) => {
    if (!write) return;
    const reason = String(values.reason ?? '').trim();
    setSubmitting(true);
    try {
      if (write.mode === 'create') {
        const rawExpiry = String(values.expires_at ?? '').trim();
        const expiresAt = /^\d{4}-\d{2}-\d{2}$/.test(rawExpiry) ? `${rawExpiry}T00:00:00Z` : rawExpiry;
        await createSecret(
          {
            key: String(values.key ?? '').trim(),
            value: String(values.value ?? ''),
            description: String(values.description ?? '').trim() || undefined,
            expires_at: expiresAt || undefined,
            reason,
          },
          { tenantId: String(values.tenant_id ?? '').trim(), appId: String(values.app_id ?? '').trim() || undefined },
        );
        message.success(t('secrets.created'));
      } else if (write.mode === 'edit' && write.row) {
        await updateSecretMeta(write.row.key, { description: String(values.description ?? ''), reason }, scopeOf(write.row));
        message.success(t('secrets.updated'));
      } else if (write.mode === 'rotate' && write.row) {
        await rotateSecret(write.row.key, String(values.value ?? ''), reason, scopeOf(write.row));
        message.success(t('secrets.rotated'));
      } else if (write.mode === 'revoke' && write.row) {
        await revokeSecret(write.row.key, reason, scopeOf(write.row));
        message.success(t('secrets.revoked'));
      } else if (write.mode === 'delete' && write.row) {
        await deleteSecret(write.row.key, reason, scopeOf(write.row));
        message.success(t('secrets.deleted'));
      } else if (write.mode === 'batch-revoke' && write.keys) {
        const res = await batchRevokeSecrets(write.keys, reason);
        message.success(t('secrets.batchDone', { ok: res.succeeded?.length ?? 0, failed: res.errors?.length ?? 0 }));
      } else if (write.mode === 'batch-delete' && write.keys) {
        const res = await batchDeleteSecrets(write.keys, reason);
        message.success(t('secrets.batchDone', { ok: res.succeeded?.length ?? 0, failed: res.errors?.length ?? 0 }));
      }
      setWrite(null);
      if (detail) void openDetail(detail.key);
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const revealVersion = async (row: SecretDetail, version: number, reason: string) => {
    setRevealError('');
    try {
      const res = await revealSecretVersion(row.key, version, reason, {
        tenantId: row.tenant_id || '',
        appId: row.app_id || undefined,
      });
      setRevealed({ key: row.key, version, value: res.value ?? '' });
      setRevealFor(null);
      setRevealReason('');
    } catch (err) {
      setRevealError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <AppPageHeader
        title={t('secrets.title')}
        description={t('secrets.description')}
        actions={
          <Space size={8} wrap>
            {readOnly ? <Tag>{t('header.readOnly')}</Tag> : null}
            {!readOnly && selected.length > 0 ? (
              <>
                <Button danger onClick={() => setWrite({ mode: 'batch-revoke', keys: selected })}>
                  {t('secrets.batchRevokeCount', { count: selected.length })}
                </Button>
                <Button danger onClick={() => setWrite({ mode: 'batch-delete', keys: selected })}>
                  {t('secrets.batchDeleteCount', { count: selected.length })}
                </Button>
              </>
            ) : null}
            {readOnly ? null : (
              <Button type="primary" icon={<Plus size={14} />} disabled={!canWrite} onClick={() => setWrite({ mode: 'create' })}>
                {t('secrets.create')}
              </Button>
            )}
          </Space>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select
          className="w-64"
          allowClear
          showSearch
          value={tenant || undefined}
          onChange={(value) => { setTenant(value ?? ''); setPage(1); }}
          placeholder={t('secrets.filterTenant')}
          options={tenantOptions}
          optionFilterProp="label"
        />
        <Select
          className="w-56"
          allowClear
          showSearch
          value={appId || undefined}
          onChange={(value) => { setAppId(value ?? ''); setPage(1); }}
          placeholder={t('secrets.filterApp')}
          options={appOptions}
          optionFilterProp="label"
        />
        <Input.Search
          className="w-64"
          allowClear
          placeholder={t('secrets.filterPrefix')}
          onSearch={(value) => { setPrefix(value.trim()); setPage(1); }}
        />
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
        {loading ? <Spin size="small" /> : null}
        <Button size="small" onClick={() => void load()} loading={loading}>
          {t('common.refresh')}
        </Button>
      </div>

      {DATA_MODE === 'api' ? (
        <Alert
          className="mb-3"
          type={isPlatformSession ? 'info' : 'warning'}
          showIcon
          title={isPlatformSession ? t('secrets.scopePlatform') : t('secrets.scopeTenant')}
          description={isPlatformSession ? t('secrets.scopePlatformHint') : t('secrets.scopeTenantHint')}
        />
      ) : (
        <Alert className="mb-3" type="info" showIcon title={t('secrets.demoHint')} />
      )}
      {error ? (
        <Alert
          className="mb-3"
          type="error"
          showIcon
          title={t('secrets.listError')}
          description={error}
          action={<Button size="small" onClick={() => void load()}>{t('common.retry')}</Button>}
        />
      ) : null}

      <PageSection>
        <DataTable
          size="small"
          rowKey={(row) => `${row.tenant_id ?? ''}/${row.app_id ?? ''}/${row.key}`}
          dataSource={rows}
          loading={loading}
          scroll={{ x: 'max-content' }}
          rowSelection={readOnly ? undefined : { selectedRowKeys: selected, onChange: (keys) => setSelected(keys.map(String)) }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: PAGE_SIZES,
            showTotal: (count) => t('secrets.total', { count }),
            onChange: (next, size) => {
              setPage(next);
              setPageSize(size);
            },
          }}
          locale={{ emptyText: <Empty description={total === 0 ? t('secrets.emptyAll') : t('secrets.emptyFiltered')} /> }}
          columns={[
            {
              title: t('secrets.col.key'),
              dataIndex: 'key',
              width: '24%',
              render: (value: string, row: SecretItem) => (
                <Button type="link" size="small" onClick={() => void openDetail(row.key)}>
                  <code className="font-mono text-xs">{value}</code>
                </Button>
              ),
            },
            {
              title: t('secrets.col.tenant'),
              dataIndex: 'tenant_id',
              width: 230,
              ellipsis: true,
              render: (value?: string) => <code className="font-mono text-xs">{value || '—'}</code>,
            },
            {
              title: t('secrets.col.app'),
              dataIndex: 'app_id',
              width: 170,
              ellipsis: true,
              render: (value?: string) => (value ? <Tag>{value}</Tag> : <Typography.Text type="secondary">{t('secrets.emptyApp')}</Typography.Text>),
            },
            {
              title: t('secrets.col.status'),
              dataIndex: 'status',
              width: 90,
              render: (value?: string) => <Tag color={STATUS_COLOR[value ?? ''] ?? 'default'}>{t(`secrets.status.${value ?? 'unknown'}`)}</Tag>,
            },
            {
              title: t('secrets.col.version'),
              dataIndex: 'version',
              width: 80,
              render: (value?: number) => (value ? `v${value}` : '—'),
            },
            { title: t('secrets.col.updated'), dataIndex: 'updated_at', width: 170, render: (value?: string) => fmtTime(value) },
            {
              title: t('secrets.col.actions'),
              width: 260,
              render: (_: unknown, row: SecretItem) => (
                <Space size={0} wrap>
                  <Button size="small" type="link" onClick={() => void openDetail(row.key)}>
                    {t('common.view')}
                  </Button>
                  {readOnly ? null : (
                    <>
                      <Button size="small" type="link" disabled={!canWrite || row.status === 'revoked'} onClick={() => setWrite({ mode: 'rotate', row })}>
                        {t('secrets.rotate')}
                      </Button>
                      <Button size="small" type="link" disabled={!canWrite} onClick={() => setWrite({ mode: 'edit', row })}>
                        {t('secrets.editDescription')}
                      </Button>
                      <Button size="small" type="link" danger disabled={!canWrite || row.status === 'revoked'} onClick={() => setWrite({ mode: 'revoke', row })}>
                        {t('secrets.revoke')}
                      </Button>
                      <Button size="small" type="link" danger disabled={!canWrite} onClick={() => setWrite({ mode: 'delete', row })}>
                        {t('common.delete')}
                      </Button>
                    </>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </PageSection>

      <Drawer
        open={!!detail}
        onClose={() => {
          setDetail(null);
          setRevealed(null);
          setRevealError('');
        }}
        size="lg"
        title={detail?.key}
        loading={detailLoading}
        extra={
          detail && !readOnly ? (
            <Space size={0} wrap>
              <Button size="small" type="link" disabled={!canWrite || detail.status === 'revoked'} onClick={() => setWrite({ mode: 'rotate', row: detail })}>
                {t('secrets.rotate')}
              </Button>
              <Button size="small" type="link" disabled={!canWrite} onClick={() => setWrite({ mode: 'edit', row: detail })}>
                {t('secrets.editDescription')}
              </Button>
              <Button size="small" type="link" danger disabled={!canWrite || detail.status === 'revoked'} onClick={() => setWrite({ mode: 'revoke', row: detail })}>
                {t('secrets.revoke')}
              </Button>
              <Button size="small" type="link" danger disabled={!canWrite} onClick={() => setWrite({ mode: 'delete', row: detail })}>
                {t('common.delete')}
              </Button>
            </Space>
          ) : null
        }
      >
        {detail ? (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Typography.Text type="secondary">{t('secrets.col.tenant')}</Typography.Text>
                <div className="font-mono text-xs">{detail.tenant_id || '—'}</div>
              </div>
              <div>
                <Typography.Text type="secondary">{t('secrets.col.app')}</Typography.Text>
                <div>{detail.app_id || t('secrets.globalRow')}</div>
              </div>
              <div>
                <Typography.Text type="secondary">{t('secrets.col.status')}</Typography.Text>
                <div>
                  <Tag color={STATUS_COLOR[detail.status ?? ''] ?? 'default'}>{t(`secrets.status.${detail.status ?? 'unknown'}`)}</Tag>
                </div>
              </div>
              <div>
                <Typography.Text type="secondary">{t('secrets.col.version')}</Typography.Text>
                <div>v{detail.version ?? '—'}</div>
              </div>
              <div>
                <Typography.Text type="secondary">{t('secrets.col.updated')}</Typography.Text>
                <div>{fmtTime(detail.updated_at)}</div>
              </div>
              <div>
                <Typography.Text type="secondary">{t('secrets.expiresAt')}</Typography.Text>
                <div>{fmtTime(detail.expires_at)}</div>
              </div>
            </div>
            <div>
              <Typography.Text type="secondary">{t('secrets.col.description')}</Typography.Text>
              <div>{detail.description || '—'}</div>
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

            <div>
              <div className="mb-2 font-semibold">{t('secrets.versions')}</div>
              {(detail.versions ?? []).length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('secrets.noVersions')} />
              ) : (
                <DataTable
                  size="small"
                  rowKey={(row) => String(row.version)}
                  dataSource={detail.versions ?? []}
                  pagination={false}
                  columns={[
                    { title: t('secrets.col.version'), dataIndex: 'version', width: 90, render: (value: number) => `v${value}` },
                    { title: t('secrets.col.creator'), dataIndex: 'created_by', render: (value?: string) => value || '—' },
                    { title: t('secrets.col.createdAt'), dataIndex: 'created_at', render: (value?: string) => fmtTime(value) },
                    {
                      title: t('secrets.col.actions'),
                      width: 120,
                      render: (_: unknown, row: { version: number }) => (
                        <Button
                          size="small"
                          type="link"
                          disabled={!canWrite}
                          onClick={() => setRevealFor({ row: detail, version: row.version })}
                        >
                          {t('secrets.reveal')}
                        </Button>
                      ),
                    },
                  ]}
                />
              )}
            </div>

            <Alert type="info" showIcon title={t('secrets.maskTitle')} description={t('secrets.maskDescription')} />
          </div>
        ) : null}
      </Drawer>

      <SecretWriteDialog
        state={write}
        submitting={submitting}
        tenantOptions={tenantOptions}
        appOptions={appOptions}
        onCancel={() => setWrite(null)}
        onSubmit={(values) => void submitWrite(values)}
      />

      <Modal
        open={!!revealFor}
        title={t('secrets.revealTitle')}
        okText={t('secrets.reveal')}
        cancelText={t('common.cancel')}
        okButtonProps={{ disabled: !revealReason.trim() || revealReason.trim().length > 200 }}
        onCancel={() => { setRevealFor(null); setRevealReason(''); }}
        onOk={() => revealFor && void revealVersion(revealFor.row, revealFor.version, revealReason.trim())}
        destroyOnHidden
      >
        <Alert className="mb-3" type="warning" showIcon title={t('secrets.revealWarn')} />
        <Input.TextArea
          rows={3}
          maxLength={200}
          showCount
          value={revealReason}
          onChange={(event) => setRevealReason(event.target.value)}
          placeholder={t('secrets.revealReasonPlaceholder')}
        />
      </Modal>
    </>
  );
}
