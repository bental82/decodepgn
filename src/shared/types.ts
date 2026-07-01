// Types shared between the browser and the serverless analysis function.

export type Color = 'w' | 'b'
export type Focus = 'w' | 'b'

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

/** A move we want Claude to analyse, with the exact resulting position. */
export interface AnalyzeTarget {
  ply: number
  fenAfter: string
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

// ---- Ask mode (free-form question) ----

export interface AskRequest {
  mode: 'ask'
  question: string
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
