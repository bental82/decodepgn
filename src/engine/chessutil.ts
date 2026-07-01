// chess.js loading helpers.
//
// NOTE: chess.js `setTurn()` is implemented as a null move and throws
// "Null move not allowed when in check". For hypothetical reads (mobility, SEE
// of the side-not-to-move, break generation) we instead flip the side to move by
// editing the FEN directly and loading with validation skipped, which works in
// every position — including ones where a king is in check.

import { Chess } from 'chess.js'

export function loadFen(fen: string): Chess {
  const chess = new Chess()
  try {
    chess.load(fen, { skipValidation: true })
  } catch {
    chess.load(fen)
  }
  return chess
}

export function loadWithTurn(fen: string, color: 'w' | 'b'): Chess {
  const parts = fen.split(' ')
  if (parts[1] !== color) {
    parts[1] = color
    parts[3] = '-' // en-passant target is side-relative; clear it when flipping
  }
  return loadFen(parts.join(' '))
}
