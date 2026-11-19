import { Navigate, Route, Routes, useLocation } from 'react-router';
import Layout from './app/layout';
import OverviewPage from './app/overview/page';
import SecretsPage from './app/secrets/page';
import AuditPage from './app/audit/page';
import NotFoundPage from './app/not-found/page';
import { rootDeepLinkTarget } from './lib/root-deeplink';

/**
 * 根路径：`/?key=<KEY>` 视同 `/secrets?key=<KEY>`（旧链接/通知链接兼容）。
 * 无 key 时保持原有渲染（概览页）；`replace` 避免回退键在两条路径间来回跳。
 */
function RootPage() {
  const { search, hash } = useLocation();
  const target = rootDeepLinkTarget(search, hash);
  if (target) return <Navigate to={target} replace />;
  return <OverviewPage />;
}

/** 路由表（history 模式）。旧 hash 深链由 main.tsx 里的 legacyHashToPath 转换。 */
export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<RootPage />} />
        <Route path="secrets" element={<SecretsPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
