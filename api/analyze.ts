// Vercel serverless function: POST /api/analyze
// Holds the Anthropic API key server-side and proxies to Claude.

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { AnalyzeError, runAnalyze } from '../src/server/analyze'
import type { AnalyzeRequest } from '../src/shared/types'

export const config = { maxDuration: 60 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  try {
    const body: AnalyzeRequest =
      typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})
    const result = await runAnalyze(body)
    res.status(200).json(result)
  } catch (e) {
    const status = e instanceof AnalyzeError ? e.status : 500
    const message = e instanceof Error ? e.message : 'Server error'
    res.status(status).json({ error: message })
  }
}
