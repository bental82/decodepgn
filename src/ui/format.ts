// Small presentation helpers shared across UI components.

import type { Confidence, RuleFinding, RuleStatus } from '../engine/types'

export function statusMeta(status: RuleStatus): { label: string; cls: string; icon: string } {
  switch (status) {
    case 'follows':
      return { label: 'Follows', cls: 'status-follows', icon: '✓' }
    case 'partially-follows':
      return { label: 'Partly follows', cls: 'status-partial', icon: '≈' }
    case 'violates':
      return { label: 'Goes against', cls: 'status-violates', icon: '✕' }
    case 'relevant-unclear':
      return { label: 'Relevant', cls: 'status-unclear', icon: '?' }
  }
}

export function confidenceLabel(c: Confidence): string {
  return c === 'high' ? 'High confidence' : c === 'medium' ? 'Medium confidence' : 'Low confidence'
}

export function materialText(points: number): string {
  if (Math.abs(points) < 0.5) return 'Material: level'
  const side = points > 0 ? 'you' : 'opponent'
  return `Material: ${side} +${Math.abs(points).toFixed(0)}`
}

/** Worst status among a move's findings, for the move-list dot. */
export function aggregateStatus(findings: RuleFinding[]): RuleStatus | null {
  if (!findings.length) return null
  if (findings.some((f) => f.status === 'violates')) return 'violates'
  if (findings.some((f) => f.status === 'partially-follows')) return 'partially-follows'
  if (findings.some((f) => f.status === 'follows')) return 'follows'
  return 'relevant-unclear'
}

export const PIECE_GLYPH: Record<string, string> = {
  k: '♚',
  q: '♛',
  r: '♜',
  b: '♝',
  n: '♞',
  p: '♟',
}
