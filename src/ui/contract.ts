// The contract between App and the presentational components: prop shapes plus
// small display helpers. Components import their props from here.

import type { Focus, MoveResult, ParsedMove, RuleStatus, Soundness } from '../shared/types'

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

export interface GameSummaryProps {
  moves: ParsedMove[]
  focus: Focus
  results: Record<number, MoveResult> // ply -> result
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
