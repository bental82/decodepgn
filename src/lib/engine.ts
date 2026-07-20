// Client-side Stockfish (18 lite, single-threaded WASM) running in a Web
// Worker. Used to ground the AI coaching in an objective check: for each
// analysed move we compute the engine's best move and the centipawn cost of
// the played move, and send that alongside the position to the AI.
//
// Everything here is best-effort: if the engine fails to load (old browser,
// blocked wasm), analysis proceeds without engine data.

import { Chess } from 'chess.js'
import type { EngineEval } from '../shared/types'

// Engine builds, strongest first: the full-strength net (~79MB, downloaded
// once and cached) gives judgments close to desktop Stockfish; the small
// lite net (~7MB) is the fallback when the big download fails.
const ENGINE_CANDIDATES = [
  `${import.meta.env.BASE_URL}engine/stockfish-17.1-single-a496a04.js`,
  `${import.meta.env.BASE_URL}engine/stockfish-18-lite-single.js`,
]
// Two search budgets: QUICK feeds the eval bar (volume over precision); DEEP
// feeds the per-move check whose best move the app presents as a
// recommendation — at 350ms those flip between candidate moves from run to
// run, so recommendations get a bigger, reproducible budget.
const QUICK_MOVETIME_MS = 350
const DEEP_MOVETIME_MS = 1200
const QUICK_MAX_DEPTH = 18
const DEEP_MAX_DEPTH = 24
const MATE_CP = 10_000

interface ScoredPosition {
  cp: number // from the side-to-move's perspective
  bestUci: string | null
  /** principal variation (UCI moves), starting with bestUci */
  pvUci: string[]
  depth: number
  /** the search budget this score was computed with (cache-quality gate) */
  movetime: number
}

// Positions repeat across the whole-game eval sweep and per-move checks
// (fenBefore of ply n === fenAfter of ply n-1), so cache scores by FEN.
const scoreCache = new Map<string, ScoredPosition>()
const SCORE_CACHE_MAX = 4000

let workerPromise: Promise<Worker> | null = null
let engineBroken = false
let initFailures = 0
let candidateIdx = 0
const MAX_INIT_FAILURES = 3 // per candidate build
let engineId: string | null = null
// Single worker — searches are serialized through a two-lane queue. QUICK
// requests (the eval bar sweep) take the fast lane and jump ahead of queued
// DEEP per-move checks: the user should see the Stockfish score of every
// position within seconds of loading a game, not after the whole analysis.
let engineBusyRunning = false
const quickLane: Array<() => Promise<void>> = []
const deepLane: Array<() => Promise<void>> = []
function pumpEngineQueue() {
  if (engineBusyRunning) return
  const next = quickLane.shift() ?? deepLane.shift()
  if (!next) return
  engineBusyRunning = true
  void next().finally(() => {
    engineBusyRunning = false
    pumpEngineQueue()
  })
}

/** Which engine build actually loaded (from the UCI "id name" line). */
export function engineName(): string | null {
  return engineId
}

function initWorker(): Promise<Worker> {
  return new Promise((resolve, reject) => {
    let w: Worker
    try {
      w = new Worker(ENGINE_CANDIDATES[candidateIdx])
    } catch (e) {
      reject(e)
      return
    }
    // generous: the first visit downloads the ~79MB full build inside init
    const timer = setTimeout(() => {
      try {
        w.terminate()
      } catch {
        /* already dead */
      }
      reject(new Error('Engine init timed out'))
    }, 240_000)
    const onMsg = (e: MessageEvent) => {
      const line = String(e.data)
      if (line.startsWith('id name ')) {
        engineId = line.slice('id name '.length)
      } else if (line === 'uciok') {
        w.postMessage('isready')
      } else if (line === 'readyok') {
        clearTimeout(timer)
        w.removeEventListener('message', onMsg)
        resolve(w)
      }
    }
    w.addEventListener('message', onMsg)
    w.addEventListener(
      'error',
      () => {
        clearTimeout(timer)
        reject(new Error('Engine failed to load'))
      },
      { once: true },
    )
    w.postMessage('uci')
  })
}

function getWorker(): Promise<Worker> {
  if (!workerPromise) workerPromise = initWorker()
  return workerPromise
}

