// Vercel serverless function: /api/games — optional permanent storage of
// analysed games in Supabase. Single-user by design: no login; the browser
// talks only to this endpoint and the server holds the only credentials.

import type { VercelRequest, VercelResponse } from '@vercel/node'

export const config = { maxDuration: 30 }

// a fully analysed game with graphics + quiz is a few hundred KB of JSON
const MAX_BODY_BYTES = 900 * 1024

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // Dynamic import so a bundling failure surfaces as a readable error
    // (same pattern as api/analyze.ts).
    const store = await import('../src/server/games.js')
    const key = typeof req.query.key === 'string' ? req.query.key : ''
    const wantsMeta = req.query.meta === '1'

    if (req.method === 'GET') {
      if (!store.cloudConfigured()) {
        res.status(200).json({ enabled: false })
        return
      }
      if (wantsMeta) {
        res.status(200).json({ enabled: true, meta: await store.getCloudMeta() })
        return
      }
      if (req.query.summaries === '1') {
        res.status(200).json({ enabled: true, summaries: await store.listCloudSummaries() })
        return
      }
      if (key) {
        res.status(200).json({ enabled: true, game: await store.getCloudGame(key) })
        return
      }
      res.status(200).json({ enabled: true, games: await store.listCloudGames() })
      return
    }

    if (req.method === 'POST' || req.method === 'PUT') {
      const contentLength = Number(req.headers['content-length'] || 0)
      if (contentLength > MAX_BODY_BYTES) {
        res.status(413).json({ error: 'Game too large to sync.' })
        return
      }
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})
      if (wantsMeta) {
        await store.putCloudMeta(body)
      } else {
        await store.putCloudGame(body)
      }
      res.status(200).json({ ok: true })
      return
    }

    if (req.method === 'DELETE') {
      await store.deleteCloudGame(key)
      res.status(200).json({ ok: true })
      return
    }

    res.status(405).json({ error: 'Method not allowed' })
  } catch (e) {
    const err = e as { name?: string; status?: number }
    const status = err?.name === 'GamesError' && typeof err.status === 'number' ? err.status : 500
    const message = e instanceof Error ? e.message : 'Server error'
    if (status >= 500) console.error('[api/games] failure:', e)
    res.status(status).json({ error: message })
  }
}
