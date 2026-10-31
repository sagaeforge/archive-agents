// Headless Chromium against the build output (design 11). Ports 4830-4834 only. Everything is started and stopped by global-setup.
import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(root, '.cache/ms-playwright');
// WSL has no libnss3 or libasound: scripts/setup-browser-libs.sh unpacks them without root.
const libs = path.join(root, '.cache/libs-x/usr/lib/x86_64-linux-gnu');
const env = existsSync(libs) ? { ...process.env, LD_LIBRARY_PATH: [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } as Record<string, string> : undefined;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  outputDir: process.env.LOUPE_E2E_OUT ?? '.cache/e2e-results',
  globalSetup: './e2e/support/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [['line']],
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
    viewport: { width: 1360, height: 860 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    trace: 'off',
    screenshot: 'off',
    launchOptions: env ? { env } : {},
  },
});
