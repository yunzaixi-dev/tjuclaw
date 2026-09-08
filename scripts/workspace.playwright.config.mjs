import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'workspace.spec.mjs',
  outputDir: '../test-results/workspace',
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: [['list'], ['json', { outputFile: '../test-results/workspace/report.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:1424',
    browserName: 'chromium',
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
  webServer: [
    {
      command: 'pnpm --filter @tjuclaw/client exec vite preview --host 127.0.0.1 --port 1424 --strictPort',
      url: 'http://127.0.0.1:1424',
      reuseExistingServer: false,
    },
  ],
});
