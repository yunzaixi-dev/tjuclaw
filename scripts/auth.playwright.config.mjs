import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'auth.spec.mjs',
  outputDir: '../test-results/auth',
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: [['list'], ['json', { outputFile: '../test-results/auth/report.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:1423',
    browserName: 'chromium',
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
  webServer: [
    { command: 'node scripts/auth-test-stack.mjs', cwd: '..', url: 'http://127.0.0.1:14434/health/ready', timeout: 120000, reuseExistingServer: false, gracefulShutdown: { signal: 'SIGTERM', timeout: 30000 } },
    {
      command: 'go run ./cmd/api', cwd: '../backend', url: 'http://127.0.0.1:18089/healthz',
      env: {
        HTTP_ADDR: '127.0.0.1:18089',
        KRATOS_PUBLIC_URL: 'http://127.0.0.1:14434',
        APP_PUBLIC_URL: 'http://127.0.0.1:1423',
        TASK_DATA_DIR: '../test-results/auth/task-data',
      },
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @tjuclaw/client exec vite preview --host 127.0.0.1 --port 1423 --strictPort',
      url: 'http://127.0.0.1:1423', env: { API_PROXY_TARGET: 'http://127.0.0.1:18089' }, reuseExistingServer: false,
    },
  ],
});
