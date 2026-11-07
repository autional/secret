import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AppPageHeader, EmptyState, SectionCard } from '@autional/ui';

export default function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <>
      <AppPageHeader title={t('notFound.title')} description={t('notFound.description')} />
      <SectionCard>
        <EmptyState title={t('notFound.title')} description={t('notFound.description')} />
        <div className="mt-4 text-center">
          <Link to="/">{t('notFound.back')}</Link>
        </div>
      </SectionCard>
    </>
  );
}
