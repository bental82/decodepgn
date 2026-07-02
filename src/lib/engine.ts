// Client-side Stockfish (18 lite, single-threaded WASM) running in a Web
// Worker. Used to ground the AI coaching in an objective check: for each
// analysed move we compute the engine's best move and the centipawn cost of
// the played move, and send that alongside the position to the AI.
//
// Everything here is best-effort: if the engine fails to load (old browser,
// blocked wasm), analysis proceeds without engine data.

import { Chess } from 'chess.js'
import type { EngineEval } from '../shared/types'

const ENGINE_URL = `${import.meta.env.BASE_URL}engine/stockfish-18-lite-single.js`
const MOVETIME_MS = 350 // per position; two positions per analysed move
const MAX_DEPTH = 18
const MATE_CP = 10_000

interface ScoredPosition {
  cp: number // from the side-to-move's perspective
  bestUci: string | null
  depth: number
}

// Positions repeat across the whole-game eval sweep and per-move checks
// (fenBefore of ply n === fenAfter of ply n-1), so cache scores by FEN.
const scoreCache = new Map<string, ScoredPosition>()
const SCORE_CACHE_MAX = 4000

let workerPromise: Promise<Worker> | null = null
let engineBroken = false
let initFailures = 0
const MAX_INIT_FAILURES = 3
// Single worker — serialize evaluations through a promise chain.
let queue: Promise<unknown> = Promise.resolve()

function initWorker(): Promise<Worker> {
  return new Promise((resolve, reject) => {
    let w: Worker
    try {
      w = new Worker(ENGINE_URL)
    } catch (e) {
      reject(e)
      return
    }
    const timer = setTimeout(() => reject(new Error('Engine init timed out')), 45_000)
    const onMsg = (e: MessageEvent) => {
      const line = String(e.data)
      if (line === 'uciok') {
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
    // A slow network can fail the first 7MB wasm download — allow retries
    // before giving up on the session.
    workerPromise = null
    initFailures++
    if (initFailures >= MAX_INIT_FAILURES) engineBroken = true
    return false
  }
}

function scorePosition(fen: string): Promise<ScoredPosition> {
  const hit = scoreCache.get(fen)
  if (hit) return Promise.resolve(hit)
  const run = async (): Promise<ScoredPosition> => {
    const w = await getWorker()
    return new Promise((resolve, reject) => {
      let last: ScoredPosition = { cp: 0, bestUci: null, depth: 0 }
      const timer = setTimeout(() => {
        w.removeEventListener('message', onMsg)
        reject(new Error('Engine evaluation timed out'))
      }, 10_000)
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
            const pv = line.match(/ pv ([a-h][1-8][a-h][1-8][qrbn]?)/)
            last = { cp, bestUci: pv ? pv[1] : last.bestUci, depth }
          }
        } else if (line.startsWith('bestmove')) {
          clearTimeout(timer)
          w.removeEventListener('message', onMsg)
          const bm = line.split(' ')[1]
          const scored = { ...last, bestUci: bm && bm !== '(none)' ? bm : last.bestUci }
          if (scoreCache.size >= SCORE_CACHE_MAX) scoreCache.clear()
          scoreCache.set(fen, scored)
          resolve(scored)
        }
      }
      w.addEventListener('message', onMsg)
      w.postMessage('position fen ' + fen)
      w.postMessage(`go movetime ${MOVETIME_MS} depth ${MAX_DEPTH}`)
    })
  }
  const p = queue.then(run, run)
  queue = p.catch(() => {})
  return p
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
}

/**
 * Engine check for one played move: the best move in the position, the eval of
 * best vs played (both from the mover's perspective), and the centipawn loss.
 * Returns null when the engine is unavailable or an evaluation fails.
 */
export async function evaluateMove(m: MoveToEvaluate): Promise<EngineEval | null> {
  if (!(await engineAvailable())) return null
  try {
    const before = await scorePosition(m.fenBefore) // the player is to move

    // If the played move ended the game, score it directly instead of asking
    // the engine to search a terminal position.
    let evalPlayed: number
    const afterGame = new Chess(m.fenAfter)
    if (afterGame.isCheckmate()) {
      evalPlayed = MATE_CP // the mover delivered mate
    } else if (afterGame.isDraw()) {
      evalPlayed = 0
    } else {
      const after = await scorePosition(m.fenAfter) // opponent to move
      evalPlayed = -after.cp
    }

    const isBest = !!before.bestUci && before.bestUci.startsWith(m.from + m.to)
    const cpLoss = isBest ? 0 : Math.max(0, before.cp - evalPlayed)

    // Best move in SAN for display; fall back to the raw UCI string.
    let bestSan = before.bestUci ?? ''
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
        /* keep uci */
      }
    }

    return { bestSan, evalBest: before.cp, evalPlayed, cpLoss, isBest, depth: before.depth }
  } catch {
    return null
  }
}
