import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Static SPA build. Deploys to Vercel (or any static host) with zero config:
// build command `npm run build`, output directory `dist`.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
