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
          const result =
            body?.mode === 'quiz'
              ? await mod.runQuiz(body)
              : body?.mode === 'ask'
                ? await mod.runAsk(body)
                : body?.mode === 'overview'
                  ? await mod.runOverview(body)
                  : body?.mode === 'meta'
                    ? await mod.runMeta(body)
                    : await mod.runAnalyze(body)
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

      // /api/games (optional Supabase persistence) — mirrors api/games.ts.
      const gamesHandler: Connect.NextHandleFunction = async (req, res) => {
        res.setHeader('content-type', 'application/json')
        try {
          const store = await server.ssrLoadModule('/src/server/games.ts')
          const url = new URL(req.url || '/', 'http://localhost')
          const key = url.searchParams.get('key') || ''
          const wantsMeta = url.searchParams.get('meta') === '1'
          if (req.method === 'GET') {
            if (!store.cloudConfigured()) {
              res.end(JSON.stringify({ enabled: false }))
              return
            }
            if (wantsMeta) {
              res.end(JSON.stringify({ enabled: true, meta: await store.getCloudMeta() }))
              return
            }
            if (key) {
              res.end(JSON.stringify({ enabled: true, game: await store.getCloudGame(key) }))
              return
            }
            res.end(JSON.stringify({ enabled: true, games: await store.listCloudGames() }))
            return
          }
          if (req.method === 'POST' || req.method === 'PUT') {
            const chunks: Buffer[] = []
            let size = 0
            for await (const c of req) {
              size += (c as Buffer).length
              if (size > 900 * 1024) {
                res.statusCode = 413
                res.end(JSON.stringify({ error: 'Game too large to sync.' }))
                return
              }
              chunks.push(c as Buffer)
            }
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            if (wantsMeta) await store.putCloudMeta(body)
            else await store.putCloudGame(body)
            res.end(JSON.stringify({ ok: true }))
            return
          }
          if (req.method === 'DELETE') {
            await store.deleteCloudGame(key)
            res.end(JSON.stringify({ ok: true }))
            return
          }
          res.statusCode = 405
          res.end(JSON.stringify({ error: 'Method not allowed' }))
        } catch (e: any) {
          res.statusCode = e?.name === 'GamesError' && typeof e.status === 'number' ? e.status : 500
          res.end(JSON.stringify({ error: e?.message || 'Server error' }))
        }
      }
      server.middlewares.use('/api/games', gamesHandler)
    },
  }
}

export default defineConfig({
  plugins: [react(), devApi()],
  // Shown in Settings so users can tell which build their (home-screen) app
  // is actually running; Vercel injects the commit sha at build time.
  define: {
    __BUILD_ID__: JSON.stringify((process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || 'dev'),
  },
  build: { outDir: 'dist', sourcemap: false },
})
