// Server-side analysis runs. A "job" lives INSIDE the game's SavedGame JSON
// (data.job) — no schema migration. The runner claims a job, analyses moves
// in small batches (engine check + LLM per batch), and merges each batch into
// the game row as it lands, so progress survives anything: the phone locking,
// the tab closing, this very function timing out. A run that outlives one
// invocation chains into a fresh one; a run whose chain died is re-claimed by
// the next status poll's kick (stale heartbeat).
//
// This module is server-only. It must never be imported by browser code.

import { parsePgn, toGameMoves, toTargets } from '../game.js'
import { isStudied, type Focus, type MoveResult, type ParsedMove } from '../shared/types.js'
import { runAnalyze, hasLiteKey } from './analyze.js'
import { getCloudGame, putCloudGame, listJobRows, GamesError } from './games.js'
import {
  clearEngineCache,
  engineAvailable,
  evaluateMoveServer,
  evalAfterFromCache,
} from './engine.js'

export interface AnalysisJob {
  status: 'queued' | 'running' | 'done' | 'error'
  force: boolean
  includeLite: boolean
  repairEmpty: boolean
  queuedAt: number
  /** bumped on claim and after every batch — a stale heartbeat means the
      chain died and the job is claimable again */
  heartbeat: number
  /** plies still to analyse, studied-first — chained invocations resume here */
  pending?: number[]
  progress?: { done: number; total: number }
  /** claim token: only the invocation whose token matches may keep working,
      so a racing double-kick can't double-analyse batches */
  runnerId?: string
  error?: string
}

interface GameData {
  key: string
  pgn: string
  focus: Focus
  results?: Record<number, MoveResult>
  evals?: Record<number, number>
  pendingRun?: boolean
  job?: AnalysisJob
  [k: string]: unknown
}

const BATCH = 6
// a running job whose heartbeat is older than this is considered dead
export const STALE_MS = 3 * 60_000
// give up on a job after this many LLM batches failing in a row
const MAX_CONSECUTIVE_FAILURES = 3

const now = () => Date.now()

function isEmptyResult(r: MoveResult | undefined): boolean {
  return !!r && (!r.rules || r.rules.length === 0) && !r.lesson
}

export function jobActive(job: unknown): job is AnalysisJob {
  const j = job as AnalysisJob | undefined
  return !!j && (j.status === 'queued' || j.status === 'running')
}

function targetPlies(moves: ParsedMove[], data: GameData, job: AnalysisJob): number[] {
  const withLite = job.includeLite && hasLiteKey()
  const results = data.results ?? {}
  return moves
    .filter(
      (m) =>
        (isStudied(m.color, data.focus) || withLite) &&
        (job.force || !results[m.ply] || (job.repairEmpty && isEmptyResult(results[m.ply]))),
    )
    .map((m) => m.ply)
    .sort(
      (a, b) =>
        (isStudied(moves[a].color, data.focus) ? 0 : 1) -
          (isStudied(moves[b].color, data.focus) ? 0 : 1) || a - b,
    )
}

/** Create (or refresh) a queued job for a game. `shell` lets a brand-new game
    that has no cloud row yet be enqueued — the row is created from it. */
export async function enqueueJob(
  key: string,
  opts: { force?: boolean; includeLite?: boolean; repairEmpty?: boolean },
  shell?: unknown,
): Promise<AnalysisJob> {
  const existing = (await getCloudGame(key)) as GameData | null
  const base = existing ?? (shell as GameData | null)
  if (!base || typeof base.pgn !== 'string' || !base.pgn.trim())
    throw new GamesError('No such game to analyse.', 404)
  const prior = base.job
  // an active, fresh job already covers this request — don't reset its work
  if (jobActive(prior) && now() - prior.heartbeat < STALE_MS && !opts.force) return prior
  const job: AnalysisJob = {
    status: 'queued',
    force: opts.force === true,
    includeLite: opts.includeLite === true,
    repairEmpty: opts.repairEmpty === true,
    queuedAt: now(),
    heartbeat: now(),
  }
  await putCloudGame({ ...base, key, job }, { fromRunner: true })
  return job
}

