import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/electron.spec.ts',
  reporter: 'list',
  outputDir: 'work/electron-results',
})
