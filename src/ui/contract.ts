// The contract between App and the presentational components: prop shapes plus
// small display helpers. Components import their props from here.

import type {
  BoardAnnotations,
  Focus,
  GameMove,
  MetaGameSummary,
  MoveResult,
  ParsedMove,
  QuizKind,
  RuleStatus,
  Soundness,
} from '../shared/types'
import type { SavedQuiz } from '../lib/store'

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
}

/** What the sticky board is currently illustrating for the selected move. */
export type GfxSelection =
  | { kind: 'auto' } // default: the key rule's graphics, if it has any
  | { kind: 'off' }
  | { kind: 'rule'; id: number }
  | { kind: 'alt' } // the suggested cleaner move, as an arrow

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
  focus: Focus
  /** the quiz + progress (owned by App so generation survives tab switches) */
  saved: SavedQuiz | null
  loading: boolean
  error: string | null
  onStart: (kind: QuizKind) => void
  onChange: (quiz: SavedQuiz) => void
  onOpenRule: (id: number) => void
  /** how many analysed positions the best-move quiz can draw on right now */
  bestMoveReady: number
}

export interface AskContext {
  focus?: Focus
  game?: GameMove[]
  ply?: number
  san?: string
  fen?: string
  ruleId?: number
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
