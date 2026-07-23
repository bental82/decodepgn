// Server-side game store: proxies CRUD to Supabase (PostgREST) using the
// service-role key. The app stays single-user and login-free by design — the
// browser never talks to Supabase. It talks to /api/games, and the games table
// has row-level security ENABLED with NO policies, so the anon/public key can
// do nothing; only this server (the service role bypasses RLS) can touch it.
//
// This module is server-only (it reads the service-role key). It must never be
// imported by browser code.

import { summarizeGame, type SummarizableGame } from '../shared/meta.js'
import type { Focus } from '../shared/types'

const LIST_LIMIT = 100
// The cross-game meta report lives in a reserved row of the same table
// (excluded from every game listing) — no extra schema needed.
const META_ROW_KEY = '__meta__'

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
  /** server-side analysis job state, when one exists (drives landing badges) */
  job?: { status: string; progress?: { done: number; total: number }; heartbeat?: number }
}

export async function listCloudGames(): Promise<CloudGameMeta[]> {
  const resp = await sb(
    `games?select=key,pgn,focus,headers,analysed,has_quiz,saved_at,added_at:data->>addedAt,job:data->job&key=neq.__meta__&order=saved_at.desc&limit=${LIST_LIMIT}`,
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
    job?: unknown
  }>
  if (!Array.isArray(rows)) return []
  return rows
    .filter((r) => typeof r?.key === 'string' && typeof r?.pgn === 'string')
    .map((r) => {
      const j = r.job as {
        status?: unknown
        progress?: { done?: unknown; total?: unknown }
        heartbeat?: unknown
      } | null
      const p = j?.progress
      return {
        key: r.key as string,
        pgn: r.pgn as string,
        focus: r.focus === 'b' || r.focus === 'both' ? (r.focus as Focus) : 'w',
        headers:
          r.headers && typeof r.headers === 'object' ? (r.headers as Record<string, string>) : {},
        savedAt: typeof r.saved_at === 'string' ? Date.parse(r.saved_at) || 0 : 0,
        addedAt: Number(r.added_at) > 0 ? Number(r.added_at) : undefined,
        analysed: Number.isFinite(r.analysed) ? (r.analysed as number) : 0,
        hasQuiz: r.has_quiz === true,
        ...(j && typeof j.status === 'string'
          ? {
              job: {
                status: j.status,
                ...(Number.isFinite(p?.done) && Number.isFinite(p?.total)
                  ? { progress: { done: p!.done as number, total: p!.total as number } }
                  : {}),
                ...(Number.isFinite(j.heartbeat) ? { heartbeat: j.heartbeat as number } : {}),
              },
            }
          : {}),
      }
    })
}

/** The full saved game (the whole SavedGame JSON as the client stored it). */
export async function getCloudGame(key: string): Promise<unknown | null> {
  const k = typeof key === 'string' ? key.trim() : ''
  if (!k) throw new GamesError('Missing game key.')
  const resp = await sb(`games?key=eq.${encodeURIComponent(k)}&select=data&limit=1`)
  const rows = (await resp.json()) as Array<{ data?: unknown }>
  return Array.isArray(rows) && rows[0] ? (rows[0].data ?? null) : null
}

