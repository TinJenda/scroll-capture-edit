import { defineConfig } from '@playwright/test';

// The desktop suite drives a real Electron app on the real desktop (screen capture + mouse wheel),
// so it must run one test at a time and the screen should be left alone while it runs.
export default defineConfig({
  testDir: 'tests/e2e-desktop',
  testMatch: /.*\.spec\.ts/,
  timeout: 150_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  webServer: {
    command: 'node tests/e2e/server.mjs',
    url: 'http://127.0.0.1:4173/health',
    reuseExistingServer: true,
    timeout: 20_000,
  },
});
