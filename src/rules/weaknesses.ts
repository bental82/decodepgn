// E. Weaknesses and plans (21-23).

import { opposite } from '../engine/board'
import type { Color, PositionInfo } from '../engine/types'
import { colorName, defineRule, fileOf, isAttackedBy, isCapture, moveSee } from './helpers'

function enemyWeaknessSquares(info: PositionInfo, enemy: Color): string[] {
  const p = info.pawns[enemy]
  const set = new Set<string>([...p.isolatedSquares, ...p.backwardSquares])
  for (const pawn of p.pawns) if (pawn.doubled) set.add(pawn.square)
  return [...set]
}

// 21. Two weaknesses are better than one.
export const twoWeaknesses = defineRule(
  {
    id: 'two-weaknesses',
    title: 'Two weaknesses are better than one',
    category: 'weaknesses-plans',
    description:
      'A single weakness can usually be defended. Create or attack a second weakness so the defence is stretched across the board.',
    positiveSignals: ['You opened a second front / created a second target'],
    negativeSignals: ['You keep hammering one weakness the opponent can hold'],
  },
  (ctx) => {
    const sel = ctx.selectedColor
    const enemy = opposite(sel)
    const targetsBefore = enemyWeaknessSquares(ctx.before, enemy).filter((sq) =>
      isAttackedBy(ctx.before.fen, sq, sel),
    )
    const kingTarget = ctx.before.king[enemy].exposure >= 55
    if (!targetsBefore.length && !kingTarget) return null

    const weaknessCount = (info: PositionInfo) =>
      info.pawns[enemy].isolatedSquares.length +
      info.pawns[enemy].backwardSquares.length +
      info.pawns[enemy].doubledFiles.length
    const createdNew = weaknessCount(ctx.after) > weaknessCount(ctx.before)
    const firstTarget = targetsBefore[0] ?? `${colorName(enemy)}’s king`

    if (createdNew) {
      return {
        status: 'follows',
        confidence: 'medium',
        importance: 52,
        explanation: `You already have pressure on ${firstTarget}. This move creates a second weakness in ${colorName(
          enemy,
        )}’s camp — defending two targets at once is much harder, which is the whole idea of the two-weaknesses plan.`,
      }
    }
    if (!isCapture(ctx.move)) {
      return {
        status: 'relevant-unclear',
        confidence: 'low',
        importance: 36,
        explanation: `You have a target on ${firstTarget}, but one weakness alone can often be defended. Look for a way to open a second front (the other wing, or the enemy king) so the defence is stretched.`,
        alternatives: [{ kind: 'central-counterplay', text: 'Create pressure on a second part of the board.' }],
      }
    }
    return null
  },
)

// 22. Passed pawns must be pushed, but only when safe.
export const passedPawns = defineRule(
  {
    id: 'passed-pawns',
    title: 'Passed pawns must be pushed — safely',
    category: 'weaknesses-plans',
    description:
      'A passed pawn grows more dangerous as it advances, but pushing it into a blockade or losing it outright throws the trump away.',
    positiveSignals: ['You advanced a passed pawn safely'],
    negativeSignals: ['You pushed a passed pawn into a blockade or gave it away'],
  },
  (ctx) => {
    const sel = ctx.selectedColor
    const passed = ctx.before.pawns[sel].passedSquares
    if (!passed.length) return null
    const pushingPassed =
      ctx.move.piece === 'p' &&
      passed.includes(ctx.move.from) &&
      fileOf(ctx.move.from) === fileOf(ctx.move.to)
    if (pushingPassed) {
      const safe = moveSee(ctx) >= 0
      if (safe) {
        return {
          status: 'follows',
          confidence: 'medium',
          importance: 54,
          explanation: `Advancing your passed pawn is the right plan — it becomes stronger the further it goes, tying the opponent’s pieces to stopping it. Here it advances safely.`,
        }
      }
      return {
        status: 'partially-follows',
        confidence: 'medium',
        importance: 50,
        explanation: `Pushing the passed pawn is thematic, but here it looks like it can be won or firmly blockaded. Passed pawns must be pushed only when it is safe — otherwise support it first before advancing.`,
      }
    }
    // reminder when a passed pawn sits idle
    return {
      status: 'relevant-unclear',
      confidence: 'low',
      importance: 34,
      explanation: `Remember your passed pawn on ${passed[0]}. Passed pawns must be pushed — when it is safe, advancing it (with support) is often your most dangerous resource.`,
    }
  },
)

// 23. King safety can outweigh material.
export const kingSafetyOverMaterial = defineRule(
  {
    id: 'king-safety-over-material',
    title: 'King safety can outweigh material',
    category: 'weaknesses-plans',
    description:
      'When a king is exposed, raw material count matters less. Press the attack on a bare enemy king; do not grab pawns while your own king is unsafe.',
    positiveSignals: ['You kept attacking an exposed enemy king'],
    negativeSignals: ['You grabbed material while your own king was exposed'],
  },
  (ctx) => {
    const sel = ctx.selectedColor
    const enemy = opposite(sel)
    const enemyExp = ctx.before.king[enemy].exposure
    const ownExp = ctx.before.king[sel].exposure
    const selAttackers = ctx.before.king[enemy].attackers

    if (enemyExp >= 55 && selAttackers >= 1) {
      return {
        status: 'relevant-unclear',
        confidence: 'low',
        importance: 48,
        explanation: `${colorName(enemy)}’s king looks exposed and you have pieces bearing down on it. In these positions the attack matters more than a pawn or two — keep bringing pieces toward the king rather than counting material.`,
      }
    }
    if (ownExp >= 60 && isCapture(ctx.move) && moveSee(ctx) >= 1) {
      return {
        status: 'violates',
        confidence: 'low',
        importance: 47,
        explanation: `Your own king looks exposed (exposure ~${ownExp}). Grabbing material now may be too slow — with your king unsafe, king safety usually comes before winning a pawn.`,
        alternatives: [{ kind: 'king-safety', text: 'Tend to your own king’s safety before taking material.' }],
      }
    }
    return null
  },
)

export const weaknessRules = [twoWeaknesses, passedPawns, kingSafetyOverMaterial]
