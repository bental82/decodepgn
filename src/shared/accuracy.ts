// Chess.com-style accuracy: engine evals -> a familiar 0-100% score per move
// and per game. Uses the openly documented Lichess formulas (win probability
// from centipawns, exponential decay on the win% a move throws away), which
// land in the same range players know from chess.com game reports.

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

/**
 * Whole-game accuracy over the engine-checked moves: the mean of the
 * arithmetic and harmonic means, so a blunder drags the score the way it does
 * on chess.com without one slip zeroing an otherwise clean game. Returns one
 * decimal (e.g. 87.4), or null when no moves were checked.
 */
export function gameAccuracy(evals: EngineEval[]): number | null {
  if (!evals.length) return null
  const accs = evals.map(moveAccuracy)
  const mean = accs.reduce((a, b) => a + b, 0) / accs.length
  const harmonic = accs.length / accs.reduce((a, b) => a + 1 / Math.max(b, 1), 0)
  return Math.round(((mean + harmonic) / 2) * 10) / 10
}