/** Whether the engine can be used (loads it on first call). */
export async function engineAvailable(): Promise<boolean> {
  if (engineBroken) return false
  try {
    await getWorker()
    return true
  } catch {
    // A slow network can fail the big wasm download — retry a few times,
    // then fall back to the next (smaller) build before giving up.
    workerPromise = null
    initFailures++
    if (initFailures >= MAX_INIT_FAILURES) {
      if (candidateIdx < ENGINE_CANDIDATES.length - 1) {
        candidateIdx++
        initFailures = 0
      } else {
        engineBroken = true
      }
    }
    return false
  }
}

function scorePosition(fen: string, movetime = QUICK_MOVETIME_MS): Promise<ScoredPosition> {
  const hit = scoreCache.get(fen)
  // a cached deep score serves quick requests, never the other way round
  if (hit && hit.movetime >= movetime) return Promise.resolve(hit)
  const run = async (): Promise<ScoredPosition> => {
    const w = await getWorker()
    return new Promise((resolve, reject) => {
      let last: ScoredPosition = { cp: 0, bestUci: null, pvUci: [], depth: 0, movetime }
      let settled = false
      // Abandoning a search while the worker keeps running poisons every
      // search after it: the NEXT listener receives THIS position's lines and
      // caches them under the wrong FEN (an off-by-one shift through the whole
      // batch — seen in the wild when iOS froze the page mid-analysis).
      // Killing the worker is the only way to guarantee a clean channel.
      const fail = (why: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        w.removeEventListener('message', onMsg)
        try {
          w.terminate()
        } catch {
          /* already dead */
        }
        workerPromise = null // next search re-initialises a fresh worker
        reject(new Error(why))
      }
      const timer = setTimeout(() => fail('Engine evaluation timed out'), 10_000)
      const onErr = () => fail('Engine crashed mid-search')
      const onMsg = (e: MessageEvent) => {
        const line = String(e.data)
        if (line.startsWith('info ')) {
          const m = line.match(/ depth (\d+).*? score (cp|mate) (-?\d+)/)
          if (m) {
            const depth = parseInt(m[1], 10)
            const val = parseInt(m[3], 10)
            const cp =
              m[2] === 'mate'
                ? val > 0
                  ? MATE_CP - val * 10
                  : -MATE_CP - val * 10
                : Math.max(-MATE_CP, Math.min(MATE_CP, val))
            const pv = line.match(/ pv (.+)$/)
            const pvUci = pv
              ? pv[1].split(/\s+/).filter((t) => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(t))
              : last.pvUci
            last = { cp, bestUci: pvUci[0] ?? last.bestUci, pvUci, depth, movetime }
          }
        } else if (line.startsWith('bestmove')) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          w.removeEventListener('message', onMsg)
          w.removeEventListener('error', onErr)
          const bm = line.split(' ')[1]
          const bestUci = bm && bm !== '(none)' ? bm : last.bestUci
          // a pv that disagrees with the authoritative bestmove is stale
          const pvUci = bestUci && last.pvUci[0] === bestUci ? last.pvUci : bestUci ? [bestUci] : []
          const scored = { ...last, bestUci, pvUci }
          if (scoreCache.size >= SCORE_CACHE_MAX) scoreCache.clear()
          scoreCache.set(fen, scored)
          resolve(scored)
        }
      }
      w.addEventListener('message', onMsg)
      w.addEventListener('error', onErr)
      w.postMessage('position fen ' + fen)
      const depthCap = movetime > QUICK_MOVETIME_MS ? DEEP_MAX_DEPTH : QUICK_MAX_DEPTH
      w.postMessage(`go movetime ${movetime} depth ${depthCap}`)
    })
  }
  return new Promise<ScoredPosition>((resolve, reject) => {
    const lane = movetime <= QUICK_MOVETIME_MS ? quickLane : deepLane
    lane.push(() => run().then(resolve, reject))
    pumpEngineQueue()
  })
}

/**
 * Eval of the position AFTER a move, in centipawns from WHITE's perspective.
 * Terminal positions are scored directly. Null when the engine is unavailable.
 */
export async function evalAfterMoveWhite(fenAfter: string, mover: 'w' | 'b'): Promise<number | null> {
  if (!(await engineAvailable())) return null
  try {
    const g = new Chess(fenAfter)
    if (g.isCheckmate()) return mover === 'w' ? MATE_CP : -MATE_CP
    if (g.isDraw()) return 0
    const sc = await scorePosition(fenAfter) // side to move = the opponent
    return mover === 'w' ? -sc.cp : sc.cp
  } catch {
    return null
  }
}

interface MoveToEvaluate {
  fenBefore: string
  fenAfter: string
  from: string
  to: string
  /** promotion piece (lowercase) when the played move promotes */
  promotion?: string
}

