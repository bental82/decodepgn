// Thin client for the /api/analyze serverless function (analyse / quiz / ask).

import type {
  AnalyzeRequest,
  AnalyzeResponse,
  AskRequest,
  AskResponse,
  MetaRequest,
  MetaResponse,
  OverviewRequest,
  OverviewResponse,
  QuizRequest,
  QuizResponse,
} from '../shared/types'

// Below the serverless function's maxDuration (60s) so the client aborts first
// with a clear message rather than surfacing an opaque platform timeout.
const TIMEOUT_MS = 55_000

async function postAnalyze<T>(body: object, timeoutMs = TIMEOUT_MS): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error('The request timed out. Try again in a moment.')
    throw new Error('Could not reach the service. Check your connection and try again.')
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
  return (await res.json()) as T
}

export function analyze(req: AnalyzeRequest): Promise<AnalyzeResponse> {
  return postAnalyze<AnalyzeResponse>(req)
}

export function quiz(req: QuizRequest): Promise<QuizResponse> {
  return postAnalyze<QuizResponse>(req)
}

export function ask(req: AskRequest): Promise<AskResponse> {
  return postAnalyze<AskResponse>(req, 45_000)
}

export function overview(req: OverviewRequest): Promise<OverviewResponse> {
  return postAnalyze<OverviewResponse>(req, 45_000)
}

export function meta(req: MetaRequest): Promise<MetaResponse> {
  return postAnalyze<MetaResponse>(req)
}
