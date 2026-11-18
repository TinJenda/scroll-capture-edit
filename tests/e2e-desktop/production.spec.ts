import { _electron as electron, expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Smoke test of the real, production SnapFlow.exe (the one that gets zipped for testers).
// Run:  $env:SNAPFLOW_PROD_EXE='release\SnapFlow-<version>-win32-x64\SnapFlow.exe'; npx playwright test -c playwright.desktop.config.ts production
const exe = process.env.SNAPFLOW_PROD_EXE;

test.describe('production build', () => {
  test.skip(!exe, 'set SNAPFLOW_PROD_EXE to the unpacked SnapFlow.exe to run this');

  test('starts, captures the screen, and exposes no automation hooks', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'snapflow-prod-'));
    const app = await electron.launch({ executablePath: path.resolve(exe as string), args: [`--user-data-dir=${userData}`] });
    try {
      const launcher = await app.waitForEvent('window', { predicate: (w) => w.url().includes('/launcher/'), timeout: 30_000 }).catch(() => app.windows().find((w) => w.url().includes('/launcher/')));
      expect(launcher, 'launcher window').toBeTruthy();
      await expect(launcher!.locator('.tile')).toHaveCount(4);

      // No test hooks in the production bundle, even with the env var set by someone.
      expect(await app.evaluate(() => (globalThis as Record<string, unknown>).__snapflowTest)).toBeUndefined();

      await launcher!.locator('.tile', { has: launcher!.locator('strong', { hasText: /^Full screen$/ }) }).click();
      const preview = await app.waitForEvent('window', { predicate: (w) => w.url().includes('/preview/'), timeout: 30_000 });
      await preview.waitForSelector('[data-testid="preview-image"]');
      const dims = await preview.locator('[data-testid="preview-image"]').evaluate((img) => ({ w: (img as HTMLImageElement).naturalWidth, h: (img as HTMLImageElement).naturalHeight }));
      expect(dims.w).toBeGreaterThan(600);
      expect(dims.h).toBeGreaterThan(400);

      // koffi (the native module used for the mouse wheel) must be loadable from the packaged app.
      const koffiVersion = await app.evaluate(({ app: electronApp }) => {
        const { createRequire } = process.getBuiltinModule('node:module');
        return (createRequire(electronApp.getAppPath() + '/')('koffi') as { version: string }).version;
      });
      expect(koffiVersion).toMatch(/^\d+\./);
    } finally {
      await app.close().catch(() => undefined);
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });
});
