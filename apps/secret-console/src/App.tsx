import { Route, Routes } from 'react-router';
import Layout from './app/layout';
import OverviewPage from './app/overview/page';
import SecretsPage from './app/secrets/page';
import AuditPage from './app/audit/page';
import NotFoundPage from './app/not-found/page';

/** 路由表（history 模式）。旧 hash 深链由 main.tsx 里的 legacyHashToPath 转换。 */
export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<OverviewPage />} />
        <Route path="secrets" element={<SecretsPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
