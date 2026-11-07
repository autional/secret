import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { ErrorBoundary, ThemeProvider } from '@autional/ui';
import { AntdThemeProvider } from '@autional/ui/antd';
import App from './App';
import { legacyHashToPath } from './lib/legacy-hash';
import './i18n';
import './styles/globals.css';

// 旧 hash 深链在首帧前转成 path（不给用户看到一次 404 闪屏）
const legacyPath = legacyHashToPath(window.location.hash);
if (legacyPath) window.history.replaceState(null, '', legacyPath);

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ThemeProvider storageKey="secret-console-theme">
        <AntdThemeProvider>
          <ErrorBoundary>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </ErrorBoundary>
        </AntdThemeProvider>
      </ThemeProvider>
    </StrictMode>,
  );
}
