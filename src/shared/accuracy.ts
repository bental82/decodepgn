// Chess.com-style accuracy: engine evals -> a familiar 0-100% score per move
// and per game. Uses the openly documented Lichess formulas: win probability
// from centipawns, exponential decay on the win% a move throws away, and a
// volatility-weighted game average (sharp phases count more than dead ones).

import type { EngineEval } from './types'

/** Win probability (0-100) for the side to move, from a centipawn eval. */
export function winPct(cp: number): number {
  const capped = Math.max(-1000, Math.min(1000, cp))
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * capped)) - 1)
}

/** Accuracy (0-100) of one played move vs the engine's best in that position. */
export function moveAccuracy(e: EngineEval): number {
  const drop = Math.max(0, winPct(e.evalBest) - winPct(e.evalPlayed))
  const acc = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669
  return Math.max(0, Math.min(100, acc))
}

function stdev(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length)
}

/**
 * Whole-game accuracy over the engine-checked moves, IN GAME ORDER.
 * Lichess's recipe: each move's accuracy is weighted by how much the win%
 * trajectory around it actually swung (clamped stdev over a sliding window),
 * so the moves that decided the game count more and long quiet stretches
 * can't drown an error out; the final score is the mean of that weighted
 * average and the unweighted harmonic mean (a blunder drags the score
 * without zeroing a clean game).
 * Returns one decimal (e.g. 87.4), or null when no moves were checked.
 */
export function gameAccuracy(evals: EngineEval[]): number | null {
  if (!evals.length) return null
  const accs = evals.map(moveAccuracy)
  // Win% trajectory sampled at the player's moves: the position before the
  // first scored move, then the position after each scored move.
  const traj = [winPct(evals[0].evalBest), ...evals.map((e) => winPct(e.evalPlayed))]
  const windowSize = Math.max(2, Math.min(8, Math.floor(evals.length / 10)))
  const weights = accs.map((_, i) => {
    // window ending at this move's resulting position
    const xs = traj.slice(Math.max(0, i + 2 - windowSize), i + 2)
    return Math.min(12, Math.max(0.5, stdev(xs)))
  })
  const wSum = weights.reduce((a, b) => a + b, 0)
  const weightedMean = accs.reduce((a, acc, i) => a + acc * weights[i], 0) / wSum
  const harmonic = accs.length / accs.reduce((a, b) => a + 1 / Math.max(b, 1), 0)
  return Math.round(((weightedMean + harmonic) / 2) * 10) / 10
}
