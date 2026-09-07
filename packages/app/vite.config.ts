import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const API_ORIGIN = process.env.NEOHOMEPAGE_DEV_API ?? 'http://127.0.0.1:7575'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
    // The server reads this to inject asset tags into the published generation.
    manifest: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API_ORIGIN, changeOrigin: false },
      '/mcp': { target: API_ORIGIN, changeOrigin: false },
      '/_assets': { target: API_ORIGIN, changeOrigin: false },
    },
  },
})
