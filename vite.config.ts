import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import type { Connect } from 'vite'

// A tiny dev-only middleware so POST /api/analyze works under `npm run dev`,
// mirroring the Vercel serverless function in api/analyze.ts. The server module
// is loaded via ssrLoadModule so the Anthropic SDK stays server-side and is
// never bundled into the client.
function devApi(): import('vite').Plugin {
  return {
    name: 'dev-api-analyze',
    apply: 'serve',
    configureServer(server) {
      const handler: Connect.NextHandleFunction = async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('Method not allowed')
          return
        }
        try {
          const chunks: Buffer[] = []
          for await (const c of req) chunks.push(c as Buffer)
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          const mod = await server.ssrLoadModule('/src/server/analyze.ts')
          const result = await mod.runAnalyze(body)
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(result))
        } catch (e: any) {
          const status = e?.name === 'AnalyzeError' && typeof e.status === 'number' ? e.status : 500
          res.statusCode = status
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: e?.message || 'Server error' }))
        }
      }
      server.middlewares.use('/api/analyze', handler)
    },
  }
}

export default defineConfig({
  plugins: [react(), devApi()],
  build: { outDir: 'dist', sourcemap: false },
})
