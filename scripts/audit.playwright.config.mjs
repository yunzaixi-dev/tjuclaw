import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.', testMatch: 'audit-ui.spec.mjs',
  outputDir: '../test-results/audit-ui',
  workers: 1, reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:1424', browserName: 'chromium',
    reducedMotion: 'reduce', screenshot: 'only-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
  webServer: {
    cwd: '..',
    command: 'pnpm --dir frontend exec vite --mode audit --port 1424 --strictPort',
    url: 'http://127.0.0.1:1424', reuseExistingServer: false,
  },
});
