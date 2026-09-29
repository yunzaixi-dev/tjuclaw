import { defineConfig } from '@playwright/test';

// Demo screenshots of the built Web client against a mocked, deterministic API.
// Pages load under the product origin so the desktop-only sandbox setting renders.
export default defineConfig({
  testDir: '.', testMatch: 'screenshots.spec.mjs',
  outputDir: '../test-results/screenshots',
  workers: 1, timeout: 60000, reporter: 'list',
  expect: { timeout: 10000 },
  use: {
    browserName: 'chromium', locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
    reducedMotion: 'reduce', serviceWorkers: 'block', screenshot: 'only-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
  webServer: {
    cwd: '..',
    command: 'pnpm --dir frontend exec vite preview --host 127.0.0.1 --port 1425 --strictPort',
    url: 'http://127.0.0.1:1425', reuseExistingServer: false,
  },
});