/** The job/analysed state for one game — the client's cheap poll. */
export async function jobStatus(
  key: string,
): Promise<{ job: AnalysisJob | null; analysed: number }> {
  const rows = await listJobRows()
  const row = rows.find((r) => r.key === key)
  return { job: (row?.job as AnalysisJob) ?? null, analysed: row?.analysed ?? 0 }
}

/** True when some queued/stale job needs a worker (the poll's kick signal). */
export async function workWaiting(): Promise<boolean> {
  const rows = await listJobRows()
  return rows.some((r) => {
    const j = r.job as AnalysisJob | null
    if (!jobActive(j)) return false
    return j.status === 'queued' || now() - j.heartbeat > STALE_MS
  })
}

/** Claim the next workable job: queued first (oldest tap), then stale
    running jobs (their chain died). Returns null when there is nothing. */
async function claimNext(runnerId: string): Promise<GameData | null> {
  const rows = await listJobRows()
  const claimable = rows
    .map((r) => ({ key: r.key, job: r.job as AnalysisJob | null }))
    .filter((r): r is { key: string; job: AnalysisJob } => jobActive(r.job))
    .filter((r) => r.job.status === 'queued' || now() - r.job.heartbeat > STALE_MS)
    .sort((a, b) => a.job.queuedAt - b.job.queuedAt)
  for (const c of claimable) {
    const data = (await getCloudGame(c.key)) as GameData | null
    if (!data || !jobActive(data.job)) continue // changed since the listing
    if (data.job.status === 'running' && now() - data.job.heartbeat <= STALE_MS) continue
    const job: AnalysisJob = { ...data.job, status: 'running', heartbeat: now(), runnerId }
    if (!job.pending) {
      // first claim: fix the work list once; chained links only shrink it
      try {
        const moves = parsePgn(data.pgn).moves
        job.pending = targetPlies(moves, data, job)
      } catch {
        const bad: AnalysisJob = {
          ...job,
          status: 'error',
          error: 'This PGN could not be parsed on the server.',
        }
        delete bad.pending
        delete bad.runnerId
        await putCloudGame({ ...data, job: bad }, { fromRunner: true })
        continue
      }
      job.progress = { done: 0, total: job.pending.length }
      if (job.force) clearEngineCache()
    }
    if ((job.pending ?? []).length === 0) {
      // nothing to do (already fully analysed) — a job must never sit in
      // "running" with an empty work list, it would cycle stale→reclaim forever
      const done: AnalysisJob = { ...job, status: 'done' }
      delete done.pending
      delete done.runnerId
      await putCloudGame({ ...data, job: done }, { fromRunner: true })
      continue
    }
    await putCloudGame({ ...data, job }, { fromRunner: true })
    return { ...data, job }
  }
  return null
}

async function analyzeBatch(
  moves: ParsedMove[],
  focus: Focus,
  batch: number[],
  fresh: boolean,
): Promise<MoveResult[]> {
  const targets = toTargets(moves, batch)
  const engineOk = await engineAvailable()
  for (const t of targets) {
    const pm = moves[t.ply]
    if (!pm || !engineOk) continue
    const ev = await evaluateMoveServer(pm, {
      fresh,
      quick: !isStudied(pm.color, focus),
    })
    if (ev) t.engine = ev
  }
  const req = { focus, game: toGameMoves(moves), targets }
  let resp = await runAnalyze(req).catch(async () => {
    await new Promise((r) => setTimeout(r, 2000))
    return runAnalyze(req)
  })
  // the model sometimes skips plies in a batch — one targeted follow-up
  const returned = new Set(resp.results.map((r) => r.ply))
  const missing = targets.filter((t) => !returned.has(t.ply))
  if (missing.length > 0) {
    const extra = await runAnalyze({ ...req, targets: missing }).catch(() => null)
    if (extra?.results?.length) resp = { results: [...resp.results, ...extra.results] }
  }
  const byPly = new Map(resp.results.map((r) => [r.ply, r]))
  const engineOf = new Map(targets.map((t) => [t.ply, t.engine]))
  return batch.map(
    (ply) =>
      ({
        ...(byPly.get(ply) ?? { ply, rules: [], lesson: '' }), // placeholder beats a hole
        engine: engineOf.get(ply),
      }) as MoveResult,
  )
}

