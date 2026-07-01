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
  focus: Focus
  game: GameMove[]
  targets: AnalyzeTarget[]
  /** optional bring-your-own Anthropic API key (used if the server has none). */
  apiKey?: string
}

export type RuleStatus = 'follows' | 'partially' | 'violates' | 'relevant'

export interface RuleHit {
  id: number // rule number (1..RULE_COUNT)
  status: RuleStatus
  why: string
}

export interface MoveResult {
  ply: number
  rules: RuleHit[]
  lesson: string
}

export interface AnalyzeResponse {
  results: MoveResult[]
}

export interface ApiError {
  error: string
}
