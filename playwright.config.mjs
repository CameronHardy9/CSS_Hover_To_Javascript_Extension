import { defineConfig } from '@playwright/test';

export default defineConfig({
  testMatch: '**/*.spec.mjs',
  timeout: 30_000,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  projects: [
    {
      name: 'unit',
      testDir: 'tests/unit',
      fullyParallel: true,
      use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } },
    },
    {
      // Loads the unpacked extension; needs a persistent context, see tests/e2e/fixtures.mjs.
      name: 'e2e',
      testDir: 'tests/e2e',
      workers: 2,
      timeout: 60_000,
    },
  ],
});
