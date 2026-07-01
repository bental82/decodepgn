// Core domain types shared by the whole engine and rule layer.

export type Color = 'w' | 'b'
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k'
export type Square = string // e.g. "e4"
export type SquareColor = 'light' | 'dark'

/** A single piece on a board square. */
export interface Piece {
  type: PieceType
  color: Color
  square: Square
}

/** Verbose move as produced by chess.js history({ verbose: true }). */
export interface VerboseMove {
  color: Color
  from: Square
  to: Square
  piece: PieceType
  captured?: PieceType
  promotion?: PieceType
  flags: string
  san: string
  lan: string
  before: string // FEN before the move
  after: string // FEN after the move
}

export interface MaterialCount {
  p: number
  n: number
  b: number
  r: number
  q: number
  points: number // pawn=1, n/b=3, r=5, q=9
}

export interface MaterialBalance {
  white: MaterialCount
  black: MaterialCount
  /** points from the perspective of the given color (positive = that color is ahead). */
  diff: number
}

/** Activity information for one piece. */
export interface PieceActivity {
  square: Square
  type: PieceType
  color: Color
  /** number of empty/enemy squares the piece can reach (geometric, turn independent). */
  mobility: number
  /** true if the piece stands on an advanced central-ish square. */
  centralized: boolean
  /** for bishops: number of friendly pawns on the bishop's square colour. */
  blockingPawns?: number
  /** heuristic 0-100 activity score. */
  score: number
}

export interface PawnInfo {
  square: Square
  file: string
  rank: number
  doubled: boolean
  isolated: boolean
  backward: boolean
  passed: boolean
}

export interface PawnStructure {
  pawns: PawnInfo[]
  doubledFiles: string[]
  isolatedSquares: Square[]
  backwardSquares: Square[]
  passedSquares: Square[]
}

export interface FileInfo {
  /** files with no pawns of either colour. */
  open: string[]
  /** files with no white pawns (targets/pressure for white rooks). */
  semiOpenForWhite: string[]
  /** files with no black pawns (targets/pressure for black rooks). */
  semiOpenForBlack: string[]
}

export type CenterState = 'open' | 'semi-open' | 'closed' | 'locked'

export interface CenterInfo {
  state: CenterState
  /** 0 (fully locked) .. 100 (wide open). */
  openness: number
  /** number of pawns of each colour on the central files c-f, ranks 3-6. */
  whiteCentralPawns: number
  blackCentralPawns: number
  /** blocked pawn contacts in the centre (a pawn directly blocked by an enemy pawn). */
  lockedContacts: number
}

export interface KingZone {
  color: Color
  square: Square
  castledSide: 'king' | 'queen' | 'center'
  /** friendly pawns shielding the king. */
  shieldPawns: number
  /** enemy pieces bearing on the king zone. */
  attackers: number
  /** friendly pieces defending the king zone. */
  defenders: number
  /** open or half-open files next to the king. */
  openFilesNearKing: string[]
  /** classic weak squares (f/g/h or a/b/c near the king) that lack pawn cover. */
  weakSquares: Square[]
  /** 0 (very safe) .. 100 (very exposed). */
  exposure: number
}

export interface BishopInfo {
  square: Square
  color: Color
  squareColor: SquareColor
  /** friendly pawns fixed on the bishop's colour. */
  ownPawnsSameColor: number
  /** true when the bishop is hemmed in by its own pawns. */
  bad: boolean
  mobility: number
}

export interface OutpostInfo {
  square: Square
  /** the colour that could use this outpost. */
  color: Color
  /** true when a friendly pawn already defends the square. */
  pawnSupported: boolean
  /** true when a friendly knight already sits there. */
  occupiedByKnight: boolean
}

/** Everything we know about a single position, independent of perspective. */
export interface PositionInfo {
  fen: string
  turn: Color
  material: MaterialBalance
  activity: PieceActivity[]
  pawns: { w: PawnStructure; b: PawnStructure }
  files: FileInfo
  center: CenterInfo
  space: { white: number; black: number }
  king: { w: KingZone; b: KingZone }
  bishops: { w: BishopInfo[]; b: BishopInfo[] }
  outposts: OutpostInfo[]
  /** true when exactly one bishop each and they travel on opposite colours. */
  oppositeColoredBishops: boolean
  /** true when both queens are off the board. */
  queensOff: boolean
}

