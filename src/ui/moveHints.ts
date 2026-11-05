// Why a tap on an interactive board did nothing. The board quietly ignores a
// piece with no legal moves (blocked, boxed in, pinned, or not answering a
// check) — correct chess, but with no response at all it reads as "I can't
// pick that piece". These lines say why.

import { Chess, type Color, type Square } from 'chess.js'

const NAMES: Record<string, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
}

/** Whether taking `square`'s piece off the board would expose its own king. */
function pinnedToKing(fen: string, square: Square, color: Color): boolean {
  const g = new Chess(fen)
  let king: Square | null = null
  for (const row of g.board()) {
    for (const p of row) if (p && p.type === 'k' && p.color === color) king = p.square
  }
  if (!king || king === square) return false
  g.remove(square)
  return g.isAttacked(king, color === 'w' ? 'b' : 'w')
}

/**
 * The reason a tap on `square` neither moved nor selected anything, for the
 * side to move in `fen`; `selected` is the piece that was picked up before
 * the tap, if any. Null when there is nothing worth saying (an empty square:
 * the tap just put the piece back down).
 */
export function whyCantMove(fen: string, square: string, selected: string | null): string | null {
  try {
    const g = new Chess(fen)
    const piece = g.get(square as Square)
    if (!piece) return null
    const name = NAMES[piece.type]
    const me = g.turn()
    if (piece.color !== me) {
      const held = selected ? g.get(selected as Square) : undefined
      return held
        ? `Your ${NAMES[held.type]} on ${selected} can't take the ${name} on ${square} — the dots show where it can go.`
        : `That's your opponent's ${name} — tap one of your own pieces.`
    }
    if (g.inCheck()) {
      return `You're in check, so only moves that answer it are legal — the ${name} on ${square} has none.`
    }
    if (piece.type !== 'k' && pinnedToKing(fen, square as Square, me)) {
      return `The ${name} on ${square} is pinned to your king — it can't move.`
    }
    return piece.type === 'p'
      ? `The pawn on ${square} is blocked — it can't move here.`
      : `The ${name} on ${square} has no legal moves here.`
  } catch {
    return null
  }
}
