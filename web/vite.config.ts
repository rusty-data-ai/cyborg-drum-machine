import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Pre-bundling can break onnxruntime-web's import.meta.url wasm resolution.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
})
