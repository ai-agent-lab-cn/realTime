import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/local-electron.spec.ts',
  reporter: 'list',
  outputDir: 'work/local-electron-results',
  workers: 1,
})
