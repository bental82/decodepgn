// Thin client for the /api/analyze serverless function.

import type { AnalyzeRequest, AnalyzeResponse } from '../shared/types'

// Below the serverless function's maxDuration (60s) so the client aborts first
// with a clear message rather than surfacing an opaque platform timeout.
const TIMEOUT_MS = 55_000

export async function analyze(req: AnalyzeRequest): Promise<AnalyzeResponse> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
      signal: ctrl.signal,
    })
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error('The request timed out. Try again, or analyse fewer moves at once.')
    throw new Error('Could not reach the analysis service. Check your connection and try again.')
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    let message = `Request failed (${res.status}).`
    try {
      const body = await res.json()
      if (body && typeof body.error === 'string') message = body.error
    } catch {
      /* ignore parse errors */
    }
    throw new Error(message)
  }
  return (await res.json()) as AnalyzeResponse
}
