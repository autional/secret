import { useEffect, useState } from 'react';
import { Alert, AutoComplete, Form, Input } from 'antd';
import { useTranslation } from 'react-i18next';
import { Modal } from '@autional/ui/antd';
import type { SecretItem } from '@/lib/api';

export type WriteMode = 'create' | 'edit' | 'rotate' | 'revoke' | 'delete' | 'batch-revoke' | 'batch-delete';
export type WriteState = { mode: WriteMode; row?: SecretItem; keys?: string[] };
export type WriteValues = Record<string, unknown> & { reason?: string };

const TITLE_KEY: Record<WriteMode, string> = {
  create: 'secrets.createTitle',
  edit: 'secrets.editTitle',
  rotate: 'secrets.rotateTitle',
  revoke: 'secrets.revokeTitle',
  delete: 'secrets.deleteTitle',
  'batch-revoke': 'secrets.batchRevoke',
  'batch-delete': 'secrets.batchDelete',
};

/** 写入弹窗：创建 / 改描述 / 轮换 / 吊销 / 删除 / 批量。破坏性操作要求逐字输入确认词。 */
export function SecretWriteDialog(props: {
  state: WriteState | null;
  submitting: boolean;
  tenantOptions: Array<{ value: string; label: string }>;
  appOptions: Array<{ value: string; label: string }>;
  onCancel: () => void;
  onSubmit: (values: WriteValues) => void;
}) {
  const { t } = useTranslation();
  const [form] = Form.useForm<WriteValues>();
  const [confirmText, setConfirmText] = useState('');
  const state = props.state;
  const mode = state?.mode;
  const destructive = mode === 'revoke' || mode === 'delete' || mode === 'batch-revoke' || mode === 'batch-delete';

  useEffect(() => {
    if (!state) return;
    setConfirmText('');
    form.resetFields();
    form.setFieldsValue({
      tenant_id: state.row?.tenant_id ?? '',
      app_id: state.row?.app_id ?? '',
      description: state.row?.description ?? '',
    });
  }, [state, form]);

  const confirmTarget =
    mode === 'revoke' || mode === 'delete'
      ? state?.row?.key ?? ''
      : mode === 'batch-revoke'
        ? 'REVOKE'
        : mode === 'batch-delete'
          ? 'DELETE'
          : '';
  const confirmBlocked = destructive && confirmTarget !== '' && confirmText !== confirmTarget;
  const count = state?.keys?.length ?? 0;

  return (
    <Modal
      open={!!state}
      title={mode ? t(TITLE_KEY[mode]) : ''}
      okText={destructive ? t('common.confirm') : t('common.save')}
      cancelText={t('common.cancel')}
      confirmLoading={props.submitting}
      okButtonProps={{ danger: destructive, disabled: confirmBlocked }}
      onCancel={props.onCancel}
      onOk={() => form.submit()}
      destroyOnHidden
      width={560}
    >
      <Form form={form} layout="vertical" onFinish={(values) => props.onSubmit(values)}>
        {mode === 'create' ? (
          <>
            <Form.Item name="tenant_id" label={t('secrets.col.tenant')} rules={[{ required: true, message: t('secrets.tenantRequired') }]}>
              <AutoComplete
                placeholder={t('secrets.tenantPlaceholder')}
                options={props.tenantOptions}
                filterOption={(input, option) => String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())}
              />
            </Form.Item>
            <Form.Item name="app_id" label={t('secrets.col.app')} extra={t('secrets.appHint')}>
              <AutoComplete placeholder="identity-service" options={props.appOptions} />
            </Form.Item>
            <Form.Item
              name="key"
              label={t('secrets.col.key')}
              rules={[{ required: true, message: t('secrets.keyRequired') }, { max: 512, message: t('secrets.keyMax') }]}
              extra={t('secrets.keyHint')}
            >
              <Input placeholder="db/postgres/password" autoComplete="off" />
            </Form.Item>
            <Form.Item name="value" label={t('secrets.value')} rules={[{ required: true, message: t('secrets.valueRequired') }]} extra={t('secrets.valueHint')}>
              <Input.Password autoComplete="new-password" placeholder={t('secrets.valuePlaceholder')} />
            </Form.Item>
            <Form.Item name="description" label={t('secrets.col.description')}>
              <Input.TextArea rows={2} placeholder={t('secrets.descriptionHint')} />
            </Form.Item>
            <Form.Item name="expires_at" label={t('secrets.expiresAt')} extra={t('secrets.expiresAtHint')}>
              <Input placeholder="2027-01-01" autoComplete="off" />
            </Form.Item>
          </>
        ) : null}


        {mode && mode !== 'create' && state?.row ? (
          <Form.Item label={t('secrets.targetScope')}>
            <Input
              value={`${state.row.tenant_id ?? ''}${state.row.app_id ? ` / ${state.row.app_id}` : ` / ${t('secrets.globalRow')}`} · ${state.row.key}`}
              disabled
            />
          </Form.Item>
        ) : null}

        {mode === 'edit' ? (
          <Form.Item name="description" label={t('secrets.col.description')}>
            <Input.TextArea rows={3} />
          </Form.Item>
        ) : null}

        {mode === 'rotate' ? (
          <Form.Item name="value" label={t('secrets.newValue')} rules={[{ required: true, message: t('secrets.valueRequired') }]} extra={t('secrets.rotateValueHint')}>
            <Input.Password autoComplete="new-password" placeholder={t('secrets.valuePlaceholder')} />
          </Form.Item>
        ) : null}

        {mode === 'revoke' || mode === 'delete' ? (
          <Alert
            className="mb-3"
            type="warning"
            showIcon
            title={mode === 'revoke' ? t('secrets.revokeWarn') : t('secrets.deleteWarn')}
          />
        ) : null}

        {mode === 'batch-revoke' || mode === 'batch-delete' ? (
          <Alert
            className="mb-3"
            type="warning"
            showIcon
            title={t('secrets.batchWarn', { count })}
            description={t('secrets.batchWarnHint')}
          />
        ) : null}

        {destructive && confirmTarget ? (
          <Form.Item
            label={t('secrets.confirmLabel', { target: confirmTarget })}
            required
            validateStatus={confirmBlocked ? 'error' : undefined}
            help={confirmBlocked ? t('secrets.confirmHint') : undefined}
          >
            <Input value={confirmText} onChange={(event) => setConfirmText(event.target.value)} placeholder={confirmTarget} autoComplete="off" />
          </Form.Item>
        ) : null}

        <Form.Item name="reason" label={t('secrets.reasonLabel')} extra={t('secrets.reasonExtra')}>
          <Input placeholder={t('reason.placeholder')} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
