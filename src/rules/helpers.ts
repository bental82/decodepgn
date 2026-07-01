// Shared helpers for the rule layer. Rules stay short by leaning on these.

import { Chess } from 'chess.js'
import {
  FILES,
  PIECE_NAME,
  PIECE_VALUE,
  fileIndex,
  findKing,
  makeSquare,
  onBoard,
  opposite,
  rankIndex,
} from '../engine/board'
import { loadWithTurn } from '../engine/chessutil'
import { materialFor } from '../engine/position'
import { see } from '../engine/tactics'
import type {
  Color,
  MoveContext,
  PieceActivity,
  PieceType,
  PositionInfo,
  Rule,
  RuleCategory,
  RuleFinding,
  RuleStatus,
  Square,
  VerboseMove,
} from '../engine/types'

export function colorName(c: Color): string {
  return c === 'w' ? 'White' : 'Black'
}

export function pieceWord(t: PieceType): string {
  return PIECE_NAME[t]
}

export function fileOf(sq: Square): string {
  return FILES[fileIndex(sq)]
}

/** Selected colour's material balance at a point in the move. */
export function selMaterial(ctx: MoveContext, when: 'before' | 'after'): number {
  const info = when === 'before' ? ctx.before : ctx.after
  return materialFor(info, ctx.selectedColor)
}

export type AheadState = { state: 'ahead' | 'behind' | 'level'; margin: number }

export function aheadState(ctx: MoveContext, when: 'before' | 'after' = 'before'): AheadState {
  const m = selMaterial(ctx, when)
  if (m >= 1.5) return { state: 'ahead', margin: m }
  if (m <= -1.5) return { state: 'behind', margin: m }
  return { state: 'level', margin: m }
}

export function isCapture(move: VerboseMove): boolean {
  return !!move.captured
}

export function isCheck(move: VerboseMove): boolean {
  return move.san.includes('+') || move.san.includes('#')
}

export function activityAt(info: PositionInfo, square: Square): PieceActivity | undefined {
  return info.activity.find((a) => a.square === square)
}

/** The least active (non-pawn) piece for a colour. */
export function worstPiece(info: PositionInfo, color: Color): PieceActivity | undefined {
  return info.activity
    .filter((a) => a.color === color && a.type !== 'k')
    .sort((a, b) => a.score - b.score)[0]
}

/** Pieces of `color` attacked by an enemy piece on the given fen. */
export function attackersOf(fen: string, square: Square, byColor: Color): Square[] {
  const chess = new Chess()
  try {
    chess.load(fen, { skipValidation: true })
  } catch {
    return []
  }
  return chess.attackers(square as any, byColor) as unknown as Square[]
}

/** True when `square` is attacked by any piece of `byColor`. */
export function isAttackedBy(fen: string, square: Square, byColor: Color): boolean {
  return attackersOf(fen, square, byColor).length > 0
}

/** Piece types of the `byColor` pieces attacking `square`. */
export function attackerPieceTypes(fen: string, square: Square, byColor: Color): PieceType[] {
  const chess = new Chess()
  try {
    chess.load(fen, { skipValidation: true })
  } catch {
    return []
  }
  const out: PieceType[] = []
  for (const sq of chess.attackers(square as any, byColor)) {
    const p = chess.get(sq as any)
    if (p) out.push(p.type as PieceType)
  }
  return out
}

/** Did the move look like a piece-for-piece exchange (both sides lose a piece)? */
export interface TradeInfo {
  isTrade: boolean
  givenType?: PieceType // selected colour's piece that will be recaptured
  wonType?: PieceType // enemy piece captured
  recaptured: boolean
}

export function tradeInfo(ctx: MoveContext): TradeInfo {
  const m = ctx.move
  if (!m.captured || m.captured === 'k') return { isTrade: false, recaptured: false }
  // recaptured if the enemy has an attacker on the landing square after the move
  const recaptured = isAttackedBy(m.after, m.to, opposite(ctx.selectedColor))
  const bothPieces = m.piece !== 'p' && m.captured !== 'p'
  return {
    isTrade: bothPieces && recaptured,
    givenType: m.piece,
    wonType: m.captured,
    recaptured,
  }
}

/** Static exchange value of the move as played (positive = wins material). */
export function moveSee(ctx: MoveContext): number {
  const m = ctx.move
  if (!m.captured) {
    // non-capture: what can the opponent win in reply on the moved piece's square?
    return -see(m.after, m.to)
  }
  return PIECE_VALUE[m.captured] - see(m.after, m.to)
}

