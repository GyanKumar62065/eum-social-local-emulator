import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/_eum/ui/',
  plugins: [preact()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/_eum/api': 'http://localhost:4580' } },
})
