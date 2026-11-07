import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AppPageHeader, EmptyState } from '@autional/ui';
import { PageSection } from '@/components/page-section';

export default function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <>
      <AppPageHeader title={t('notFound.title')} description={t('notFound.description')} />
      <PageSection>
        <EmptyState title={t('notFound.title')} description={t('notFound.description')} />
        <div className="mt-4 text-center">
          <Link to="/">{t('notFound.back')}</Link>
        </div>
      </PageSection>
    </>
  );
}
