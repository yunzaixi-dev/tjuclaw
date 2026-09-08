import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './scrollbars.css';

const App = lazy(() => import.meta.env.MODE === 'audit' ? import('./audit')
  : location.pathname === '/preview/appearance' ? import('./product')
  : location.pathname.startsWith('/workspace') ? import('./workspace') : import('./auth'));

createRoot(document.getElementById('root')!).render(
  <StrictMode><Suspense fallback={<p role="status">正在打开 TJUClaw...</p>}><App /></Suspense></StrictMode>,
);
