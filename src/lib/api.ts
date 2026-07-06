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

// Below the serverless function's maxDuration (300s) so the client aborts
// first with a clear message rather than surfacing an opaque platform timeout.
// Interactive calls stay tight; the long-form meta report gets minutes.
const TIMEOUT_MS = 55_000
const META_TIMEOUT_MS = 290_000

async function postAnalyze<T>(body: object, timeoutMs = TIMEOUT_MS): Promise<T> {
  const ctrl = new AbortController()
  // The timer stays armed until the BODY is read, not just the headers:
  // a response whose body stalls mid-flight would otherwise hang forever
  // (fetch resolves on headers; only the signal can cancel the body read).
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    let res: Response
    try {
      res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
    } catch {
      if (ctrl.signal.aborted) throw new Error('The request timed out. Try again in a moment.')
      throw new Error('Could not reach the service. Check your connection and try again.')
    }
    if (!res.ok) {
      let message = `Request failed (${res.status}).`
      try {
        const errBody = await res.json()
        if (errBody && typeof errBody.error === 'string') message = errBody.error
      } catch {
        /* ignore parse errors */
      }
      throw new Error(message)
    }
    try {
      return (await res.json()) as T
    } catch {
      throw new Error(
        ctrl.signal.aborted
          ? 'The request timed out. Try again in a moment.'
          : 'The service returned an unreadable response. Try again.',
      )
    }
  } finally {
    clearTimeout(timer)
  }
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
  return postAnalyze<MetaResponse>(req, META_TIMEOUT_MS)
}
