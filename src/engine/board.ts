// Turn-independent board geometry helpers. We deliberately compute mobility and
// attacks ourselves (rather than via chess.js `moves`, which only works for the
// side to move) so a rule can reason about any piece in any position.

import type { Color, Piece, PieceType, Square, SquareColor } from './types'

export const FILES = 'abcdefgh'
export const RANKS = '12345678'

export const PIECE_VALUE: Record<PieceType, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
}

export const PIECE_NAME: Record<PieceType, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
}

export function fileIndex(sq: Square): number {
  return FILES.indexOf(sq[0])
}

export function rankIndex(sq: Square): number {
  // rank '1' -> 0 ... rank '8' -> 7
  return RANKS.indexOf(sq[1])
}

export function makeSquare(fi: number, ri: number): Square {
  return FILES[fi] + RANKS[ri]
}

export function onBoard(fi: number, ri: number): boolean {
  return fi >= 0 && fi < 8 && ri >= 0 && ri < 8
}

export function squareColorOf(sq: Square): SquareColor {
  return (fileIndex(sq) + rankIndex(sq)) % 2 === 0 ? 'dark' : 'light'
}

export function opposite(color: Color): Color {
  return color === 'w' ? 'b' : 'w'
}

/** A simple square -> piece map, built from a chess.js board() array. */
export type BoardMap = Map<Square, Piece>

export function boardMapFromArray(
  rows: ({ square: Square; type: PieceType; color: Color } | null)[][],
): BoardMap {
  const map: BoardMap = new Map()
  for (const row of rows) {
    for (const cell of row) {
      if (cell) map.set(cell.square, { type: cell.type, color: cell.color, square: cell.square })
    }
  }
  return map
}

const KNIGHT_OFFSETS = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
]

const BISHOP_DIRS = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
]

const ROOK_DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

const KING_DIRS = [...BISHOP_DIRS, ...ROOK_DIRS]

/**
 * Squares a piece geometrically reaches (empty squares plus the first enemy
 * square on each ray). Turn independent. Pawn pushes are included only when the
 * target is empty; pawn captures only when an enemy sits there.
 */
export function reachableSquares(board: BoardMap, from: Square): Square[] {
  const piece = board.get(from)
  if (!piece) return []
  const fi = fileIndex(from)
  const ri = rankIndex(from)
  const out: Square[] = []
  const push = (f: number, r: number, capturesOnly = false, pushOnly = false) => {
    if (!onBoard(f, r)) return
    const sq = makeSquare(f, r)
    const occ = board.get(sq)
    if (occ) {
      if (!pushOnly && occ.color !== piece.color) out.push(sq)
    } else if (!capturesOnly) {
      out.push(sq)
    }
  }

  switch (piece.type) {
    case 'n':
      for (const [df, dr] of KNIGHT_OFFSETS) push(fi + df, ri + dr)
      break
    case 'k':
      for (const [df, dr] of KING_DIRS) push(fi + df, ri + dr)
      break
    case 'b':
      slide(board, piece, fi, ri, BISHOP_DIRS, out)
      break
    case 'r':
      slide(board, piece, fi, ri, ROOK_DIRS, out)
      break
    case 'q':
      slide(board, piece, fi, ri, KING_DIRS, out)
      break
    case 'p': {
      const dir = piece.color === 'w' ? 1 : -1
      const startRank = piece.color === 'w' ? 1 : 6
      // pushes
      if (onBoard(fi, ri + dir) && !board.get(makeSquare(fi, ri + dir))) {
        out.push(makeSquare(fi, ri + dir))
        if (ri === startRank && !board.get(makeSquare(fi, ri + 2 * dir))) {
          out.push(makeSquare(fi, ri + 2 * dir))
        }
      }
      // captures
      for (const df of [-1, 1]) push(fi + df, ri + dir, true)
      break
    }
  }
  return out
}

function slide(
  board: BoardMap,
  piece: Piece,
  fi: number,
  ri: number,
  dirs: number[][],
  out: Square[],
): void {
  for (const [df, dr] of dirs) {
    let f = fi + df
    let r = ri + dr
    while (onBoard(f, r)) {
      const sq = makeSquare(f, r)
      const occ = board.get(sq)
      if (occ) {
        if (occ.color !== piece.color) out.push(sq)
        break
      }
      out.push(sq)
      f += df
      r += dr
    }
  }
}

/** Squares that a pawn on `sq` attacks (diagonals), regardless of occupancy. */
export function pawnAttackSquares(color: Color, sq: Square): Square[] {
  const fi = fileIndex(sq)
  const ri = rankIndex(sq)
  const dir = color === 'w' ? 1 : -1
  const out: Square[] = []
  for (const df of [-1, 1]) {
    if (onBoard(fi + df, ri + dir)) out.push(makeSquare(fi + df, ri + dir))
  }
  return out
}

/** All pieces of a colour. */
export function piecesOf(board: BoardMap, color: Color): Piece[] {
  const out: Piece[] = []
  for (const p of board.values()) if (p.color === color) out.push(p)
  return out
}

export function findKing(board: BoardMap, color: Color): Square | undefined {
  for (const p of board.values()) if (p.type === 'k' && p.color === color) return p.square
  return undefined
}