/** Enemy king square + squares selected colour attacks around it (after the move). */
export function enemyKingPressure(ctx: MoveContext, when: 'before' | 'after') {
  const info = when === 'before' ? ctx.before : ctx.after
  const enemy = opposite(ctx.selectedColor)
  const zone = info.king[enemy]
  return {
    kingSquare: zone.square,
    attackers: zone.attackers,
    defenders: zone.defenders,
    exposure: zone.exposure,
    weakSquares: zone.weakSquares,
    openFiles: zone.openFilesNearKing,
  }
}

/** Pawn tension: friendly and enemy pawns that attack each other. */
export function pawnTension(info: PositionInfo, color: Color): { own: Square; enemy: Square }[] {
  const chess = new Chess()
  try {
    chess.load(info.fen, { skipValidation: true })
  } catch {
    return []
  }
  const out: { own: Square; enemy: Square }[] = []
  const enemy = opposite(color)
  const dir = color === 'w' ? 1 : -1
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell || cell.type !== 'p' || cell.color !== color) continue
      const fi = fileIndex(cell.square)
      const ri = rankIndex(cell.square)
      for (const df of [-1, 1]) {
        if (!onBoard(fi + df, ri + dir)) continue
        const t = makeSquare(fi + df, ri + dir)
        const tp = chess.get(t as any)
        if (tp && tp.type === 'p' && tp.color === enemy) out.push({ own: cell.square, enemy: t })
      }
    }
  }
  return out
}

/** Is this move a flank pawn advance (a/b or g/h files)? */
export function isFlankPawnPush(move: VerboseMove): boolean {
  if (move.piece !== 'p') return false
  const f = fileOf(move.to)
  return f === 'a' || f === 'b' || f === 'g' || f === 'h'
}

/** King escape squares for `color` in the given fen. */
export function kingEscapeSquares(fen: string, color: Color): number {
  const chess = loadWithTurn(fen, color)
  const ksq = findKing(chessBoardMap(chess), color)
  if (!ksq) return 0
  try {
    return chess.moves({ square: ksq as any, verbose: true }).length
  } catch {
    return 0
  }
}

function chessBoardMap(chess: Chess) {
  const map = new Map<Square, { type: PieceType; color: Color; square: Square }>()
  for (const row of chess.board()) {
    for (const cell of row) if (cell) map.set(cell.square, cell as any)
  }
  return map
}

/** Count legal checks available to `color` in the given fen (a rough "forcing" gauge). */
export function availableChecks(fen: string, color: Color): number {
  const chess = loadWithTurn(fen, color)
  try {
    // count checks AND checkmates ('#' has no '+') — mate is the most forcing move
    return chess.moves({ verbose: true }).filter((m: any) => /[+#]/.test(m.san)).length
  } catch {
    return 0
  }
}

/** The king square plus its up-to-8 neighbours. */
export function kingZoneSquares(kingSq: Square): Square[] {
  const fi = fileIndex(kingSq)
  const ri = rankIndex(kingSq)
  const out: Square[] = []
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (onBoard(fi + df, ri + dr)) out.push(makeSquare(fi + df, ri + dr))
    }
  }
  return out
}

/** Squares of `byColor` pieces that bear on `kingColor`'s king zone. */
export function squaresAttackingKingZone(
  fen: string,
  kingColor: Color,
  byColor: Color,
): Set<Square> {
  const chess = new Chess()
  const set = new Set<Square>()
  try {
    chess.load(fen, { skipValidation: true })
  } catch {
    return set
  }
  const board = chessBoardMap(chess)
  const ksq = findKing(board, kingColor)
  if (!ksq) return set
  for (const sq of kingZoneSquares(ksq)) {
    for (const a of chess.attackers(sq as any, byColor)) set.add(a as unknown as Square)
  }
  return set
}

// ---- rule definition sugar -------------------------------------------------

export interface FindingCore {
  status: RuleStatus
  confidence: RuleFinding['confidence']
  importance: number
  explanation: string
  alternatives?: RuleFinding['alternatives']
}

export interface RuleMeta {
  id: string
  title: string
  category: RuleCategory
  description: string
  positiveSignals: string[]
  negativeSignals: string[]
}

export function defineRule(
  meta: RuleMeta,
  detect: (ctx: MoveContext) => FindingCore | null,
): Rule {
  return {
    ...meta,
    detect(ctx: MoveContext): RuleFinding | null {
      if (!ctx.bySelected) return null
      const core = detect(ctx)
      if (!core) return null
      return {
        ruleId: meta.id,
        title: meta.title,
        category: meta.category,
        ...core,
      }
    },
  }
}