/**
 * Deep eval of one candidate move in a position, in centipawns from the
 * MOVER's perspective — grades guess-the-move quiz tries on the same budget
 * as the stored per-move checks, so cpLoss comparisons stay apples-to-apples.
 * Null when the engine is unavailable or the move doesn't parse.
 */
export async function evalCandidateMove(fenBefore: string, san: string): Promise<number | null> {
  if (!(await engineAvailable())) return null
  try {
    const g = new Chess(fenBefore)
    const mv = g.move(san, { strict: false })
    if (!mv) return null
    if (g.isCheckmate()) return MATE_CP // the candidate delivers mate
    if (g.isDraw()) return 0
    const sc = await scorePosition(g.fen(), DEEP_MOVETIME_MS) // opponent to move
    return -sc.cp
  } catch {
    return null
  }
}

/** Drop every cached score. Explicit re-analysis calls this path (via
    evaluateMove's fresh option) so bad cached data cannot resurface. */
export function clearEngineCache(): void {
  scoreCache.clear()
}

/**
 * Engine check for one played move: the best move in the position, the eval of
 * best vs played (both from the mover's perspective), and the centipawn loss.
 * Returns null when the engine is unavailable or an evaluation fails.
 */
export async function evaluateMove(
  m: MoveToEvaluate,
  opts?: { fresh?: boolean; quick?: boolean },
): Promise<EngineEval | null> {
  if (!(await engineAvailable())) return null
  try {
    if (opts?.fresh) {
      // explicit re-analysis: never trust this session's cached scores
      scoreCache.delete(m.fenBefore)
      scoreCache.delete(m.fenAfter)
    }
    // Deep budget by default: this search's best move is shown as a
    // recommendation. The quick option is for the NON-studied side's moves —
    // context, not coaching — where the eval-bar sweep has usually already
    // cached both positions, making the check close to free.
    // (fenAfter of one move IS fenBefore of the next, so scores chain
    // through the cache and most moves cost one search, not two.)
    const budget = opts?.quick ? QUICK_MOVETIME_MS : DEEP_MOVETIME_MS
    const before = await scorePosition(m.fenBefore, budget) // the player is to move

    // If the played move ended the game, score it directly instead of asking
    // the engine to search a terminal position.
    let evalPlayed: number
    const afterGame = new Chess(m.fenAfter)
    if (afterGame.isCheckmate()) {
      evalPlayed = MATE_CP // the mover delivered mate
    } else if (afterGame.isDraw()) {
      evalPlayed = 0
    } else {
      const after = await scorePosition(m.fenAfter, budget) // opponent to move
      evalPlayed = -after.cp
    }

    // Exact match including the promotion piece: an underpromotion is NOT the
    // engine's queen promotion, and claiming so ships a contradictory pv.
    const playedUci = m.from + m.to + (m.promotion ?? '')
    const isBest = !!before.bestUci && before.bestUci === playedUci
    const cpLoss = isBest ? 0 : Math.max(0, before.cp - evalPlayed)

    // Best move in SAN for display. If the engine's move is not legal in this
    // position, the result is corrupt (e.g. a line that belongs to another
    // search) — report NO engine data rather than a wrong recommendation.
    let bestSan: string | null = null
    if (before.bestUci) {
      try {
        const c = new Chess(m.fenBefore)
        const mv = c.move({
          from: before.bestUci.slice(0, 2),
          to: before.bestUci.slice(2, 4),
          promotion: before.bestUci[4],
        })
        if (mv) bestSan = mv.san
      } catch {
        /* illegal — treated as corrupt below */
      }
    }
    if (!bestSan) return null

    const out: EngineEval = {
      bestSan,
      evalBest: before.cp,
      evalPlayed,
      cpLoss,
      isBest,
      depth: before.depth,
    }
    // The expected continuation in SAN (replayed from the position; stop at
    // the first move that doesn't apply — a stale tail is worse than a short line).
    if (before.pvUci.length > 1) {
      const pv: string[] = []
      try {
        const c = new Chess(m.fenBefore)
        for (const uci of before.pvUci.slice(0, 8)) {
          try {
            const mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
            if (!mv) break
            pv.push(mv.san)
          } catch {
            break // keep the legal prefix
          }
        }
      } catch {
        /* bad fen — keep the check without a line */
      }
      if (pv.length > 1) out.pv = pv
    }
    return out
  } catch {
    return null
  }
}