export async function putCloudGame(
  game: unknown,
  opts?: { fromRunner?: boolean },
): Promise<void> {
  const g = game as {
    key?: unknown
    pgn?: unknown
    focus?: unknown
    headers?: unknown
    savedAt?: unknown
    results?: unknown
    evals?: unknown
    quiz?: unknown
  }
  if (!g || typeof g.key !== 'string' || !g.key.trim()) throw new GamesError('Malformed game: missing key.')
  if (typeof g.pgn !== 'string' || !g.pgn.trim()) throw new GamesError('Malformed game: missing PGN.')
  let toStore: Record<string, unknown> = game as Record<string, unknown>
  if (!opts?.fromRunner) {
    // Client saves must not clobber a server-side analysis run: the job state
    // is server-owned, and while a job is active the server's results/evals
    // win any per-ply conflict (the client's copy may be minutes stale).
    const existing = (await getCloudGame(g.key).catch(() => null)) as {
      job?: { status?: string }
      results?: Record<string, unknown>
      evals?: Record<string, unknown>
    } | null
    if (existing?.job) {
      const active = existing.job.status === 'queued' || existing.job.status === 'running'
      toStore = { ...toStore, job: existing.job }
      if (active) {
        toStore.results = {
          ...((g.results as object) ?? {}),
          ...(existing.results ?? {}),
        }
        toStore.evals = { ...((g.evals as object) ?? {}), ...(existing.evals ?? {}) }
      }
    }
    // A stale device must never destroy analysis: a client save (e.g. from a
    // browser that hasn't pulled the latest cloud copy) merges per-ply — it
    // may add and update moves, but it can't DROP plies it doesn't know
    // about, and it can't replace a real analysis with a BLANK one.
    if (existing?.results && typeof existing.results === 'object') {
      const incoming = (toStore.results ?? {}) as Record<string, { rules?: unknown[]; lesson?: unknown }>
      const isBlank = (r: { rules?: unknown[]; lesson?: unknown } | undefined) =>
        !r || (!(Array.isArray(r.rules) && r.rules.length > 0) && !r.lesson)
      const merged: Record<string, unknown> = { ...existing.results }
      for (const [ply, r] of Object.entries(incoming)) {
        const prev = existing.results[ply] as { rules?: unknown[]; lesson?: unknown } | undefined
        if (!isBlank(r) || isBlank(prev)) merged[ply] = r
      }
      toStore = {
        ...toStore,
        results: merged,
        evals: {
          ...((existing.evals as object) ?? {}),
          ...((toStore.evals as object) ?? {}),
        },
      }
    }
    // addedAt anchors the game's position in the list — a client save that
    // lacks it must never wipe the stored one (that drift is what made
    // opening an older game shove it to the top)
    const exAdded = (existing as { addedAt?: unknown } | null)?.addedAt
    if (toStore.addedAt == null && typeof exAdded === 'number') {
      toStore = { ...toStore, addedAt: exAdded }
    }
  }
  const results = toStore.results
  const row = {
    key: g.key.trim().slice(0, 80),
    pgn: g.pgn.slice(0, 20_000),
    focus: g.focus === 'b' || g.focus === 'both' ? g.focus : 'w',
    headers: g.headers && typeof g.headers === 'object' ? g.headers : {},
    // the whole SavedGame rides in one jsonb column, so the client schema can
    // grow (graphics, quiz kinds, …) without a migration
    data: toStore,
    analysed:
      results && typeof results === 'object' ? Object.keys(results as object).length : 0,
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

/** Lean job listing: key, analysed count and the job object only — the
    runner's claim scan and the client's status poll both ride on this. */
export async function listJobRows(): Promise<
  Array<{ key: string; analysed: number; job: unknown }>
> {
  const resp = await sb(
    `games?select=key,analysed,job:data->job&key=neq.__meta__&order=saved_at.desc&limit=${LIST_LIMIT}`,
  )
  const rows = (await resp.json()) as Array<{ key?: unknown; analysed?: unknown; job?: unknown }>
  if (!Array.isArray(rows)) return []
  return rows
    .filter((r) => typeof r?.key === 'string')
    .map((r) => ({
      key: r.key as string,
      analysed: Number.isFinite(r.analysed) ? (r.analysed as number) : 0,
      job: r.job ?? null,
    }))
}

/** Full saved-game payloads for the whole archive (for the meta-analysis). */
export async function listCloudGameData(limit = 60): Promise<unknown[]> {
  const resp = await sb(`games?select=data&key=neq.__meta__&order=saved_at.desc&limit=${limit}`)
  const rows = (await resp.json()) as Array<{ data?: unknown }>
  return Array.isArray(rows) ? rows.map((r) => r?.data).filter(Boolean) : []
}

/** Compact digests of the whole cloud archive, computed fresh (so stats like
    accuracy always use the current formula) — powers the client's live
    cross-game numbers without downloading full games. */
export async function listCloudSummaries(limit = 60): Promise<unknown[]> {
  const out: unknown[] = []
  for (const data of await listCloudGameData(limit)) {
    const g = data as SummarizableGame
    if (!g || typeof g.key !== 'string' || !g.results || typeof g.results !== 'object') continue
    try {
      const s = summarizeGame(g)
      if (s.analysed > 0) out.push(s)
    } catch {
      /* skip malformed rows */
    }
  }
  return out
}

/** The saved cross-game report (whatever the client stored), or null. */
export async function getCloudMeta(): Promise<unknown | null> {
  const resp = await sb(`games?key=eq.${META_ROW_KEY}&select=data&limit=1`)
  const rows = (await resp.json()) as Array<{ data?: unknown }>
  return Array.isArray(rows) && rows[0] ? (rows[0].data ?? null) : null
}

export async function putCloudMeta(report: unknown): Promise<void> {
  if (!report || typeof report !== 'object') throw new GamesError('Malformed report.')
  const row = {
    key: META_ROW_KEY,
    pgn: '-',
    focus: 'w',
    headers: {},
    data: report,
    analysed: 0,
    has_quiz: false,
    saved_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  await sb('games?on_conflict=key', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  })
}

export async function deleteCloudGame(key: string): Promise<void> {
  const k = typeof key === 'string' ? key.trim() : ''
  if (!k) throw new GamesError('Missing game key.')
  await sb(`games?key=eq.${encodeURIComponent(k)}`, {
    method: 'DELETE',
    headers: { prefer: 'return=minimal' },
  })
}
