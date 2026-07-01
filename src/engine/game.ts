// PGN parsing via chess.js.

import { Chess } from 'chess.js'
import type { VerboseMove } from './types'

export interface ParsedGame {
  headers: Record<string, string>
  moves: VerboseMove[]
}

export class PgnError extends Error {}

export function parsePgn(pgn: string): ParsedGame {
  const text = pgn.trim()
  if (!text) throw new PgnError('Please paste a PGN first.')
  const chess = new Chess()
  try {
    chess.loadPgn(text, { sloppy: true } as any)
  } catch (e) {
    // Retry without options for older/newer signatures, then surface a clean error.
    try {
      chess.loadPgn(text)
    } catch {
      throw new PgnError(
        'Could not parse that PGN. Check that the moves are valid and try again.',
      )
    }
  }
  const moves = chess.history({ verbose: true }) as unknown as VerboseMove[]
  if (!moves.length) {
    throw new PgnError('No moves found in that PGN.')
  }
  const headers = chess.getHeaders() as Record<string, string>
  return { headers, moves }
}
