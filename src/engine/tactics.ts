// Deterministic, engine-free tactical read of a position.
//
// The centrepiece is a static exchange evaluation (SEE) implemented by actually
// playing out the capture sequence with chess.js. Because chess.js only offers
// legal moves, pins and check-pins are handled correctly for free, and x-ray
// batteries resolve naturally as pieces come off the target square.

import { PIECE_VALUE, opposite } from './board'
import { loadFen, loadWithTurn } from './chessutil'
import type { Color, PieceType, Square, TacticalRead, VerboseMove } from './types'

/**
 * Net material (in points) the side to move wins by initiating a capture
 * sequence on `target`, assuming best play by both sides (least-valuable
 * attacker heuristic). Never negative: the side can decline to capture.
 */
export function see(fen: string, target: Square): number {
  const chess = loadFen(fen)
  const victim = chess.get(target as any)
  if (!victim || victim.type === 'k') return 0 // never "win" a king
  const caps = chess
    .moves({ verbose: true })
    .filter((m: any) => m.to === target && m.captured)
  if (caps.length === 0) return 0
  // least valuable attacker first
  caps.sort(
    (a: any, b: any) => PIECE_VALUE[a.piece as PieceType] - PIECE_VALUE[b.piece as PieceType],
  )
  const cap = caps[0]
  const gain = PIECE_VALUE[victim.type as keyof typeof PIECE_VALUE]
  const next = loadFen(fen)
  try {
    next.move({ from: cap.from, to: cap.to, promotion: 'q' })
  } catch {
    return 0
  }
  const reply = see(next.fen(), target)
  return Math.max(0, gain - reply)
}

/** Best capturing sequence available to `color`, searching every enemy piece. */
export function bestCaptureFor(
  fen: string,
  color: Color,
): { gain: number; square?: Square } {
  const chess = loadWithTurn(fen, color)
  const enemy = opposite(color)
  let best = 0
  let bestSquare: Square | undefined
  const scanFen = chess.fen()
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell || cell.color !== enemy || cell.type === 'k') continue
      const g = see(scanFen, cell.square)
      if (g > best) {
        best = g
        bestSquare = cell.square
      }
    }
  }
  return { gain: best, square: bestSquare }
}

/**
 * Static read from the perspective of the side to move in `fen`:
 *  - bestCaptureGain: material this side can win with one capture now.
 *  - hanging: this side's own pieces that would be lost if it were the
 *    opponent's move (loose / underdefended pieces).
 */
export function staticRead(fen: string): TacticalRead {
  const chess = loadFen(fen)
  const mover = chess.turn() as Color
  const inCheck = chess.inCheck()

  const best = bestCaptureFor(fen, mover)

  // Loose own pieces: pretend it is the opponent's move and see what they win.
  const oppFen = loadWithTurn(fen, opposite(mover)).fen()
  const hanging: TacticalRead['hanging'] = []
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell || cell.color !== mover || cell.type === 'k') continue
      const loss = see(oppFen, cell.square)
      if (loss > 0) hanging.push({ square: cell.square, type: cell.type, loss })
    }
  }
  hanging.sort((a, b) => b.loss - a.loss)

  return {
    bestCaptureGain: best.gain,
    bestCaptureSquare: best.square,
    hanging,
    inCheck,
  }
}

/** Did the played move realise (part of) the best capture that was available? */
export function moveCaptureGain(move: VerboseMove): number {
  if (!move.captured) return 0
  // SEE of the played capture: value of victim minus opponent's recapture.
  const gain = PIECE_VALUE[move.captured]
  const reply = see(move.after, move.to)
  return gain - reply
}
