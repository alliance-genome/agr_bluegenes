// Playwright configuration for the BlueGenes end-to-end tests in e2e/.
// These are being ported from the Cypress suite in cypress/ one spec at a
// time; both suites expect BlueGenes on BLUEGENES_URL (default
// http://localhost:5000) connected to a local Biotestmine (see docs/building.md).
const { defineConfig, devices } = require('@playwright/test');

// Keep any deploy path (e.g. http://localhost:5000/foo/bar) by making sure the
// base URL ends in a slash; specs navigate with relative paths.
const baseURL = (process.env.BLUEGENES_URL || 'http://localhost:5000').replace(/\/?$/, '/');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 60000,
  expect: { timeout: 30000 },
  retries: 2,
  reporter: [
    ['list'],
    ['junit', { outputFile: 'e2e/results/output.xml' }],
  ],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
