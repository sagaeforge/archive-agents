// Headless Chromium against the build output. Ports: dev server 4816, fixture server 4819. Started and stopped by global-setup.
import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
// The browser cache is this package's own, reached the way loupe's is: `npm run setup:browsers` fills .cache, or the loupe cache is reused.
const own = path.join(root, '.cache/ms-playwright');
const loupe = path.join(root, '../loupe/.cache/ms-playwright');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= existsSync(own) ? own : loupe;
// WSL has no libnss3 or libasound; loupe's scripts/setup-browser-libs.sh unpacks them without root.
const libsDirs = [path.join(root, '.cache/libs-x/usr/lib/x86_64-linux-gnu'), path.join(root, '../loupe/.cache/libs-x/usr/lib/x86_64-linux-gnu')];
const libs = libsDirs.find((d) => existsSync(d));
const env = libs ? ({ ...process.env, LD_LIBRARY_PATH: [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } as Record<string, string>) : undefined;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  outputDir: '.cache/e2e-results',
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
    viewport: { width: 1440, height: 900 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    trace: 'off',
    screenshot: 'off',
    launchOptions: env ? { env } : {},
  },
});
