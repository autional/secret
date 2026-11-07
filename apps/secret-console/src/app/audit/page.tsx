import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Input, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { AppPageHeader, SectionCard } from '@autional/ui';
import { DataTable, DateRangeFilter } from '@autional/ui/antd';
import { DATA_MODE, PLATFORM_TENANT_ID } from '@/lib/config';
import { listAudit } from '@/lib/api';
import type { AuditLogItem } from '@/lib/api';
import { useSession } from '@/hooks/use-session';

const PAGE_SIZE = 20;

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
  const [range, setRange] = useState<[string, string] | null>(null);

  const load = useCallback(async () => {
    if (DATA_MODE !== 'api') return;
    setLoading(true);
    setError('');
    try {
      const base = {
        action: action.trim() || undefined,
        start_date: range?.[0],
        end_date: range?.[1],
        page,
        page_size: PAGE_SIZE,
      };
      const res = isPlatform
        ? await listAudit({ ...base, platform: true, tenantId: tenant || '_system' })
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
  }, [action, range, page, isPlatform, tenant]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <AppPageHeader title={t('audit.title')} description={t('audit.description')} />

      {DATA_MODE !== 'api' ? (
        <Alert type="info" showIcon title={t('audit.demoHint')} />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Input.Search className="w-56" allowClear placeholder={t('audit.filterAction')} onSearch={(value) => { setAction(value); setPage(1); }} />
            {isPlatform ? (
              <Input.Search className="w-64" allowClear placeholder={t('audit.filterTenant')} onSearch={(value) => { setTenant(value); setPage(1); }} />
            ) : null}
            <DateRangeFilter
              value={range}
              onChange={(value) => {
                setRange(value);
                setPage(1);
              }}
            />
            <div className="flex-1" />
            <Button onClick={() => void load()}>{t('common.retry')}</Button>
          </div>

          {error ? <Alert className="mb-3" type="error" showIcon title={error} /> : null}

          <SectionCard padding="none">
            <DataTable
              size="small"
              rowKey="id"
              loading={loading}
              dataSource={rows}
              scroll={{ x: 1000 }}
              pagination={{ current: page, pageSize: PAGE_SIZE, total, showSizeChanger: false, onChange: setPage }}
              columns={[
                {
                  title: t('audit.col.time'),
                  dataIndex: 'timestamp',
                  width: 180,
                  render: (value: number) => (value ? new Date(value * (value < 1e12 ? 1000 : 1)).toLocaleString() : '—'),
                },
                { title: t('audit.col.action'), dataIndex: 'action', width: 180, render: (value: string) => <Tag>{value || '—'}</Tag> },
                { title: t('audit.col.tenant'), dataIndex: 'tenant_id', width: 200, render: (value: string) => <span className="font-mono text-xs">{value || '—'}</span> },
                { title: t('audit.col.target'), dataIndex: 'target_id', render: (value: string) => <span className="font-mono text-xs">{value || '—'}</span> },
                { title: t('audit.col.operator'), dataIndex: 'operator_id', width: 200, render: (value: string) => <span className="font-mono text-xs">{value || '—'}</span> },
                { title: t('audit.col.message'), dataIndex: 'message', ellipsis: true },
              ]}
            />
          </SectionCard>
        </>
      )}
    </>
  );
}
