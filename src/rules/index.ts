// The rule registry. Rules are plain data + a detector, so new principles can be
// dropped in here without touching the engine or UI.

import type { Rule } from '../engine/types'
import { activityRules } from './activity'
import { centerRules } from './center'
import { minorPieceRules } from './minorPieces'
import { sacrificeRules } from './sacrifices'
import { tradingRules } from './trading'
import { weaknessRules } from './weaknesses'

export const ALL_RULES: Rule[] = [
  ...tradingRules,
  ...minorPieceRules,
  ...activityRules,
  ...centerRules,
  ...weaknessRules,
  ...sacrificeRules,
]

export const RULES_BY_ID: Record<string, Rule> = Object.fromEntries(
  ALL_RULES.map((r) => [r.id, r]),
)

export const CATEGORY_LABELS: Record<Rule['category'], string> = {
  trading: 'Trading',
  'minor-pieces': 'Bishops, knights & endgames',
  'rooks-activity': 'Rooks, files & activity',
  'center-breaks': 'Centre, breaks & tension',
  'weaknesses-plans': 'Weaknesses & plans',
  sacrifices: 'Sacrifices against the king',
}
