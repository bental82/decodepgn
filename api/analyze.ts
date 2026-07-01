// Vercel serverless function: POST /api/analyze
// Holds the Anthropic API key server-side and proxies to Claude.

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { AnalyzeError, runAnalyze, MODEL } from '../src/server/analyze'
import type { AnalyzeRequest } from '../src/shared/types'

export const config = { maxDuration: 60 }

const MAX_BODY_BYTES = 512 * 1024

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Everything is inside one try so no error can escape as an opaque platform
  // 500 — the client always gets a JSON { error } it can display.
  try {
    if (req.method === 'GET') {
      // Health check + diagnostics. Open this URL in a browser: if you see this
      // JSON the function is running; if you see a Vercel error page instead,
      // the function itself failed to start (a build/runtime problem).
      res.status(200).json({
        ok: true,
        build: 'http-fetch-1', // bump on deploys to confirm the live version
        hasServerKey: !!process.env.ANTHROPIC_API_KEY,
        model: MODEL,
        runtime: process.version,
      })
      return
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' })
      return
    }
    const contentLength = Number(req.headers['content-length'] || 0)
    if (contentLength > MAX_BODY_BYTES) {
      res.status(413).json({ error: 'Request too large.' })
      return
    }
    const body: AnalyzeRequest =
      typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})
    const result = await runAnalyze(body)
    res.status(200).json(result)
  } catch (e) {
    const status = e instanceof AnalyzeError ? e.status : 500
    const message = e instanceof Error ? e.message : 'Server error'
    // Log unexpected (non-AnalyzeError) failures so they appear in Vercel's
    // runtime logs with a stack trace for diagnosis.
    if (!(e instanceof AnalyzeError)) console.error('[api/analyze] unexpected failure:', e)
    res.status(status).json({ error: message })
  }
}
