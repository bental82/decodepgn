// The contract between App and the presentational components: prop shapes plus
// small display helpers. Components import their props from here.

import type {
  BoardAnnotations,
  Color,
  Focus,
  GameMove,
  MetaGameSummary,
  MoveResult,
  ParsedMove,
  QuizExplanation,
  RuleStatus,
  Soundness,
} from '../shared/types'
import type { QuizPosition, SavedQuiz } from '../lib/store'

export type Orientation = 'w' | 'b'

export interface PgnInputProps {
  onSubmit: (pgn: string, focus: Focus) => void
  onOpenSettings: () => void
  error?: string | null
  busy?: boolean
  hasServerKey: boolean
}

export interface BoardProps {
  fen: string
  orientation: Orientation
  lastMove?: { from: string; to: string }
  caption?: string
  /** squares to tint + arrows to draw (AI graphics or deterministic client ones) */
  annotations?: BoardAnnotations
  /** glide the piece now standing on `to` in from `from` (move navigation) */
  anim?: { from: string; to: string } | null
  /** make the mover's pieces tappable/draggable (drill mode) */
  interact?: {
    color: Color
    /** legal destinations per from-square (precomputed by the caller) */
    targets: Record<string, string[]>
    onMove: (from: string, to: string) => void
  }
}

/** What the sticky board is currently illustrating for the selected move. */
export type GfxSelection =
  | { kind: 'auto' } // default: the key rule's graphics, if it has any
  | { kind: 'off' }
  | { kind: 'rule'; id: number }
  | { kind: 'alt' } // the suggested cleaner move, as an arrow
  | { kind: 'engine' } // Stockfish's best move, as an arrow

export interface MoveAnalysisProps {
  move: ParsedMove
  focus: Focus
  result?: MoveResult
  loading: boolean
  error?: string | null
  onReanalyze: () => void
  onOpenRule: (id: number) => void
  /** board-graphics selection (owned by App, which renders the board) */
  gfx: GfxSelection
  onGfx: (sel: GfxSelection) => void
  /** the rule whose graphics show by default, so its toggle renders as active */
  autoGfxRuleId?: number
  /** the alternative move parsed to a real arrow — enables its board toggle */
  altArrow: boolean
  /** Stockfish's best move parsed to a real arrow — enables its board toggle */
  engineArrow: boolean
}

export interface RulesReferenceProps {
  highlightId?: number
  usage: Record<number, number> // rule id -> how many analysed moves cite it
  onPickRule: (id: number) => void
  apiKey: string
  onNeedKey: () => void
}

export interface QuizProps {
  moves: ParsedMove[]
  /** ply -> analysis (the quiz reads the engine checks) */
  results: Record<number, MoveResult>
  /** the quiz + progress (owned by App, persisted with the game) */
  saved: SavedQuiz | null
  /** plies eligible for a NEW quiz: the costliest engine-flagged moves, game order */
  candidates: number[]
  /** studied moves not yet analysed — gates starting until the picks are final */
  analysisPending: number
  onStart: () => void
  /** functional update so concurrent grading/explanations can't drop progress */
  onChange: (update: (quiz: SavedQuiz) => SavedQuiz) => void
  /** deep engine eval of a candidate try (mover's perspective); null = engine unavailable */
  gradeMove: (fenBefore: string, san: string) => Promise<number | null>
  /** fetch the AI coaching for a finished position */
  explain: (pos: QuizPosition) => Promise<QuizExplanation>
  onOpenRule: (id: number) => void
  /** open this moment in the game reader */
  onJump: (ply: number) => void
}

export interface AskContext {
  focus?: Focus
  /** which side the user played (the "me" flag) — lets answers resolve "I"/"my" */
  me?: Color
  white?: string
  black?: string
  game?: GameMove[]
  ply?: number
  san?: string
  fen?: string
  /** position before the discussed move (grounds the engine continuation) */
  fenBefore?: string
  ruleId?: number
  /** the shown analysis of the move under discussion (move-level asks) */
  analysis?: MoveResult
  /** cross-game questions: digests of every analysed game */
  summaries?: MetaGameSummary[]
}

export interface AskBoxProps {
  context: AskContext
  apiKey: string
  onNeedKey: () => void
  placeholder?: string
  label?: string
  /** when set, rule citations in answers ("#42", "rule 42") open the rule popup */
  onOpenRule?: (id: number) => void
}

export interface RelevanceMapProps {
  moves: ParsedMove[]
  focus: Focus
  results: Record<number, MoveResult> // ply -> result
  onJump: (ply: number) => void
  onPickRule: (id: number) => void
  /** re-run the whole analysis (adds the engine check to older analyses) */
  onReanalyzeAll: () => void
  reanalyzing: boolean
}

export interface GameSummaryProps {
  moves: ParsedMove[]
  focus: Focus
  results: Record<number, MoveResult> // ply -> result
  onPickRule: (id: number) => void
}

export interface SettingsProps {
  apiKey: string
  hasServerKey: boolean
  theme: 'dark' | 'light'
  onTheme: (t: 'dark' | 'light') => void
  /** the deployed API's build marker (from GET /api/analyze) — shows what's live */
  serverBuild?: string
  onSave: (key: string) => void
  onClose: () => void
}

export function colorName(c: Focus): string {
  return c === 'w' ? 'White' : c === 'b' ? 'Black' : 'Both sides'
}

export interface StatusMeta {
  label: string
  cls: string
  icon: string
  desc: string
}

export function statusMeta(status: RuleStatus): StatusMeta {
  switch (status) {
    case 'follows':
      return { label: 'Followed', cls: 'st-follows', icon: '✓', desc: 'The move upholds this principle.' }
    case 'partially':
      return { label: 'Mixed', cls: 'st-partial', icon: '≈', desc: 'The move partly follows it, with a trade-off.' }
    case 'violates':
      return { label: 'Broke', cls: 'st-violates', icon: '✕', desc: 'The move goes against this principle.' }
    case 'relevant':
      return { label: 'In play', cls: 'st-relevant', icon: '•', desc: 'This principle matters here, but the move is neutral toward it.' }
  }
}

/** The four rule states, in reading order, for the legend. */
export const STATUS_ORDER: RuleStatus[] = ['follows', 'partially', 'violates', 'relevant']

export interface SoundnessMeta {
  label: string
  cls: string
  icon: string
  desc: string
}

export function soundnessMeta(s: Soundness): SoundnessMeta {
  switch (s) {
    case 'sound':
      return { label: 'Sound', cls: 'snd-sound', icon: '●', desc: 'Principled and low-risk — a normal strong move.' }
    case 'speculative':
      return { label: 'Speculative', cls: 'snd-spec', icon: '◆', desc: 'Ambitious and double-edged — may not be fully correct.' }
    case 'dubious':
      return { label: 'Dubious', cls: 'snd-dubious', icon: '▲', desc: 'Looks objectively risky or likely inferior.' }
  }
}
