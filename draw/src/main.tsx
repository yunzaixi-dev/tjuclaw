import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Tldraw } from 'tldraw';
import 'tldraw/tldraw.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <div style={{ position: 'fixed', inset: 0 }}>
      <Tldraw
        persistenceKey="draw.tjuclaw.cloud"
        inferDarkMode
        onMount={(editor) => {
          editor.user.updateUserPreferences({ locale: 'zh-cn' });
        }}
      />
    </div>
  </StrictMode>,
);
