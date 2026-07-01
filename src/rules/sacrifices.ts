// F. Sacrifices against the king (24-27).
//
// These rules only fire when the move actually gives up material with an
// attacking flavour. They share one static analysis and each surfaces a
// different facet: soundness verdict (24), promising signals (25), warning
// signals (26) and the calculation checklist (27). Confidence is deliberately
// modest — real sacrifices need calculation, which the optional engine supports.

import { fileIndex, opposite, rankIndex } from '../engine/board'
import { see } from '../engine/tactics'
import type { MoveContext, Square } from '../engine/types'
import {
  attackerPieceTypes,
  availableChecks,
  colorName,
  defineRule,
  isCheck,
  kingEscapeSquares,
  moveSee,
} from './helpers'

interface SacAnalysis {
  isSacrifice: boolean
  invested: number
  isAttacking: boolean
  attackers: number
  defenders: number
  escapeSquares: number
  followUpChecks: number
  gaveCheck: boolean
  weakKingSquares: number
  ownKingRisk: boolean
  signals: string[]
  warnings: string[]
  score: number
}

function nearSquare(a: Square, b: Square): number {
  return Math.max(Math.abs(fileIndex(a) - fileIndex(b)), Math.abs(rankIndex(a) - rankIndex(b)))
}

function analyseSac(ctx: MoveContext): SacAnalysis {
  const sel = ctx.selectedColor
  const enemy = opposite(sel)
  const m = ctx.move

  // Material the move actually offers. For a capture, a negative exchange value.
  // For a quiet move, only counts if the MOVED piece is left hanging (a real
  // piece offer) — never unrelated threats elsewhere on the board.
  let invested = 0
  if (m.captured) {
    const netSee = moveSee(ctx)
    if (netSee < 0) invested = -netSee
  } else {
    const loss = see(m.after, m.to)
    if (loss >= 2) invested = loss
  }

  const enemyKing = ctx.after.king[enemy].square
  const gaveCheck = isCheck(m)
  const attackers = ctx.after.king[enemy].attackers
  const defenders = ctx.after.king[enemy].defenders
  const escapeSquares = kingEscapeSquares(m.after, enemy)
  const followUpChecks = availableChecks(m.after, sel)
  const weakKingSquares = ctx.after.king[enemy].weakSquares.length
  const ownKingRisk = ctx.after.king[sel].exposure > ctx.before.king[sel].exposure + 10
  const isAttacking = gaveCheck || attackers >= 1 || nearSquare(m.to, enemyKing) <= 2

  // Promising signals (rule 25 checklist)
  const targets: Square[] = enemy === 'b' ? ['h7', 'g7', 'f7'] : ['h2', 'g2', 'f2']
  const signals: string[] = []
  if (weakKingSquares >= 1) signals.push(`${colorName(enemy)}’s king has weakened pawn cover`)
  if (targets.some((sq) => attackerPieceTypes(m.after, sq, sel).includes('b')))
    signals.push('a bishop is aimed at the h-file target square')
  if (targets.some((sq) => attackerPieceTypes(m.after, sq, sel).includes('n')))
    signals.push('a knight is jumping into the attack')
  if (ctx.after.king[enemy].openFilesNearKing.length) signals.push('a file is open toward the enemy king')
  if (gaveCheck) signals.push('the first move is a forcing check')
  if (followUpChecks >= 1) signals.push('you have further checks to keep the attack going')
  if (attackers > defenders) signals.push(`you have more attackers (${attackers}) than defenders (${defenders})`)
  if (ctx.after.center.state === 'closed' || ctx.after.center.state === 'locked')
    signals.push('the closed centre keeps your own king safe')

  // Warning signals (rule 26 checklist)
  const warnings: string[] = []
  if (!gaveCheck && followUpChecks === 0) warnings.push('there is no forcing check to follow up')
  if (attackers <= defenders) warnings.push(`defenders (${defenders}) match or outnumber attackers (${attackers})`)
  if (escapeSquares >= 2) warnings.push(`the enemy king has ${escapeSquares} escape squares`)
  if (ownKingRisk) warnings.push('the lines you open also expose your own king')

  const score =
    attackers -
    defenders +
    (gaveCheck ? 1 : 0) +
    (followUpChecks >= 1 ? 1 : 0) +
    (weakKingSquares >= 1 ? 1 : 0) -
    (escapeSquares >= 2 ? 1 : 0) -
    (ownKingRisk ? 1 : 0)

  return {
    isSacrifice: invested >= 2,
    invested,
    isAttacking,
    attackers,
    defenders,
    escapeSquares,
    followUpChecks,
    gaveCheck,
    weakKingSquares,
    ownKingRisk,
    signals,
    warnings,
    score,
  }
}

