// Server-side Stockfish: the same lite-single WASM build the browser falls
// back to, running inside the Node serverless function. One instance per warm
// lambda, searches strictly serialized. Everything is best-effort — if the
// engine fails, analysis proceeds without engine data, exactly like the
// client-side path.
//
// This module is server-only. It must never be imported by browser code.

import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { Chess } from 'chess.js'
import type { EngineEval } from '../shared/types'

const requireCjs = createRequire(import.meta.url)

// Same budgets as the client (src/lib/engine.ts): QUICK feeds context moves
// and the eval bar, DEEP feeds the checks whose best move is shown as a
// recommendation.
export const QUICK_MOVETIME_MS = 350
export const DEEP_MOVETIME_MS = 1200
const QUICK_MAX_DEPTH = 18
const DEEP_MAX_DEPTH = 24
const MATE_CP = 10_000
const SEARCH_TIMEOUT_MS = 10_000
const INIT_TIMEOUT_MS = 30_000

interface ScoredPosition {
  cp: number // from the side-to-move's perspective
  bestUci: string | null
  pvUci: string[]
  depth: number
  movetime: number
}

const scoreCache = new Map<string, ScoredPosition>()
const SCORE_CACHE_MAX = 4000

interface EngineInstance {
  send: (cmd: string) => void
  setListener: (fn: (line: string) => void) => void
}

let enginePromise: Promise<EngineInstance> | null = null
let engineBroken = false
// one search at a time — a plain promise chain is queue enough server-side
let searchChain: Promise<unknown> = Promise.resolve()

async function initEngine(): Promise<EngineInstance> {
  const jsPath = requireCjs.resolve('stockfish/src/stockfish-17.1-lite-single-03e3232.js')
  const wasmPath = requireCjs.resolve('stockfish/src/stockfish-17.1-lite-single-03e3232.wasm')
  const wrapper = requireCjs(jsPath) as () => (cfg: object) => Promise<{
    ccall: (fn: string, ret: null, args: string[], vals: unknown[], opts: object) => unknown
  }>
  let listener: (line: string) => void = () => {}
  // The emscripten glue, on detecting Node, does a bare `fetch = null` to
  // force its fs-based wasm loading — nuking GLOBAL fetch for the whole
  // lambda, which silently kills every later Supabase/Anthropic call in the
  // warm instance. We load the wasm ourselves (wasmBinary), so restore fetch
  // the moment the factory call returns.
  const savedFetch = globalThis.fetch
  let ready: Promise<{
    ccall: (fn: string, ret: null, args: string[], vals: unknown[], opts: object) => unknown
  }>
  try {
    ready = wrapper()({
      wasmBinary: readFileSync(wasmPath),
      listener: (line: unknown) => listener(String(line)),
    })
  } finally {
    globalThis.fetch = savedFetch
  }
  const timeout = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error('Engine init timed out')), INIT_TIMEOUT_MS),
  )
  const mod = await Promise.race([ready, timeout])
  const inst: EngineInstance = {
    send: (cmd) => void mod.ccall('command', null, ['string'], [cmd], { async: true }),
    setListener: (fn) => {
      listener = fn
    },
  }
  // handshake so the first real search doesn't race engine startup
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Engine uciok timed out')), INIT_TIMEOUT_MS)
    inst.setListener((l) => {
      if (l === 'uciok') {
        clearTimeout(t)
        resolve()
      }
    })
    inst.send('uci')
  })
  return inst
}

function getEngine(): Promise<EngineInstance> {
  if (!enginePromise) enginePromise = initEngine()
  return enginePromise
}

export async function engineAvailable(): Promise<boolean> {
  if (engineBroken) return false
  try {
    await getEngine()
    return true
  } catch {
    // one retry with a fresh instance, then give up for this lambda's lifetime
    enginePromise = null
    try {
      await getEngine()
      return true
    } catch {
      engineBroken = true
      return false
    }
  }
}

function runSearch(fen: string, movetime: number): Promise<ScoredPosition> {
  const doIt = async (): Promise<ScoredPosition> => {
    const w = await getEngine()
    return new Promise<ScoredPosition>((resolve, reject) => {
      let last: ScoredPosition = { cp: 0, bestUci: null, pvUci: [], depth: 0, movetime }
      let settled = false
      const fail = (why: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // a hung/poisoned instance is discarded; the next search re-inits
        enginePromise = null
        reject(new Error(why))
      }
      const timer = setTimeout(() => fail('Engine evaluation timed out'), SEARCH_TIMEOUT_MS)
      w.setListener((line) => {
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
          const bm = line.split(' ')[1]
          const bestUci = bm && bm !== '(none)' ? bm : last.bestUci
          const pvUci = bestUci && last.pvUci[0] === bestUci ? last.pvUci : bestUci ? [bestUci] : []
          const scored = { ...last, bestUci, pvUci }
          if (scoreCache.size >= SCORE_CACHE_MAX) scoreCache.clear()
          scoreCache.set(fen, scored)
          resolve(scored)
        }
      })
      w.send('position fen ' + fen)
      const depthCap = movetime > QUICK_MOVETIME_MS ? DEEP_MAX_DEPTH : QUICK_MAX_DEPTH
      w.send(`go movetime ${movetime} depth ${depthCap}`)
    })
  }
  // serialize: a search must never start while another is running
  const next = searchChain.then(doIt, doIt)
  searchChain = next.catch(() => {})
  return next
}

function scorePosition(fen: string, movetime = QUICK_MOVETIME_MS): Promise<ScoredPosition> {
  const hit = scoreCache.get(fen)
  if (hit && hit.movetime >= movetime) return Promise.resolve(hit)
  return runSearch(fen, movetime)
}

export function clearEngineCache(): void {
  scoreCache.clear()
}

export interface MoveToEvaluate {
  fenBefore: string
  fenAfter: string
  from: string
  to: string
  promotion?: string
}

/** Eval AFTER a move in centipawns from WHITE's perspective (the eval bar).
    Uses whatever is cached from the per-move checks; only searches when the
    budget allows. Null when unavailable. */
export function evalAfterFromCache(fenAfter: string, mover: 'w' | 'b'): number | null {
  const sc = scoreCache.get(fenAfter)
  if (!sc) return null
  return mover === 'w' ? -sc.cp : sc.cp
}

/** Port of the client's evaluateMove (src/lib/engine.ts): best move, evals of
    best vs played, centipawn loss. Null when the engine is unavailable or an
    evaluation fails. */
export async function evaluateMoveServer(
  m: MoveToEvaluate,
  opts?: { fresh?: boolean; quick?: boolean },
): Promise<EngineEval | null> {
  if (!(await engineAvailable())) return null
  try {
    if (opts?.fresh) {
      scoreCache.delete(m.fenBefore)
      scoreCache.delete(m.fenAfter)
    }
    const budget = opts?.quick ? QUICK_MOVETIME_MS : DEEP_MOVETIME_MS
    const before = await scorePosition(m.fenBefore, budget)

    let evalPlayed: number
    const afterGame = new Chess(m.fenAfter)
    if (afterGame.isCheckmate()) {
      evalPlayed = MATE_CP
    } else if (afterGame.isDraw()) {
      evalPlayed = 0
    } else {
      const after = await scorePosition(m.fenAfter, budget)
      evalPlayed = -after.cp
    }

    const playedUci = m.from + m.to + (m.promotion ?? '')
    const isBest = !!before.bestUci && before.bestUci === playedUci
    const cpLoss = isBest ? 0 : Math.max(0, before.cp - evalPlayed)

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
            break
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
