import { useEffect, useState } from 'react';
import { Alert, Form, Input } from 'antd';
import { useTranslation } from 'react-i18next';
import { Modal } from '@autional/ui/antd';
import type { SecretItem } from '@/lib/api';

export type SecretFormMode = 'create' | 'rotate' | 'edit';
export type SecretFormValues = { key?: string; value?: string; description?: string };

/** 创建 / 轮换 / 改描述。原因由外层统一收集（写操作都要审计）。 */
export function SecretFormModal(props: {
  mode: SecretFormMode;
  secret?: SecretItem | null;
  open: boolean;
  onCancel: () => void;
  onSubmit: (values: SecretFormValues) => void;
  submitting?: boolean;
}) {
  const { t } = useTranslation();
  const [form] = Form.useForm<SecretFormValues>();

  useEffect(() => {
    if (!props.open) return;
    form.setFieldsValue({
      key: props.secret?.key ?? '',
      value: '',
      description: props.secret?.description ?? '',
    });
  }, [props.open, props.secret, form]);

  const title =
    props.mode === 'create' ? t('secrets.createTitle') : props.mode === 'rotate' ? t('secrets.rotateTitle') : t('secrets.editTitle');

  return (
    <Modal
      open={props.open}
      title={title}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      confirmLoading={props.submitting}
      onCancel={props.onCancel}
      onOk={() => form.submit()}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" onFinish={(values) => props.onSubmit(values)}>
        {props.mode === 'create' ? (
          <Form.Item name="key" label={t('secrets.col.key')} rules={[{ required: true, message: t('secrets.keyRequired') }]}>
            <Input className="font-mono" placeholder="jwt/signing/primary" />
          </Form.Item>
        ) : null}
        {props.mode !== 'edit' ? (
          <Form.Item name="value" label={t('secrets.value')} rules={[{ required: true, message: t('secrets.valueRequired') }]}>
            <Input.TextArea rows={3} className="font-mono" autoComplete="off" />
          </Form.Item>
        ) : null}
        <Form.Item name="description" label={t('secrets.col.description')}>
          <Input maxLength={200} />
        </Form.Item>
        {props.mode === 'rotate' ? <Alert type="warning" showIcon title={t('secrets.rotateHint')} /> : null}
      </Form>
    </Modal>
  );
}
