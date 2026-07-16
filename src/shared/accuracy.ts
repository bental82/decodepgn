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

// Two-search noise floor: evalBest and evalPlayed come from independent
// searches that disagree by a few centipawns on nearly every move, so raw
// eval differences under-score even perfect play. Below this loss a move
// counts as clean.
const NOISE_CP = 15

/** Accuracy (0-100) of one played move vs the engine's best in that position. */
export function moveAccuracy(e: EngineEval): number {
  // The engine's own verdict wins: its top move is a 100% move, full stop.
  if (e.isBest || e.cpLoss < NOISE_CP) return 100
  // Derive the win% drop from cpLoss (not raw evalPlayed) so the two-search
  // disagreement can't inflate the loss beyond what the engine measured.
  const drop = Math.max(0, winPct(e.evalBest) - winPct(e.evalBest - e.cpLoss))
  const acc = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669
  return Math.max(0, Math.min(100, acc))
}

function stdev(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length)
}

/**
 * Whole-game accuracy over the engine-checked moves, IN GAME ORDER: a
 * volatility-weighted mean of per-move accuracies — each move weighted by
 * how much the win% trajectory around it swung (clamped stdev over a
 * centered window), so decisive moments count a bit more and quiet padding
 * can't inflate the score.
 * Deliberately NO harmonic term: harmonic means collapse near zero, and a
 * real 25-move game with one mate blunder scored 52% where chess.com said
 * ~80%. CAPS2's stated behaviour — every move roughly equal influence,
 * blunders smoothed rather than catastrophic — matches the weighted mean.
 * Returns one decimal (e.g. 87.4), or null when no moves were checked.
 */
export function gameAccuracy(evals: EngineEval[]): number | null {
  if (!evals.length) return null
  const accs = evals.map(moveAccuracy)
  // Win% trajectory sampled at the player's moves: the position before the
  // first scored move, then the position after each scored move.
  const traj = [winPct(evals[0].evalBest), ...evals.map((e) => winPct(e.evalPlayed))]
  // A window CENTERED on each move, wide enough that the weight describes the
  // phase of the game around it — not just the move's own eval jump. Weight
  // spread kept gentle (1-6): a blunder counts several moves' worth, not the
  // whole game.
  const windowSize = Math.max(3, Math.min(8, Math.floor(traj.length / 5)))
  const half = Math.floor(windowSize / 2)
  const weights = accs.map((_, i) => {
    const centre = i + 1 // this move's resulting position in traj
    const xs = traj.slice(Math.max(0, centre - half), Math.min(traj.length, centre + half + 1))
    return Math.min(6, Math.max(1, stdev(xs)))
  })
  const wSum = weights.reduce((a, b) => a + b, 0)
  const weightedMean = accs.reduce((a, acc, i) => a + acc * weights[i], 0) / wSum
  return Math.round(weightedMean * 10) / 10
}
