import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { auditServer } from './audit-server.ts';

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode === 'audit'
    ? [auditServer(fileURLToPath(new URL('../private/audit/', import.meta.url)))] : [])],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  clearScreen: false,
  server: {
    host: mode === 'audit' ? '127.0.0.1' : process.env.TAURI_DEV_HOST || '127.0.0.1',
    port: mode === 'audit' ? 1421 : 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
    fs: { deny: ['.env', '.env.*', '**/*.{crt,pem,key}', '**/.git/**', '**/private/**', '**/research/**', '**/*.zip'] },
  },
  build: { target: ['es2022', 'chrome105', 'safari15'] },
}));
