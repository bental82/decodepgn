// Types shared between the browser and the serverless analysis function.

export type Color = 'w' | 'b'
/** which side is being studied — or both */
export type Focus = 'w' | 'b' | 'both'

/** Is a move by `color` part of the studied side(s)? */
export function isStudied(color: Color, focus: Focus): boolean {
  return focus === 'both' || color === focus
}

// The model very occasionally leaks its tool-call syntax into a prose field —
// the text ends with something like:
//   "…every move (Rule 62). </parameter> <parameter name=\"graphics\">{…}"
// Everything from the first leaked tag onward is machinery, not content.
const TOOL_LEAK_RE = /<\/?(?:antml:)?(?:parameter|invoke|function)[\s>:]/i

/** Keep only the real prose before any leaked tool-call markup. */
export function stripToolLeak(s: unknown): string {
  if (typeof s !== 'string') return ''
  const i = s.search(TOOL_LEAK_RE)
  return i === -1 ? s : s.slice(0, i).trimEnd()
}

export interface ParsedMove {
  ply: number // 0-based index into the move list
  moveNumber: number // 1-based chess move number
  color: Color
  san: string
  from: string
  to: string
  fenBefore: string
  fenAfter: string
}

/** One compact move, used to give Claude the whole game for context. */
export interface GameMove {
  ply: number
  moveNumber: number
  color: Color
  san: string
}

/** Objective engine check for a played move (computed client-side by Stockfish). */
export interface EngineEval {
  bestSan: string // engine's preferred move in that position
  evalBest: number // centipawns from the mover's perspective, best play
  evalPlayed: number // centipawns from the mover's perspective after the played move
  cpLoss: number // how much the played move gave up vs the engine's best (>= 0)
  isBest: boolean // the played move IS the engine's top choice
  depth: number
}

/** A move we want Claude to analyse, with the exact resulting position. */
export interface AnalyzeTarget {
  ply: number
  fenAfter: string
  engine?: EngineEval
}

export interface AnalyzeRequest {
  mode?: 'analyze'
  focus: Focus
  game: GameMove[]
  targets: AnalyzeTarget[]
  /** optional bring-your-own Anthropic API key (used if the server has none). */
  apiKey?: string
}

// ---- Board graphics ----
// The AI (and deterministic client code) can point at the board: tinted
// squares and arrows in a small named palette the UI maps to theme colors.

export type AnnoColor = 'green' | 'red' | 'yellow' | 'blue'

export interface AnnoSquare {
  square: string // e.g. "e4"
  color: AnnoColor
}

export interface AnnoArrow {
  from: string
  to: string
  color: AnnoColor
}

export interface BoardAnnotations {
  squares?: AnnoSquare[]
  arrows?: AnnoArrow[]
}

export type RuleStatus = 'follows' | 'partially' | 'violates' | 'relevant'

/** Heuristic judgment of the move itself, independent of which rules apply. */
export type Soundness = 'sound' | 'speculative' | 'dubious'

export interface RuleHit {
  id: number // rule number (1..RULE_COUNT)
  status: RuleStatus
  why: string
  /** 1-5: how central this rule is to THIS move (5 = the key idea). Results are sorted by it. */
  relevance?: number
  /** squares/arrows that show this rule's point on the board */
  graphics?: BoardAnnotations
}

/** A cleaner alternative move, suggested when the played move breaks a principle. */
export interface MoveAlternative {
  move: string // SAN, e.g. "Nf3"
  why: string
}

export interface MoveResult {
  ply: number
  rules: RuleHit[]
  lesson: string
  soundness?: Soundness
  alternative?: MoveAlternative | null
  /** merged in client-side so the engine check is shown and persisted */
  engine?: EngineEval
}

export interface AnalyzeResponse {
  results: MoveResult[]
}

// ---- Quiz mode ----

export interface QuizOption {
  text: string
  correct: boolean
}

export interface QuizQuestion {
  prompt: string
  options: QuizOption[]
  explanation: string
  ruleId?: number // main rule the question is about (1..RULE_COUNT)
  ply?: number // game ply the question references, if any
  /** best-move questions: the position to solve (side to move is quizzed) */
  fen?: string
}

export type QuizKind = 'rules' | 'bestmove'

/** A position for the best-move quiz: what was played, and what was better. */
export interface BestMoveTarget {
  ply: number
  fenBefore: string
  played: string // SAN actually played
  best?: string // engine's best move (SAN), when an engine check ran
  cpLoss?: number // centipawns the played move gave up vs best
  alternative?: string // AI-suggested cleaner move (SAN)
}

export interface QuizRequest {
  mode: 'quiz'
  kind?: QuizKind // default 'rules'
  focus: Focus
  game: GameMove[]
  /** kind "bestmove": the positions to quiz, chosen client-side from the analysis */
  targets?: BestMoveTarget[]
  count?: number
  apiKey?: string
}

export interface QuizResponse {
  questions: QuizQuestion[]
}

// ---- Game overview ----

export interface KeyMoment {
  ply: number
  title: string // e.g. "The decisive sacrifice"
  why: string // one line on why this moment mattered
}

export interface GameOverview {
  /** what decided the game — what won it / what lost it, for the studied side */
  summary: string
  /** the arc of the game: who stood better when, where momentum shifted */
  trend: string
  keyMoments: KeyMoment[]
}

export interface OverviewRequest {
  mode: 'overview'
  focus: Focus
  game: GameMove[]
  headers?: Record<string, string>
  apiKey?: string
}

export interface OverviewResponse {
  overview: GameOverview
}

// ---- Ask mode (free-form question) ----

/** One earlier question/answer pair, for follow-up questions. */
export interface AskExchange {
  q: string
  a: string
  /** kept client-side to re-render the answer's board; not sent to the model */
  graphics?: BoardAnnotations
}

export interface AskRequest {
  mode: 'ask'
  question: string
  /** Earlier exchanges in this thread, oldest first. */
  history?: AskExchange[]
  focus?: Focus
  game?: GameMove[]
  ply?: number
  san?: string
  fen?: string
  ruleId?: number
  apiKey?: string
}

export interface AskResponse {
  answer: string
  /** squares/arrows illustrating the answer, when a position was in context */
  graphics?: BoardAnnotations
}

export interface ApiError {
  error: string
}
