import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
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
