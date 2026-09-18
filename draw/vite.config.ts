import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

function excalidrawFonts(): Plugin {
  const from = resolve('node_modules/@excalidraw/excalidraw/dist/prod/fonts');
  const to = resolve('public/fonts');
  return {
    name: 'excalidraw-fonts',
    buildStart() {
      if (!existsSync(from)) return;
      cpSync(from, to, { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), excalidrawFonts()],
  clearScreen: false,
  define: {
    'process.env.IS_PREACT': JSON.stringify('false'),
  },
  server: {
    host: '127.0.0.1',
    port: 5175,
    strictPort: true,
    fs: { deny: ['.env', '.env.*', '**/*.{crt,pem,key}', '**/.git/**'] },
  },
  preview: {
    host: '127.0.0.1',
    port: 4175,
    strictPort: true,
  },
});
