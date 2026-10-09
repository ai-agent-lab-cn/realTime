import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
export default defineConfig({
  base: './',
  plugins: [vue()],
  server: { port: 5187, strictPort: true },
  test: { include: ['tests/unit/**/*.test.ts'] },
})