/** Merge one batch of results into the freshest copy of the game row. */
async function mergeBatch(
  key: string,
  runnerId: string,
  moves: ParsedMove[],
  batchResults: MoveResult[],
  donePlies: number[],
): Promise<AnalysisJob | null> {
  const data = (await getCloudGame(key)) as GameData | null
  if (!data) return null // deleted mid-run — drop the work
  const job = data.job
  if (!jobActive(job) || job.runnerId !== runnerId) return null // someone else owns it now
  const results = { ...(data.results ?? {}) }
  for (const r of batchResults) results[r.ply] = r
  // the per-move checks scored both sides of every analysed move — every
  // cached position becomes an eval-bar entry for free
  const evals = { ...(data.evals ?? {}) }
  for (const m of moves) {
    if (evals[m.ply] !== undefined) continue
    const v = evalAfterFromCache(m.fenAfter, m.color)
    if (v !== null) evals[m.ply] = v
  }
  const doneSet = new Set(donePlies)
  const pending = (job.pending ?? []).filter((p) => !doneSet.has(p))
  const total = job.progress?.total ?? pending.length + donePlies.length
  const next: AnalysisJob = {
    ...job,
    pending,
    progress: { done: total - pending.length, total },
    heartbeat: now(),
  }
  if (pending.length === 0) {
    next.status = 'done'
    delete next.pending
    delete next.runnerId
  }
  const merged: GameData = {
    ...data,
    results,
    evals,
    savedAt: now(),
    job: next,
    // legacy client-side resume flag — the server run supersedes it
    pendingRun: false,
  }
  await putCloudGame(merged, { fromRunner: true })
  return next
}

async function failJob(key: string, runnerId: string, message: string): Promise<void> {
  const data = (await getCloudGame(key)) as GameData | null
  if (!data || !jobActive(data.job) || data.job.runnerId !== runnerId) return
  const job: AnalysisJob = { ...data.job, status: 'error', error: message.slice(0, 300), heartbeat: now() }
  delete job.pending
  delete job.runnerId
  await putCloudGame({ ...data, job }, { fromRunner: true })
}

/**
 * Work until the deadline: claim jobs, process batches, merge as they land.
 * Returns true when claimable work remains (the caller should chain a fresh
 * invocation).
 */
export async function processJobs(deadlineAt: number): Promise<boolean> {
  const runnerId = Math.random().toString(36).slice(2)
  // leave room for one worst-case batch (engine ~15s + two LLM calls)
  const cutoff = () => now() > deadlineAt - 120_000
  while (!cutoff()) {
    const claimed = await claimNext(runnerId)
    if (!claimed) return false
    const job = claimed.job as AnalysisJob
    let moves: ParsedMove[]
    try {
      moves = parsePgn(claimed.pgn).moves
      if (moves.length === 0) throw new Error('no moves')
    } catch {
      await failJob(claimed.key, runnerId, 'This PGN could not be parsed on the server.').catch(
        () => {},
      )
      continue
    }
    let pending = [...(job.pending ?? [])]
    let failures = 0
    let lost = false
    while (pending.length > 0) {
      if (cutoff()) return true // chain: the next invocation resumes `pending`
      const batch = pending.slice(0, BATCH)
      let results: MoveResult[] | null = null
      try {
        results = await analyzeBatch(moves, claimed.focus, batch, job.force)
      } catch (e) {
        failures++
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          const msg = e instanceof Error ? e.message : 'Analysis failed.'
          await failJob(claimed.key, runnerId, msg).catch(() => {})
          break
        }
        await new Promise((r) => setTimeout(r, 3000))
        continue // retry the same batch
      }
      failures = 0
      const after = await mergeBatch(claimed.key, runnerId, moves, results, batch)
      if (!after) {
        lost = true // game deleted or job taken over — stop quietly
        break
      }
      pending = [...(after.pending ?? [])]
      if (after.status !== 'running') break
    }
    if (lost) continue
  }
  return true
}
