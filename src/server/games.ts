// Server-side game store: proxies CRUD to Supabase (PostgREST) using the
// service-role key. The app stays single-user and login-free by design — the
// browser never talks to Supabase. It talks to /api/games, and the games table
// has row-level security ENABLED with NO policies, so the anon/public key can
// do nothing; only this server (the service role bypasses RLS) can touch it.
//
// This module is server-only (it reads the service-role key). It must never be
// imported by browser code.

import type { Focus } from '../shared/types'

const LIST_LIMIT = 100

export class GamesError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'GamesError'
    this.status = status
  }
}

function env(): { url: string; key: string } | null {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '')
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  return url && key ? { url, key } : null
}

/** Cloud persistence is optional: absent env vars simply disable the feature. */
export function cloudConfigured(): boolean {
  return env() !== null
}

/** One place that calls PostgREST and maps failures to friendly errors. */
async function sb(path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
  const cfg = env()
  if (!cfg) throw new GamesError('Cloud storage is not configured on this deployment.', 501)
  let resp: Response
  try {
    resp = await fetch(`${cfg.url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: cfg.key,
        authorization: `Bearer ${cfg.key}`,
        'content-type': 'application/json',
        ...(init?.headers || {}),
      },
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new GamesError('Could not reach the games database. Try again shortly.', 502)
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new GamesError(`The games database rejected the request: ${detail.slice(0, 300)}`, 502)
  }
  return resp
}

/** What the landing list needs — everything except the heavy analysis data. */
export interface CloudGameMeta {
  key: string
  pgn: string
  focus: Focus
  headers: Record<string, string>
  savedAt: number
  addedAt?: number
  analysed: number
  hasQuiz: boolean
}

export async function listCloudGames(): Promise<CloudGameMeta[]> {
  const resp = await sb(
    `games?select=key,pgn,focus,headers,analysed,has_quiz,saved_at,added_at:data->>addedAt&order=saved_at.desc&limit=${LIST_LIMIT}`,
  )
  const rows = (await resp.json()) as Array<{
    key?: unknown
    pgn?: unknown
    focus?: unknown
    headers?: unknown
    analysed?: unknown
    has_quiz?: unknown
    saved_at?: unknown
    added_at?: unknown
  }>
  if (!Array.isArray(rows)) return []
  return rows
    .filter((r) => typeof r?.key === 'string' && typeof r?.pgn === 'string')
    .map((r) => ({
      key: r.key as string,
      pgn: r.pgn as string,
      focus: r.focus === 'b' || r.focus === 'both' ? (r.focus as Focus) : 'w',
      headers:
        r.headers && typeof r.headers === 'object' ? (r.headers as Record<string, string>) : {},
      savedAt: typeof r.saved_at === 'string' ? Date.parse(r.saved_at) || 0 : 0,
      addedAt: Number(r.added_at) > 0 ? Number(r.added_at) : undefined,
      analysed: Number.isFinite(r.analysed) ? (r.analysed as number) : 0,
      hasQuiz: r.has_quiz === true,
    }))
}

/** The full saved game (the whole SavedGame JSON as the client stored it). */
export async function getCloudGame(key: string): Promise<unknown | null> {
  const k = typeof key === 'string' ? key.trim() : ''
  if (!k) throw new GamesError('Missing game key.')
  const resp = await sb(`games?key=eq.${encodeURIComponent(k)}&select=data&limit=1`)
  const rows = (await resp.json()) as Array<{ data?: unknown }>
  return Array.isArray(rows) && rows[0] ? (rows[0].data ?? null) : null
}

export async function putCloudGame(game: unknown): Promise<void> {
  const g = game as {
    key?: unknown
    pgn?: unknown
    focus?: unknown
    headers?: unknown
    savedAt?: unknown
    results?: unknown
    quiz?: unknown
  }
  if (!g || typeof g.key !== 'string' || !g.key.trim()) throw new GamesError('Malformed game: missing key.')
  if (typeof g.pgn !== 'string' || !g.pgn.trim()) throw new GamesError('Malformed game: missing PGN.')
  const row = {
    key: g.key.trim().slice(0, 80),
    pgn: g.pgn.slice(0, 20_000),
    focus: g.focus === 'b' || g.focus === 'both' ? g.focus : 'w',
    headers: g.headers && typeof g.headers === 'object' ? g.headers : {},
    // the whole SavedGame rides in one jsonb column, so the client schema can
    // grow (graphics, quiz kinds, …) without a migration
    data: game,
    analysed:
      g.results && typeof g.results === 'object' ? Object.keys(g.results as object).length : 0,
    has_quiz: !!g.quiz,
    saved_at: new Date(
      typeof g.savedAt === 'number' && Number.isFinite(g.savedAt) ? g.savedAt : Date.now(),
    ).toISOString(),
    updated_at: new Date().toISOString(),
  }
  await sb('games?on_conflict=key', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  })
}

/** Full saved-game payloads for the whole archive (for the meta-analysis). */
export async function listCloudGameData(limit = 60): Promise<unknown[]> {
  const resp = await sb(`games?select=data&order=saved_at.desc&limit=${limit}`)
  const rows = (await resp.json()) as Array<{ data?: unknown }>
  return Array.isArray(rows) ? rows.map((r) => r?.data).filter(Boolean) : []
}

export async function deleteCloudGame(key: string): Promise<void> {
  const k = typeof key === 'string' ? key.trim() : ''
  if (!k) throw new GamesError('Missing game key.')
  await sb(`games?key=eq.${encodeURIComponent(k)}`, {
    method: 'DELETE',
    headers: { prefer: 'return=minimal' },
  })
}
