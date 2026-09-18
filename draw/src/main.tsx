import { StrictMode, useCallback, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';

const KEY = 'excalidraw.tjuclaw.cloud';

function loadScene() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function Board() {
  const [initialData] = useState(loadScene);
  const timer = useRef(0);
  const onChange = useCallback((elements: readonly unknown[], appState: { collaborators?: unknown }, files: unknown) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      try {
        const { collaborators: _collaborators, ...rest } = appState;
        localStorage.setItem(KEY, JSON.stringify({ elements, appState: rest, files }));
      } catch {
        // Ignore quota or non-serializable snapshots.
      }
    }, 400);
  }, []);

  return (
    <div style={{ height: '100%', width: '100%' }}>
      <Excalidraw
        langCode="zh-CN"
        theme={window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'}
        initialData={initialData}
        onChange={onChange}
      />
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <Board />
  </StrictMode>,
);
