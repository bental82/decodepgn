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
  /** promotion piece (lowercase, e.g. "q") when the move promotes */
  promotion?: string
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
  /** the engine's expected continuation (SAN, starts with bestSan) — grounds
      "what happens next" in both the analysis and the ask coach */
  pv?: string[]
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

// ---- Quiz mode (guess the move) ----

/** Coaching for one finished guess-the-move position. */
export interface QuizExplanation {
  /** why the move played in the game fell short — names it and the mechanism */
  whyPlayed: string
  /** why the engine's move works, grounded in its continuation */
  whyBest: string
  /** one short note per other move the player tried in the quiz */
  attemptNotes?: Array<{ san: string; note: string }>
}

export interface QuizRequest {
  mode: 'quiz'
  focus: Focus
  /** which side the player is — the "you" the explanation addresses */
  me?: Color
  game: GameMove[]
  /** the quizzed moment */
  ply: number
  fenBefore: string
  played: { san: string; cpLoss: number }
  best: { san: string; evalBest: number; pv?: string[] }
  /** wrong tries made in the quiz, in order, with engine cost when graded */
  attempts?: Array<{ san: string; cpLoss?: number }>
  /** the move that solved it (may be a near-best move rather than `best`) */
  solvedWith?: { san: string; cpLoss?: number }
  apiKey?: string
}

export interface QuizResponse {
  explanation: QuizExplanation
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
  /** phase-by-phase read: opening, middlegame, endgame (absent on old saves) */
  phases?: string
  keyMoments: KeyMoment[]
}

export interface OverviewRequest {
  mode: 'overview'
  focus: Focus
  game: GameMove[]
  headers?: Record<string, string>
  /** ply -> centipawns after that move from WHITE's perspective (the client's
      engine sweep) — grounds the overview in the real eval story */
  evals?: Record<number, number>
  /** chess.com-style accuracy per side, when engine-checked */
  accuracy?: { w?: number; b?: number }
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
  /** which side the asker played — "I"/"my" in questions means this color */
  me?: Color
  /** player display names, for natural references in answers */
  white?: string
  black?: string
  game?: GameMove[]
  ply?: number
  san?: string
  fen?: string
  /** position before the discussed move — the engine continuation starts here */
  fenBefore?: string
  ruleId?: number
  /** the app's shown analysis of the move under discussion — lets the coach
      answer questions about its own suggestions and the engine's line */
  analysis?: MoveResult
  /** cross-game questions ("Your play" card): digests of the analysed games */
  summaries?: MetaGameSummary[]
  apiKey?: string
}

// ---- Meta analysis (patterns across ALL analysed games) ----

/** Compact, pre-computed digest of one analysed game (built client- or server-side). */
export interface MetaGameSummary {
  key: string
  white: string
  black: string
  /** which side the player flagged as themselves (falls back to the studied side) */
  me?: Color
  focus: Focus
  result?: string // headers.Result, e.g. "1-0"
  date?: string // headers.Date
  /** when the game entered the app (ms epoch) — orders games with no PGN date */
  addedAt?: number
  opening: string // the first moves in SAN, straight from the PGN
  analysed: number
  ruleBroken: Array<{ id: number; n: number }> // most-broken rules (top 5)
  ruleFollowed: Array<{ id: number; n: number }> // most-followed rules (top 5)
  soundness: { sound: number; speculative: number; dubious: number }
  engine?: {
    avgCpLoss: number
    worst: number
    blunders: number
    checked: number
    /** chess.com-style game accuracy % for the player's own moves (one decimal) */
    accuracy?: number
  }
  lessons: Array<{ ply?: number; text: string }> // lessons from the costliest moves (up to 3)
}

export interface MetaRequest {
  mode: 'meta'
  /** summaries of the games this browser has locally; the server merges the cloud archive */
  summaries: MetaGameSummary[]
  apiKey?: string
}

export interface MetaInsight {
  title: string
  detail: string
  ruleIds?: number[]
  /** concrete moments backing the insight — tappable links to a game + move */
  refs?: Array<{ key: string; label: string; ply: number }>
}

export interface MetaReport {
  profile: string
  openings: string
  /** recent games vs the rest: accuracy direction, fading/persisting mistakes (absent on older saved reports) */
  trends?: MetaInsight[]
  recurringMistakes: MetaInsight[]
  strengths: MetaInsight[]
  priorities: MetaInsight[]
}

export interface MetaResponse {
  report: MetaReport
  /** how many games the report was built from (client + cloud archive) */
  gamesUsed: number
}

export interface AskResponse {
  answer: string
  /** squares/arrows illustrating the answer, when a position was in context */
  graphics?: BoardAnnotations
}

export interface ApiError {
  error: string
}
