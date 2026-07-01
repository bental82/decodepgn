// The contract between App and the presentational components: prop shapes plus
// small display helpers. Components import their props from here.

import type { Focus, MoveResult, ParsedMove, RuleStatus } from '../shared/types'

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
}

export interface MoveReaderProps {
  moves: ParsedMove[]
  focus: Focus
  selectedPly: number
  results: Record<number, MoveResult>
  loading: Set<number> // plies currently being analysed
  errors: Record<number, string>
  onSelect: (ply: number) => void
  onReanalyze: (ply: number) => void
  onOpenRule: (id: number) => void
}

export interface MoveAnalysisProps {
  move: ParsedMove
  focus: Focus
  result?: MoveResult
  loading: boolean
  error?: string | null
  onReanalyze: () => void
  onOpenRule: (id: number) => void
}

export interface RulesReferenceProps {
  highlightId?: number
  usage: Record<number, number> // rule id -> how many analysed moves cite it
  onPickRule: (id: number) => void
}

export interface RelevanceMapProps {
  moves: ParsedMove[]
  focus: Focus
  results: Record<number, MoveResult> // ply -> result
  onJump: (ply: number) => void
  onPickRule: (id: number) => void
}

export interface SettingsProps {
  apiKey: string
  hasServerKey: boolean
  onSave: (key: string) => void
  onClose: () => void
}

export function colorName(c: Focus): 'White' | 'Black' {
  return c === 'w' ? 'White' : 'Black'
}

export interface StatusMeta {
  label: string
  cls: string
  icon: string
}

export function statusMeta(status: RuleStatus): StatusMeta {
  switch (status) {
    case 'follows':
      return { label: 'Follows', cls: 'st-follows', icon: '✓' }
    case 'partially':
      return { label: 'Partly follows', cls: 'st-partial', icon: '≈' }
    case 'violates':
      return { label: 'Goes against', cls: 'st-violates', icon: '✕' }
    case 'relevant':
      return { label: 'Relevant', cls: 'st-relevant', icon: '•' }
  }
}

// Solid glyphs (used for both colours; colour comes from CSS) for crisp pieces.
export const PIECE_GLYPH: Record<string, string> = {
  k: '♚',
  q: '♛',
  r: '♜',
  b: '♝',
  n: '♞',
  p: '♟',
}
