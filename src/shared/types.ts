// Types shared between the browser and the serverless analysis function.

export type Color = 'w' | 'b'
/** which side is being studied — or both */
export type Focus = 'w' | 'b' | 'both'

/** Is a move by `color` part of the studied side(s)? */
export function isStudied(color: Color, focus: Focus): boolean {
  return focus === 'both' || color === focus
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

export type RuleStatus = 'follows' | 'partially' | 'violates' | 'relevant'

/** Heuristic judgment of the move itself, independent of which rules apply. */
export type Soundness = 'sound' | 'speculative' | 'dubious'

export interface RuleHit {
  id: number // rule number (1..RULE_COUNT)
  status: RuleStatus
  why: string
  /** 1-5: how central this rule is to THIS move (5 = the key idea). Results are sorted by it. */
  relevance?: number
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
}

export interface QuizRequest {
  mode: 'quiz'
  focus: Focus
  game: GameMove[]
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
}

export interface ApiError {
  error: string
}
