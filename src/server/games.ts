// Server-side game store: proxies CRUD to Supabase (PostgREST) using the
// service-role key. The app stays single-user and login-free by design — the
// browser never talks to Supabase. It talks to /api/games, and the games table
// has row-level security ENABLED with NO policies, so the anon/public key can
// do nothing; only this server (the service role bypasses RLS) can touch it.
//
// This module is server-only (it reads the service-role key). It must never be
// imported by browser code.

import { DIGEST_VERSION, summarizeGame, type SummarizableGame } from '../shared/meta.js'
import type { Focus, MetaGameSummary } from '../shared/types'

// Listings walk the whole archive in pages of this many rows (under
// Supabase's default 1000-row response cap).
const PAGE_SIZE = 500
// Legacy rows (no stored digest) are summarized from full data this many at a
// time — each is up to a few hundred KB of analysis.
const BACKFILL_BATCH = 10
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

/**
 * Every game row, however many there are: keyset pages over the primary key.
 * (Not offset pages over saved_at — a run saving mid-walk would move its row
 * and shift every offset after it, skipping or repeating games.) `select`
 * must include `key`; `filter` is extra PostgREST filters, each `&`-prefixed.
 */
async function allRows<T>(select: string, filter = ''): Promise<T[]> {
  const out: T[] = []
  let after: string | null = null
  for (;;) {
    const from = after === null ? '' : `&key=gt.${encodeURIComponent(after)}`
    const resp = await sb(
      `games?select=${select}&key=neq.${META_ROW_KEY}${from}${filter}&order=key.asc&limit=${PAGE_SIZE}`,
    )
    const page = (await resp.json()) as Array<T & { key?: unknown }>
    if (!Array.isArray(page)) break
    out.push(...page)
    const last = page[page.length - 1]?.key
    if (page.length < PAGE_SIZE || typeof last !== 'string') break
    after = last
  }
  return out
}

/** A PostgREST `in.(…)` list item: quoted, so any key text is taken literally. */
const quoted = (s: string) => `"${s.replace(/["\\]/g, '\\$&')}"`

/** The game with its cross-game digest (re)computed — see putCloudGame. */
function withDigest(data: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...data }
  delete rest.digest
  try {
    const digest = summarizeGame(rest as unknown as SummarizableGame)
    return { ...rest, digest: { ...digest, v: DIGEST_VERSION } }
  } catch {
    return rest
  }
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
  const rows = await allRows<{
    key?: unknown
    pgn?: unknown
    focus?: unknown
    headers?: unknown
    analysed?: unknown
    has_quiz?: unknown
    saved_at?: unknown
    added_at?: unknown
    job?: unknown
  }>('key,pgn,focus,headers,analysed,has_quiz,saved_at,added_at:data->>addedAt,job:data->job')
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
    .sort((a, b) => b.savedAt - a.savedAt)
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
  // The cross-game digest rides inside the row (data.digest) so archive-wide
  // reads — the "Your play" report, the landing stats — fetch ~1KB per game
  // instead of every game's full analysis. Rebuilt on every write, so it can
  // never lag the results it describes.
  toStore = withDigest(toStore)
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

export interface JobRow {
  key: string
  analysed: number
  job: unknown
}

const JOB_SELECT = 'key,analysed,job:data->job'

function toJobRows(rows: unknown): JobRow[] {
  if (!Array.isArray(rows)) return []
  return (rows as Array<{ key?: unknown; analysed?: unknown; job?: unknown }>)
    .filter((r) => typeof r?.key === 'string')
    .map((r) => ({
      key: r.key as string,
      analysed: Number.isFinite(r.analysed) ? (r.analysed as number) : 0,
      job: r.job ?? null,
    }))
}

/** Every game whose analysis job is queued or running — the runner's claim
    scan and the tick's work check. Filtered in the database, so a job on the
    oldest game in a large archive is found as surely as one on the newest. */
export async function listActiveJobRows(): Promise<JobRow[]> {
  return toJobRows(await allRows(JOB_SELECT, '&data->job->>status=in.(queued,running)'))
}

/** One game's job + analysed count — the client's cheap status poll. */
export async function getJobRow(key: string): Promise<JobRow | null> {
  const resp = await sb(`games?select=${JOB_SELECT}&key=eq.${encodeURIComponent(key)}&limit=1`)
  return toJobRows(await resp.json())[0] ?? null
}

type StoredDigest = MetaGameSummary & { v?: unknown }

/** A stored digest without its version stamp, or null when it is missing or
    was built by an older summary formula. */
function currentDigest(d: unknown): MetaGameSummary | null {
  const s = d as StoredDigest | null
  if (!s || typeof s !== 'object' || s.v !== DIGEST_VERSION) return null
  const out = { ...s }
  delete out.v
  return out
}

/**
 * Digests of EVERY analysed game in the archive — the cross-game report and
 * the landing's live stats. Reads the digest each row stores (~1KB a game),
 * never the full analyses. A row written before digests existed, or under an
 * older summary formula, is summarized from its full data once and the digest
 * written back, so the next listing is cheap again. That backfill stops at
 * `budgetMs`; rows it didn't reach are left out this time and caught up on the
 * next call.
 */
export async function listCloudSummaries(budgetMs = 20_000): Promise<MetaGameSummary[]> {
  const stopAt = Date.now() + budgetMs
  const rows = await allRows<{ key?: unknown; digest?: unknown }>('key,digest:data->digest')
  const out: MetaGameSummary[] = []
  const stale: string[] = []
  for (const r of rows) {
    if (typeof r.key !== 'string') continue
    const s = currentDigest(r.digest)
    if (!s) stale.push(r.key)
    else if (s.analysed > 0) out.push(s)
  }
  for (let i = 0; i < stale.length && Date.now() < stopAt; i += BACKFILL_BATCH) {
    const keys = stale.slice(i, i + BACKFILL_BATCH).map(quoted).join(',')
    const resp = await sb(`games?select=key,data,updated_at&key=in.(${encodeURIComponent(keys)})`)
    const full = (await resp.json()) as Array<{ key?: unknown; data?: unknown; updated_at?: unknown }>
    const writes: Promise<unknown>[] = []
    for (const row of Array.isArray(full) ? full : []) {
      const data = row.data as Record<string, unknown> | null
      if (typeof row.key !== 'string' || !data || typeof data.pgn !== 'string') continue
      const next = withDigest(data)
      const s = currentDigest(next.digest)
      if (!s) continue
      if (s.analysed > 0) out.push(s)
      // Write it back only if the row is untouched since we read it: a run or
      // save that landed in between carries its own fresh digest, and this
      // whole-row write must never roll its results back.
      if (typeof row.updated_at === 'string') {
        writes.push(
          sb(
            `games?key=eq.${encodeURIComponent(row.key)}&updated_at=eq.${encodeURIComponent(row.updated_at)}`,
            {
              method: 'PATCH',
              headers: { prefer: 'return=minimal' },
              body: JSON.stringify({ data: next }),
            },
          ).catch(() => {}),
        )
      }
    }
    await Promise.all(writes)
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
