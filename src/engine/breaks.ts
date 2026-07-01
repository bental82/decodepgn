// Candidate pawn-break detection. A break here is a pawn PUSH that, once made,
// attacks an enemy pawn (challenging the opponent's structure and threatening to
// open a file or diagonal). This captures all the classic breaks: e4/c4 vs d5,
// b5 vs c6, f5 vs e6/g6, ...c5 / ...e5 vs d4, etc.

import { FILES, fileIndex, opposite, pawnAttackSquares } from './board'
import { loadWithTurn } from './chessutil'
import type { Color, PawnBreak, Square } from './types'

export function breaksFor(fen: string, color: Color): PawnBreak[] {
  const realTurn = (fen.split(' ')[1] as Color) || 'w'
  const chess = loadWithTurn(fen, color)

  const enemy = opposite(color)
  const pieceAt = (sq: Square) => chess.get(sq as any)

  // files carrying a friendly rook/queen -> break is more "prepared"
  const heavyFiles = new Set<string>()
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell && cell.color === color && (cell.type === 'r' || cell.type === 'q')) {
        heavyFiles.add(FILES[fileIndex(cell.square)])
      }
    }
  }

  const out: PawnBreak[] = []
  const seen = new Set<string>()
  let moves: any[]
  try {
    moves = chess.moves({ verbose: true })
  } catch {
    return []
  }
  for (const m of moves) {
    if (m.piece !== 'p' || m.captured) continue // pushes only
    const dest = m.to as Square
    for (const atk of pawnAttackSquares(color, dest)) {
      const target = pieceAt(atk)
      if (target && target.type === 'p' && target.color === enemy) {
        const fromFile = FILES[fileIndex(m.from)]
        const targetFile = FILES[fileIndex(atk)]
        const key = m.san
        if (seen.has(key)) continue
        seen.add(key)
        const prepared = heavyFiles.has(fromFile) || heavyFiles.has(targetFile)
        out.push({
          move: m.san,
          fromFile,
          pushSquare: dest,
          challenges: atk,
          opensFiles: [...new Set([fromFile, targetFile])],
          legalNow: realTurn === color,
          prepared,
        })
      }
    }
  }
  return out
}
