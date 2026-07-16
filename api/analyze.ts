// Vercel serverless function: POST /api/analyze
// Holds the Anthropic API key server-side and proxies to Claude.

import type { VercelRequest, VercelResponse } from '@vercel/node'

// The cross-game meta report generates thousands of tokens and needs minutes;
// 300s is within the Fluid-compute limit on every Vercel plan (incl. Hobby).
export const config = { maxDuration: 300 }

const MAX_BODY_BYTES = 512 * 1024

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method === 'GET') {
      // Health check + diagnostics. Depends on NOTHING else, so it always loads:
      // if you see this JSON the function itself is fine.
      res.status(200).json({
        ok: true,
        build: 'overview-2', // bump on deploys to confirm the live version (shown in Settings)
        hasServerKey: !!process.env.ANTHROPIC_API_KEY,
        model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
        modelFast: process.env.ANTHROPIC_MODEL_FAST || 'claude-sonnet-5',
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
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})
    // Import the engine dynamically: if Vercel failed to bundle this module, the
    // failure surfaces here as a catchable, readable error instead of crashing
    // the whole function at load time (which shows up as an opaque platform 500).
    const engine = await import('../src/server/analyze.js')
    const mode = body && body.mode
    const result =
      mode === 'quiz'
        ? await engine.runQuiz(body)
        : mode === 'ask'
          ? await engine.runAsk(body)
          : mode === 'overview'
            ? await engine.runOverview(body)
            : mode === 'meta'
              ? await engine.runMeta(body)
              : await engine.runAnalyze(body)
    res.status(200).json(result)
  } catch (e) {
    const err = e as { name?: string; status?: number; message?: string }
    const status = err?.name === 'AnalyzeError' && typeof err.status === 'number' ? err.status : 500
    const message = e instanceof Error ? e.message : 'Server error'
    if (status >= 500) console.error('[api/analyze] failure:', e)
    res.status(status).json({ error: message })
  }
}
