import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/browser.spec.ts',
  use: {
    channel: 'chrome',
    baseURL: 'http://127.0.0.1:5187',
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5187',
    reuseExistingServer: !process.env.CI,
  },
  reporter: [['list']],
  outputDir: 'work/test-results',
})
