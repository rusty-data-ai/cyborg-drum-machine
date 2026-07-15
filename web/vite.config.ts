import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Pre-bundling can break onnxruntime-web's import.meta.url wasm resolution.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  // Unit tests only — e2e/*.spec.ts belong to Playwright.
  test: { include: ['src/**/*.test.ts'] },
})