// 24. A sacrifice is sound only if it has concrete compensation.
export const sacSoundness = defineRule(
  {
    id: 'sac-soundness',
    title: 'A sacrifice needs concrete compensation',
    category: 'sacrifices',
    description:
      'Judge a sacrifice by counting attackers vs defenders, forcing moves, escape squares and open lines — not by hope.',
    positiveSignals: ['More attackers than defenders, forcing moves, a boxed-in king'],
    negativeSignals: ['Few attackers, no forcing follow-up, the king can run'],
  },
  (ctx) => {
    const s = analyseSac(ctx)
    if (!s.isSacrifice || !s.isAttacking) return null
    const count = `You have ${s.attackers} attacker(s) vs ${s.defenders} defender(s) near ${colorName(
      opposite(ctx.selectedColor),
    )}’s king; it has ${s.escapeSquares} escape square(s)${
      s.followUpChecks ? ` and you have ${s.followUpChecks} follow-up check(s)` : ' and no immediate follow-up check'
    }.`
    if (s.score >= 2) {
      return {
        status: 'follows',
        confidence: 'medium',
        importance: 68,
        explanation: `This sacrifice (about ${s.invested.toFixed(
          0,
        )} point(s)) has real justification. ${count} On these counts the attack looks worth the material — though a concrete calculation (or the engine) should confirm the lines.`,
      }
    }
    if (s.score <= 0) {
      return {
        status: 'violates',
        confidence: 'medium',
        importance: 66,
        explanation: `This sacrifice (about ${s.invested.toFixed(
          0,
        )} point(s)) looks under-supported. ${count} With the defence holding, giving up material here is probably unsound unless you have calculated a concrete forced line.`,
      }
    }
    return {
      status: 'relevant-unclear',
      confidence: 'low',
      importance: 60,
      explanation: `You are giving up about ${s.invested.toFixed(
        0,
      )} point(s). ${count} It is double-edged — the compensation is not clear-cut, so this one really must be calculated move by move.`,
    }
  },
)

// 25. Attacking sacrifice signals.
export const sacSignals = defineRule(
  {
    id: 'sac-signals',
    title: 'Attacking sacrifice — promising signs',
    category: 'sacrifices',
    description:
      'A sacrifice is more likely sound when several attacking signals line up: weak king cover, a bishop on h7/h2, a knight jump, open files, forcing first move.',
    positiveSignals: ['Several classic attacking ingredients are present'],
    negativeSignals: [],
  },
  (ctx) => {
    const s = analyseSac(ctx)
    if (!s.isSacrifice || !s.isAttacking || s.signals.length < 2) return null
    return {
      status: s.signals.length >= 3 ? 'follows' : 'partially-follows',
      confidence: 'low',
      importance: 58,
      explanation: `Encouraging signs for the attack: ${s.signals.join('; ')}. When this many ingredients are present, an attacking sacrifice is often worth a serious look.`,
    }
  },
)

// 26. Hopeful sacrifice warning.
export const sacWarning = defineRule(
  {
    id: 'sac-warning',
    title: 'Hopeful sacrifice warning',
    category: 'sacrifices',
    description:
      'A sacrifice is suspicious when there is no forcing follow-up, the defenders outnumber the attackers, or the king can simply walk out.',
    positiveSignals: [],
    negativeSignals: ['No forcing follow-up', 'Defenders ≥ attackers', 'King has escape squares'],
  },
  (ctx) => {
    const s = analyseSac(ctx)
    if (!s.isSacrifice || !s.isAttacking || s.warnings.length < 2 || s.score >= 2) return null
    return {
      status: 'violates',
      confidence: 'low',
      importance: 62,
      explanation: `This looks like a hopeful sacrifice. Warning signs: ${s.warnings.join(
        '; ',
      )}. If the opponent can just accept and consolidate, the sacrifice fails — don’t rely on them going wrong.`,
    }
  },
)

// 27. Sacrifice calculation method.
export const sacCalculation = defineRule(
  {
    id: 'sac-calculation',
    title: 'How to calculate the sacrifice',
    category: 'sacrifices',
    description:
      'For any sacrifice, calculate forcing moves first (checks, then captures, then threats) and define the minimum acceptable outcome.',
    positiveSignals: ['A forcing sequence reaches mate, material, or perpetual'],
    negativeSignals: ['The lines fizzle out with nothing concrete'],
  },
  (ctx) => {
    const s = analyseSac(ctx)
    if (!s.isSacrifice || !s.isAttacking) return null
    const outcome =
      s.score >= 2
        ? 'aim to show a forced line to at least a strong ongoing attack or regained material with interest'
        : 'you need a concrete forced line — if you cannot find one, treat the sacrifice as unsound'
    return {
      status: 'relevant-unclear',
      confidence: 'low',
      importance: 44,
      explanation: `Calculate before committing: look at your checks first (${s.followUpChecks} available now${
        s.gaveCheck ? ', plus the check you just gave' : ''
      }), then captures, then threats, and always assume the best defence. The enemy king has ${s.escapeSquares} escape square(s). Minimum target: ${outcome}. Turn on the engine to verify the tactics.`,
    }
  },
)

export const sacrificeRules = [sacSoundness, sacSignals, sacWarning, sacCalculation]
