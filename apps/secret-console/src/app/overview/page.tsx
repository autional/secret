import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, AutoComplete, App, Button, Card, Form, InputNumber, Space, Statistic, Tag, Typography } from 'antd';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AppPageHeader } from '@autional/ui';
import { PageSection } from '@/components/page-section';
import { API_BASE, API_NAMESPACE, AUTH_MODE, DATA_MODE, PLATFORM_TENANT_ID } from '@/lib/config';
import { checkApi, getEncryptionKeys, getSecretPolicy, listAllScopes, listAllSecrets, upsertSecretPolicy } from '@/lib/api';
import type { SecretPolicy, SecretScope } from '@/lib/api';
import { MOCK_SECRETS } from '@/lib/mock';

export default function OverviewPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [stats, setStats] = useState({ total: 0, active: 0, expired: 0, revoked: 0 });
  const [scopes, setScopes] = useState<SecretScope[]>([]);
  const [tenant, setTenant] = useState('');
  const [policy, setPolicy] = useState<SecretPolicy | null>(null);
  const [policyError, setPolicyError] = useState('');
  const [encryptionKey, setEncryptionKey] = useState('');
  const [health, setHealth] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    if (DATA_MODE !== 'api') {
      const active = MOCK_SECRETS.filter((row) => row.status === 'active').length;
      const expired = MOCK_SECRETS.filter((row) => row.status === 'expired').length;
      const revoked = MOCK_SECRETS.filter((row) => row.status === 'revoked').length;
      setStats({ total: MOCK_SECRETS.length, active, expired, revoked });
      const map = new Map<string, SecretScope>();
      for (const row of MOCK_SECRETS) {
        const id = row.tenant_id || '_system';
        const current = map.get(id) ?? { tenant_id: id, app_id: '', secret_count: 0 };
        current.secret_count += 1;
        map.set(id, current);
      }
      setScopes([...map.values()]);
      return;
    }
    const readStats = async () => {
      const [all, active, expired, revoked] = await Promise.all([
        listAllSecrets({ page: 1, page_size: 1 }),
        listAllSecrets({ status: 'active', page: 1, page_size: 1 }),
        listAllSecrets({ status: 'expired', page: 1, page_size: 1 }),
        listAllSecrets({ status: 'revoked', page: 1, page_size: 1 }),
      ]);
      return { total: all.total, active: active.total, expired: expired.total, revoked: revoked.total };
    };
    try {
      setStats(await readStats());
    } catch {
      // 一次瞬时失败（网关抖动 / 令牌续期竞争）不该让统计永远停在 0：隔 1.5s 重试一次。
      window.setTimeout(() => {
        readStats()
          .then(setStats)
          .catch(() => undefined);
      }, 1500);
    }
    try {
      setScopes(await listAllScopes());
    } catch {
      setScopes([]);
    }
    try {
      setEncryptionKey((await getEncryptionKeys()).current);
    } catch {
      /* 缺失不影响主流程 */
    }
    checkApi()
      .then((res) => setHealth({ ok: res.ok, message: res.message }))
      .catch(() => setHealth({ ok: false, message: t('overview.healthFailed') }));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (DATA_MODE !== 'api' || !tenant) {
      setPolicy(null);
      return;
    }
    setPolicyError('');
    getSecretPolicy({ tenantId: tenant })
      .then(setPolicy)
      .catch((err) => setPolicyError(err instanceof Error ? err.message : String(err)));
  }, [tenant]);

  useEffect(() => {
    form.setFieldsValue({
      auto_rotate_days: policy?.auto_rotate_days ?? 0,
      notification_days_before: policy?.notification_days_before ?? 7,
      max_versions: policy?.max_versions ?? 10,
    });
  }, [policy, form]);

  const tenantOptions = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of scopes) {
      const key = row.tenant_id || t('overview.emptyScope');
      map.set(key, (map.get(key) ?? 0) + (row.secret_count ?? 0));
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, label: `${value} (${count})` }));
  }, [scopes, t]);

  const savePolicy = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const next = await upsertSecretPolicy(
        {
          auto_rotate_days: Number(values.auto_rotate_days ?? 0),
          notification_days_before: Number(values.notification_days_before ?? 0),
          max_versions: Number(values.max_versions ?? 10),
        },
        '',
        { tenantId: tenant },
      );
      setPolicy(next);
      message.success(t('overview.policySaved'));
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const cards = [
    { key: 'total', label: t('overview.stat.total'), value: stats.total, hint: t('overview.stat.totalHint') },
    { key: 'active', label: t('overview.stat.active'), value: stats.active, color: 'var(--color-success)' },
    { key: 'expired', label: t('overview.stat.expired'), value: stats.expired, color: 'var(--color-warning)' },
    { key: 'revoked', label: t('overview.stat.revoked'), value: stats.revoked, color: 'var(--color-danger)' },
  ];

  return (
    <>
      <AppPageHeader
        title={t('overview.title')}
        description={t('overview.description')}
        actions={
          <Link to="/secrets">
            <Button type="primary">{t('overview.openList')}</Button>
          </Link>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
        {cards.map((card) => (
          <Card key={card.key} size="small">
            <Statistic title={card.label} value={card.value} valueStyle={card.color ? { color: card.color } : undefined} />
            {card.hint ? <div className="mt-1 text-xs text-[var(--color-text-secondary)]">{card.hint}</div> : null}
          </Card>
        ))}
      </div>

      <div className="mb-6 grid gap-4 xl:grid-cols-[3fr_2fr]">
        <PageSection title={t('overview.policyTitle')}>
          <Space wrap className="mb-3">
            <Typography.Text type="secondary">{t('overview.selectTenant')}</Typography.Text>
            <AutoComplete
              className="w-80"
              placeholder={t('overview.tenantPlaceholder')}
              value={tenant}
              options={tenantOptions}
              filterOption={(input, option) => String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())}
              onChange={setTenant}
              allowClear
            />
            <Button
              type="primary"
              size="small"
              loading={saving}
              disabled={DATA_MODE !== 'api' || !tenant}
              onClick={() => void savePolicy()}
            >
              {t('common.save')}
            </Button>
          </Space>
          {!tenant ? <div className="mb-3 text-xs text-[var(--color-text-secondary)]">{t('overview.policyHint')}</div> : null}
          {policyError ? <Alert className="mb-3" type="warning" showIcon title={t('overview.policyError')} description={policyError} /> : null}
          <Form form={form} layout="inline" className="flex flex-wrap gap-3">
            <Form.Item name="auto_rotate_days" label={t('overview.autoRotate')}>
              <InputNumber min={0} max={36500} className="w-32" disabled={DATA_MODE !== 'api' || !tenant} />
            </Form.Item>
            <Form.Item name="notification_days_before" label={t('overview.notifyBefore')}>
              <InputNumber min={0} max={3650} className="w-28" disabled={DATA_MODE !== 'api' || !tenant} />
            </Form.Item>
            <Form.Item name="max_versions" label={t('overview.maxVersions')}>
              <InputNumber min={1} max={10000} className="w-24" disabled={DATA_MODE !== 'api' || !tenant} />
            </Form.Item>
          </Form>
        </PageSection>

        <PageSection title={t('overview.runtimeTitle')}>
          <div className="space-y-2 text-sm text-[var(--color-text-secondary)]">
            <div className="flex items-center gap-2">
              <span>{t('overview.apiBase')}</span>
              {health ? (
                <Tag color={health.ok ? 'green' : 'red'} title={health.message}>
                  {health.ok ? t('overview.healthOk') : t('overview.healthFailed')}
                </Tag>
              ) : null}
            </div>
            <div>
              <code className="font-mono text-xs">{API_BASE}</code>
            </div>
            <div>
              {t('overview.dataMode')}：{DATA_MODE === 'api' ? t('header.apiMode') : t('header.demoMode')} ·{' '}
              {t('overview.authMode')}：{AUTH_MODE === 'oidc' ? 'OIDC + PKCE' : t('overview.mockAuth')}
            </div>
            <div>
              {t('overview.namespace')}：<Tag color="gold">{API_NAMESPACE}</Tag>
            </div>
            <div>
              {t('overview.encryptionKey')}：<code className="font-mono text-xs">{encryptionKey || '—'}</code>
            </div>
            <div>
              {t('overview.platformTenant')}：<code className="font-mono text-xs">{PLATFORM_TENANT_ID}</code>
            </div>
          </div>
        </PageSection>
      </div>

      <Alert type="info" showIcon title={t('overview.maskTitle')} description={t('overview.maskDescription')} />
    </>
  );
}
