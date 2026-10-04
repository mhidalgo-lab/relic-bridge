// SPDX-License-Identifier: Apache-2.0
// P4-11: the admin panel in a real browser (Chromium only). Run with `pnpm test:e2e`; it is not part of `pnpm test`
// and not run on every pull request (see docs/dev/admin-ui.md). `pnpm e2e:screenshots` also writes the guide images.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: { actionTimeout: 10_000, navigationTimeout: 20_000 },
  reporter: [['list']],
  globalSetup: './global-setup.ts',
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    // 320 px is the narrowest phone the layout promises to hold (WCAG reflow).
    {
      name: 'mobile-320',
      use: { ...devices['Pixel 5'], viewport: { width: 320, height: 640 }, deviceScaleFactor: 1 },
    },
  ],
});
