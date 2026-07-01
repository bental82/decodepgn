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
      const MAX_BODY_BYTES = 512 * 1024
      const handler: Connect.NextHandleFunction = async (req, res) => {
        if (req.method === 'GET') {
          const mod = await server.ssrLoadModule('/src/server/analyze.ts')
          res.setHeader('content-type', 'application/json')
          res.end(
            JSON.stringify({
              ok: true,
              hasServerKey: !!process.env.ANTHROPIC_API_KEY,
              model: mod.MODEL,
              runtime: process.version,
            }),
          )
          return
        }
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('Method not allowed')
          return
        }
        try {
          const chunks: Buffer[] = []
          let size = 0
          for await (const c of req) {
            size += (c as Buffer).length
            if (size > MAX_BODY_BYTES) {
              res.statusCode = 413
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ error: 'Request too large.' }))
              return
            }
            chunks.push(c as Buffer)
          }
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