/** A candidate pawn break for a colour. */
export interface PawnBreak {
  move: string // SAN of the break, when it is currently legal; otherwise the target push square
  fromFile: string
  pushSquare: Square
  /** the enemy pawn square being challenged. */
  challenges: Square
  /** file(s) that may open if the break happens. */
  opensFiles: string[]
  /** true when the break is a legal move in the current position. */
  legalNow: boolean
  /** true when the breaking pawn is currently defended / ready. */
  prepared: boolean
}

/** Static tactical read of a position/move (no engine required). */
export interface TacticalRead {
  /** material the side to move can win with one capture sequence (SEE), in points. */
  bestCaptureGain: number
  bestCaptureSquare?: Square
  /** own pieces that are currently hanging (opponent wins material by capturing). */
  hanging: { square: Square; type: PieceType; loss: number }[]
  inCheck: boolean
}

export type RuleStatus =
  | 'follows'
  | 'partially-follows'
  | 'violates'
  | 'relevant-unclear'

export type Confidence = 'high' | 'medium' | 'low'

export type RuleCategory =
  | 'trading'
  | 'minor-pieces'
  | 'rooks-activity'
  | 'center-breaks'
  | 'weaknesses-plans'
  | 'sacrifices'

export type AlternativeKind =
  | 'improve-worst-piece'
  | 'prepare-pawn-break'
  | 'keep-tension'
  | 'trade-defender'
  | 'central-counterplay'
  | 'king-safety'

export interface Alternative {
  kind: AlternativeKind
  text: string
}

/** The context passed to every rule's detector. */
export interface MoveContext {
  ply: number // 0-based index into the game's move list
  moveNumber: number // 1-based chess move number
  selectedColor: Color
  move: VerboseMove
  /** true when this move was played by the colour we are analysing. */
  bySelected: boolean
  before: PositionInfo
  after: PositionInfo
  tactics: {
    /** static read of the position before the move (whose turn it is to move it). */
    before: TacticalRead
    /** static read of the position after the move (opponent to move). */
    after: TacticalRead
  }
  breaks: {
    /** candidate breaks for the selected colour before the move. */
    before: PawnBreak[]
    after: PawnBreak[]
  }
  /** the full game, for rules that need look-back / look-ahead. */
  game: VerboseMove[]
}

/** A single rule's finding for a move. */
export interface RuleFinding {
  ruleId: string
  title: string
  category: RuleCategory
  status: RuleStatus
  confidence: Confidence
  /** higher = more important for this move; used to rank findings. */
  importance: number
  explanation: string
  alternatives?: Alternative[]
}

/** A rule definition. */
export interface Rule {
  id: string
  title: string
  category: RuleCategory
  description: string
  positiveSignals: string[]
  negativeSignals: string[]
  /** Return a finding when the rule is relevant to this move, else null. */
  detect(ctx: MoveContext): RuleFinding | null
}

/** Full analysis of a single move from the selected colour's perspective. */
export interface MoveAnalysis {
  ply: number
  moveNumber: number
  color: Color
  san: string
  from: Square
  to: Square
  bySelected: boolean
  fenBefore: string
  fenAfter: string
  materialBefore: number // from selected colour's perspective
  materialAfter: number
  findings: RuleFinding[]
  tacticalWarnings: TacticalWarning[]
  humanLesson: string
  alternatives: Alternative[]
}

export interface TacticalWarning {
  severity: 'info' | 'warning' | 'danger'
  text: string
  confidence: Confidence
}

export interface GameAnalysis {
  selectedColor: Color
  headers: Record<string, string>
  moves: MoveAnalysis[]
  summary: SummaryReport
}

export interface PatternStat {
  id: string
  label: string
  count: number
  total: number
  description: string
  severity: 'good' | 'info' | 'warning'
  examples: number[] // ply indices
}

export interface SummaryReport {
  selectedColor: Color
  movesAnalyzed: number
  patterns: PatternStat[]
  headline: string
}
