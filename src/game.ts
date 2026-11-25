// PGN parsing (browser side) using chess.js. Produces the move list with the
// board positions before/after each move, which the UI renders and which we
// send to the analysis endpoint.

import { Chess } from 'chess.js'
import type { AnalyzeTarget, GameMove, ParsedMove } from './shared/types'

export interface ParsedGame {
  headers: Record<string, string>
  moves: ParsedMove[]
  /** ply -> centipawns after that move from WHITE's perspective, parsed from
      the PGN's [%eval] comments (lichess-analysed games carry them) */
  evals?: Record<number, number>
}

// Lichess writes "[%eval 0.18]" (pawns, White's perspective) or "[%eval #-5]"
// (mate in 5 against White) into move comments. #-1,1 style variants exist.
const EVAL_TAG_RE = /\[%eval\s+(#?-?\d+(?:[.,]\d+)?)/
const PGN_MATE_CP = 10_000

function evalFromComment(comment: string): number | undefined {
  const m = comment.match(EVAL_TAG_RE)
  if (!m) return undefined
  const raw = m[1]
  if (raw.startsWith('#')) {
    const n = parseInt(raw.slice(1), 10)
    if (!Number.isFinite(n) || n === 0) return undefined
    return n > 0 ? PGN_MATE_CP : -PGN_MATE_CP
  }
  const pawns = parseFloat(raw.replace(',', '.'))
  return Number.isFinite(pawns) ? Math.round(pawns * 100) : undefined
}

export class PgnError extends Error {}

export function parsePgn(pgn: string): ParsedGame {
  const text = pgn.trim()
  if (!text) throw new PgnError('Please paste or upload a PGN first.')
  const chess = new Chess()
  try {
    chess.loadPgn(text)
  } catch {
    throw new PgnError('Could not read that PGN — check the moves are valid and try again.')
  }
  const verbose = chess.history({ verbose: true }) as unknown as Array<{
    color: 'w' | 'b'
    from: string
    to: string
    san: string
    before: string
    after: string
  }>
  if (!verbose.length) throw new PgnError('No moves found in that PGN.')

  const moves: ParsedMove[] = verbose.map((m, ply) => {
    // Use the real fullmove counter from the FEN so games that start from a
    // custom position (or with Black to move) still get correct move numbers.
    const fullmove = parseInt(m.before.split(' ')[5], 10)
    return {
      ply,
      moveNumber: Number.isFinite(fullmove) ? fullmove : Math.floor(ply / 2) + 1,
      color: m.color,
      san: m.san,
      from: m.from,
      to: m.to,
      ...((m as { promotion?: string }).promotion
        ? { promotion: (m as { promotion?: string }).promotion }
        : {}),
      fenBefore: m.before,
      fenAfter: m.after,
    }
  })

  // Evals shipped inside the PGN (lichess analysis): comments are keyed by
  // the position they follow, which is each move's fenAfter.
  let evals: Record<number, number> | undefined
  try {
    const byFen = new Map(chess.getComments().map((c) => [c.fen, c.comment]))
    for (const m of moves) {
      const comment = byFen.get(m.fenAfter)
      if (!comment) continue
      const cp = evalFromComment(comment)
      if (cp === undefined) continue
      ;(evals ??= {})[m.ply] = cp
    }
  } catch {
    /* comments are a bonus — never fail the parse over them */
  }

  return { headers: chess.getHeaders() as Record<string, string>, moves, evals }
}

const TAG_LINE_RE = /^\s*\[[A-Za-z0-9_]+\s+"/

/**
 * Split a PGN database — several games one after another, as chess.com and
 * Lichess exports write them — into one text per game. A game starts at a tag
 * line ([Name "value"]) that follows movetext; brace comments are tracked so a
 * comment spanning lines can't be mistaken for a boundary. A single game
 * (with or without tags) comes back as one entry; tag blocks without moves
 * are dropped.
 */
export function splitPgnGames(text: string): string[] {
  const games: string[] = []
  let cur: string[] = []
  let sawMoves = false
  let inComment = false
  const flush = () => {
    const g = cur.join('\n').trim()
    if (g && sawMoves) games.push(g)
    cur = []
    sawMoves = false
  }
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const isTag = !inComment && TAG_LINE_RE.test(line)
    if (isTag && sawMoves) flush()
    cur.push(line)
    if (isTag || !line.trim()) continue
    sawMoves = true
    for (const ch of line) {
      if (ch === '{') inComment = true
      else if (ch === '}') inComment = false
    }
  }
  flush()
  return games
}

/** A PGN tag's value read straight from the text (no full parse). */
export function pgnTag(pgn: string, name: string): string {
  const m = pgn.match(new RegExp(`^\\s*\\[${name}\\s+"((?:[^"\\\\]|\\\\.)*)"`, 'm'))
  return m ? m[1].trim() : ''
}

/**
 * The player who appears in EVERY game of a multi-game PGN — whoever
 * exported their own games — or null. Matched case-insensitively; returned as
 * first spelled. Needs at least two games.
 */
export function commonPlayer(games: string[]): string | null {
  if (games.length < 2) return null
  let candidates: Map<string, string> | null = null
  for (const g of games) {
    const names = new Map<string, string>()
    for (const tag of ['White', 'Black']) {
      const n = pgnTag(g, tag)
      if (n && n !== '?') names.set(n.toLowerCase(), n)
    }
    if (candidates === null) candidates = names
    else for (const k of [...candidates.keys()]) if (!names.has(k)) candidates.delete(k)
    if (candidates.size === 0) return null
  }
  return candidates && candidates.size === 1 ? [...candidates.values()][0] : null
}

/** Which colour `player` had in a game (case-insensitive); null if neither. */
export function sideOf(pgn: string, player: string): 'w' | 'b' | null {
  const p = player.toLowerCase()
  if (pgnTag(pgn, 'White').toLowerCase() === p) return 'w'
  if (pgnTag(pgn, 'Black').toLowerCase() === p) return 'b'
  return null
}

export function toGameMoves(moves: ParsedMove[]): GameMove[] {
  return moves.map((m) => ({ ply: m.ply, moveNumber: m.moveNumber, color: m.color, san: m.san }))
}

export function toTargets(moves: ParsedMove[], plies: number[]): AnalyzeTarget[] {
  return plies
    .map((ply) => moves[ply])
    .filter(Boolean)
    .map((m) => ({ ply: m.ply, fenAfter: m.fenAfter }))
}

export const SAMPLE_PGN = `[Event "Immortal Game"]
[Site "London"]
[Date "1851.06.21"]
[White "Anderssen, Adolf"]
[Black "Kieseritzky, Lionel"]
[Result "1-0"]

1. e4 e5 2. f4 exf4 3. Bc4 Qh4+ 4. Kf1 b5 5. Bxb5 Nf6 6. Nf3 Qh6 7. d3 Nh5
8. Nh4 Qg5 9. Nf5 c6 10. g4 Nf6 11. Rg1 cxb5 12. h4 Qg6 13. h5 Qg5 14. Qf3 Ng8
15. Bxf4 Qf6 16. Nc3 Bc5 17. Nd5 Qxb2 18. Bd6 Bxg1 19. e5 Qxa1+ 20. Ke2 Na6
21. Nxg7+ Kd8 22. Qf6+ Nxf6 23. Be7# 1-0`
