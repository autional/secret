import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, AutoComplete, Button, Input, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { AppPageHeader } from '@autional/ui';
import { DataTable } from '@autional/ui/antd';
import { DATA_MODE, PLATFORM_TENANT_ID } from '@/lib/config';
import { getTenant, getUser, listAudit, listTenants } from '@/lib/api';
import type { AuditLogItem } from '@/lib/api';
import { useSession } from '@/hooks/use-session';
import i18n from '@/i18n';
import { PageSection } from '@/components/page-section';

const PAGE_SIZE = 20;

function fmtTime(value?: number | null): string {
  if (!value) return '—';
  const ms = value < 1e12 ? value * 1000 : value;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(i18n.language === 'en-US' ? 'en-US' : 'zh-CN', { hour12: false });
}

export default function AuditPage() {
  const { t } = useTranslation();
  const { session } = useSession();
  const isPlatform = session?.user.tenantId === PLATFORM_TENANT_ID;

  const [rows, setRows] = useState<AuditLogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [tenant, setTenant] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [tenantNames, setTenantNames] = useState<Record<string, string>>({ _system: t('audit.systemTenant') });
  const [userNames, setUserNames] = useState<Record<string, string>>({});
  const [tenantOptions, setTenantOptions] = useState<Array<{ value: string; label: string }>>([]);

  const load = useCallback(async () => {
    if (DATA_MODE !== 'api' || !session) return;
    setLoading(true);
    setError('');
    const base = {
      action: action.trim() || undefined,
      start_date: startDate || undefined,
      end_date: endDate || undefined,
      page,
      page_size: PAGE_SIZE,
    };
    try {
      // 平台账号默认查全部租户（近 30 天）；非平台账号由服务端按 JWT 租户强制过滤
      const res = isPlatform
        ? await listAudit({ ...base, platform: true, tenantId: tenant || '' })
        : await listAudit(base);
      setRows(res.items);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [action, startDate, endDate, page, isPlatform, tenant, session]);

  useEffect(() => {
    void load();
  }, [load]);

  // 租户名（平台会话）：一次拉 100 条做映射，缺失的再按事件补查
  useEffect(() => {
    if (DATA_MODE !== 'api' || !session || !isPlatform) return;
    let alive = true;
    void listTenants()
      .then((list) => {
        if (!alive) return;
        const map: Record<string, string> = { _system: t('audit.systemTenant') };
        for (const item of list) map[item.id] = item.display_name || item.name || item.id;
        setTenantNames(map);
        setTenantOptions(list.map((item) => ({ value: item.id, label: item.display_name || item.name || item.id })));
      })
      .catch(() => {
        /* 解析失败回退显示 ID */
      });
    return () => {
      alive = false;
    };
  }, [session, isPlatform, t]);

  // 缺失的租户名（事件里出现但列表里没有）
  useEffect(() => {
    if (!isPlatform || !rows.length) return;
    const missing = [...new Set(rows.map((row) => row.tenant_id).filter((id): id is string => !!id))].filter(
      (id) => id !== '_system' && !tenantNames[id],
    );
    if (!missing.length) return;
    let alive = true;
    void (async () => {
      const next: Record<string, string> = {};
      for (const id of missing) {
        const item = await getTenant(id);
        if (item) next[id] = item.display_name || item.name || id;
      }
      if (alive && Object.keys(next).length) setTenantNames((prev) => ({ ...prev, ...next }));
    })();
    return () => {
      alive = false;
    };
  }, [rows, isPlatform, tenantNames]);

  // 操作者名（平台账号解析，失败回退事件租户，最后回退 ID）
  useEffect(() => {
    if (!isPlatform || !rows.length) return;
    const missing = [...new Set(rows.map((row) => row.operator_id).filter((id): id is string => !!id))].filter(
      (id) => !userNames[id],
    );
    if (!missing.length) return;
    let alive = true;
    void (async () => {
      const next: Record<string, string> = {};
      for (const id of missing) {
        const row = rows.find((item) => item.operator_id === id);
        const tenantId = row?.tenant_id ?? '';
        // 事件租户是真实租户（非 _system / 非平台）时先按事件租户查，
        // 避免每个租户操作者都先打一次必然 404 的平台请求；平台/系统事件仍平台优先。
        const tenantFirst = !!tenantId && tenantId !== '_system' && tenantId !== PLATFORM_TENANT_ID;
        let user = tenantFirst ? await getUser(id, { tenantId }) : await getUser(id, { tenantId: PLATFORM_TENANT_ID });
        if (!user) {
          user = tenantFirst ? await getUser(id, { tenantId: PLATFORM_TENANT_ID }) : tenantId ? await getUser(id, { tenantId }) : null;
        }
        if (user) next[id] = user.username || user.email || id;
      }
      if (alive && Object.keys(next).length) setUserNames((prev) => ({ ...prev, ...next }));
    })();
    return () => {
      alive = false;
    };
  }, [rows, isPlatform, userNames]);

  const columns = useMemo(
    () => [
      { title: t('audit.col.time'), dataIndex: 'timestamp', width: 180, render: (value?: number) => fmtTime(value) },
      {
        title: t('audit.col.target'),
        dataIndex: 'target_id',
        ellipsis: true,
        render: (value?: string, row?: AuditLogItem) => (
          <span>
            <code className="font-mono text-xs">{value || '—'}</code>
            {row?.target_type ? <Typography.Text type="secondary" className="ml-1 text-xs">· {row.target_type}</Typography.Text> : null}
          </span>
        ),
      },
      {
        title: t('audit.col.action'),
        dataIndex: 'action',
        width: 160,
        render: (value?: string) => <code className="font-mono text-xs">{value || '—'}</code>,
      },
      {
        title: t('audit.col.tenant'),
        dataIndex: 'tenant_id',
        width: 230,
        ellipsis: true,
        render: (value?: string) => {
          if (!value) return '—';
          const name = tenantNames[value];
          return (
            <Tooltip title={value}>
              <span>
                {name || <code className="font-mono text-xs">{value}</code>}
                {name ? <div className="font-mono text-xs text-[var(--color-text-muted)]">{value}</div> : null}
              </span>
            </Tooltip>
          );
        },
      },
      {
        title: t('audit.col.operator'),
        dataIndex: 'operator_id',
        width: 220,
        ellipsis: true,
        render: (value?: string) => {
          if (!value) return 'system';
          const name = userNames[value];
          return (
            <Tooltip title={value}>
              <span>
                {name || <code className="font-mono text-xs">{value}</code>}
                {name ? <div className="font-mono text-xs text-[var(--color-text-muted)]">{value}</div> : null}
              </span>
            </Tooltip>
          );
        },
      },
      {
        title: t('audit.col.result'),
        dataIndex: 'status',
        width: 100,
        render: (value?: number) => {
          const ok = typeof value !== 'number' || (value >= 200 && value < 400);
          return <Tag color={ok ? 'green' : 'red'}>{ok ? t('audit.ok') : String(value ?? '—')}</Tag>;
        },
      },
    ],
    [t, tenantNames, userNames],
  );

  return (
    <>
      <AppPageHeader
        title={t('audit.title')}
        description={t('audit.description')}
        actions={
          <Button size="small" onClick={() => void load()} loading={loading}>
            {t('common.refresh')}
          </Button>
        }
      />

      {DATA_MODE !== 'api' ? (
        <Alert type="info" showIcon title={t('audit.demoHint')} />
      ) : (
        <>
          <Alert
            className="mb-3"
            type="info"
            showIcon
            title={isPlatform ? t('audit.scopePlatform', { tenant: tenant || t('audit.allTenants') }) : t('audit.scopeTenant')}
            description={isPlatform ? t('audit.scopePlatformHint') : t('audit.scopeTenantHint')}
          />

          {error ? (
            <Alert
              className="mb-3"
              type="error"
              showIcon
              title={t('audit.loadFailed')}
              description={t('audit.loadFailedHint', { error })}
              action={<Button size="small" onClick={() => void load()}>{t('common.retry')}</Button>}
            />
          ) : null}

          <div className="mb-3 flex flex-wrap items-center gap-2">
            {isPlatform ? (
              <AutoComplete
                className="w-80"
                allowClear
                placeholder={t('audit.tenantPlaceholder')}
                value={tenant}
                options={tenantOptions}
                filterOption={(input, option) => String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())}
                onChange={(value) => {
                  setTenant(value ?? '');
                  setPage(1);
                }}
              />
            ) : null}
            <Input
              className="w-52"
              allowClear
              placeholder={t('audit.actionPlaceholder')}
              value={action}
              onChange={(event) => {
                setAction(event.target.value);
                setPage(1);
              }}
            />
            <span className="text-sm text-[var(--color-text-secondary)]">{t('audit.from')}</span>
            <Input
              type="date"
              className="w-40"
              value={startDate}
              onChange={(event) => {
                setStartDate(event.target.value);
                setPage(1);
              }}
            />
            <span className="text-sm text-[var(--color-text-secondary)]">{t('audit.to')}</span>
            <Input
              type="date"
              className="w-40"
              value={endDate}
              onChange={(event) => {
                setEndDate(event.target.value);
                setPage(1);
              }}
            />
            <Space size={4}>
              <span className="text-sm text-[var(--color-text-secondary)]">{t('audit.total', { count: total })}</span>
            </Space>
          </div>

          <PageSection>
            <DataTable
              size="small"
              rowKey={(row) => String(row?.id ?? '')}
              dataSource={rows}
              loading={loading}
              columns={columns as any}
              scroll={{ x: 'max-content' }}
              pagination={{
                current: page,
                pageSize: PAGE_SIZE,
                total,
                showSizeChanger: false,
                showTotal: (count) => t('audit.total', { count }),
                onChange: setPage,
              }}
              locale={{ emptyText: t('audit.empty') }}
            />
          </PageSection>
        </>
      )}
    </>
  );
}
