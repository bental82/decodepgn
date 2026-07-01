// D. Centre, pawn breaks and tension (16-20).

import { fileIndex, opposite, rankIndex } from '../engine/board'
import type { Color, MoveContext, PawnBreak } from '../engine/types'
import {
  colorName,
  defineRule,
  fileOf,
  isFlankPawnPush,
  moveSee,
  pawnTension,
} from './helpers'

function breakKey(b: PawnBreak): string {
  return b.fromFile + b.challenges
}

function isCentralBreak(b: PawnBreak): boolean {
  return 'cdef'.includes(b.fromFile) || 'cdef'.includes(fileOf(b.challenges))
}

function describeBreak(b: PawnBreak): string {
  return `${b.move} challenges the pawn on ${b.challenges} and can open the ${b.opensFiles.join('/')}-file`
}

// 16. Identify pawn breaks.
export const identifyBreaks = defineRule(
  {
    id: 'identify-breaks',
    title: 'Identify your pawn breaks',
    category: 'center-breaks',
    description:
      'A pawn break challenges an enemy pawn to open lines or create weaknesses. Knowing your breaks tells you what the position is about.',
    positiveSignals: ['You played a thematic pawn break'],
    negativeSignals: ['A natural break was available but went unplayed'],
  },
  (ctx) => {
    const executed = ctx.breaks.before.find((b) => b.move === ctx.move.san)
    if (executed) {
      return {
        status: 'follows',
        confidence: 'medium',
        importance: 60,
        explanation: `This is a pawn break: ${describeBreak(executed)}. Breaks are how you open the position and create targets — good to see one played.`,
      }
    }
    // Only nudge about a genuinely thematic (central) break, so we don't cry
    // "missed break" on every position where some pawn could theoretically push.
    const candidates = ctx.breaks.before
    const b = candidates.find(isCentralBreak)
    if (b && ctx.move.piece !== 'p') {
      return {
        status: 'relevant-unclear',
        confidence: 'low',
        importance: 38,
        explanation: `Your natural pawn break here is ${b.move}: it ${describeBreak(
          b,
        )}. Keep it in mind — deciding when to play the break is usually the key strategic question.`,
        alternatives: [{ kind: 'prepare-pawn-break', text: `Prepare and play the ${b.move} break.` }],
      }
    }
    return null
  },
)

// 17. Prepare pawn breaks before playing them.
export const prepareBreaks = defineRule(
  {
    id: 'prepare-breaks',
    title: 'Prepare pawn breaks before playing them',
    category: 'center-breaks',
    description:
      'A break is stronger when your pieces are ready to use the lines it opens. Rooks on the relevant files, pieces supporting the break.',
    positiveSignals: ['A move that gets pieces ready for a break', 'The break you played was well prepared'],
    negativeSignals: ['A break played before the pieces were ready'],
  },
  (ctx) => {
    const executed = ctx.breaks.before.find((b) => b.move === ctx.move.san)
    if (executed) {
      if (executed.prepared) {
        return {
          status: 'follows',
          confidence: 'medium',
          importance: 54,
          explanation: `The break ${executed.move} is well prepared — you already have a rook or the queen bearing on the ${executed.opensFiles.join(
            '/',
          )}-file, so opening it plays into your pieces.`,
        }
      }
      return {
        status: 'partially-follows',
        confidence: 'low',
        importance: 48,
        explanation: `You played the break ${executed.move}, but your heavy pieces are not yet on the lines it opens. Breaks tend to be stronger once a rook supports the file — check that opening the position really favours you here.`,
      }
    }
    const wasPrepared = new Set(ctx.breaks.before.filter((b) => b.prepared).map(breakKey))
    const newlyPrepared = ctx.breaks.after.filter((b) => b.prepared && !wasPrepared.has(breakKey(b)))
    if (newlyPrepared.length && ctx.move.piece !== 'p') {
      const b = newlyPrepared[0]
      return {
        status: 'follows',
        confidence: 'low',
        importance: 46,
        explanation: `This quiet move helps prepare the ${b.move} break: it improves your grip on the ${b.opensFiles.join(
          '/',
        )}-file so the break will hit harder when it comes.`,
      }
    }
    return null
  },
)

// 18. Keeping tension versus releasing tension.
export const tension = defineRule(
  {
    id: 'tension',
    title: 'Keep tension vs release tension',
    category: 'center-breaks',
    description:
      'When pawns attack each other, capturing releases the tension. Release it to win material, damage structure, or open a line — otherwise keeping it usually keeps the pressure.',
    positiveSignals: ['You released tension to gain something concrete', 'You kept useful tension'],
    negativeSignals: ['You released tension for no gain, easing the opponent’s game'],
  },
  (ctx) => {
    const sel = ctx.selectedColor
    const tensions = pawnTension(ctx.before, sel)
    if (!tensions.length) return null
    const releasing =
      ctx.move.piece === 'p' &&
      ctx.move.captured === 'p' &&
      tensions.some((t) => t.own === ctx.move.from && t.enemy === ctx.move.to)

    if (releasing) {
      const gain = moveSee(ctx)
      const enemy = opposite(sel)
      const newEnemyDoubled = ctx.after.pawns[enemy].doubledFiles.filter(
        (f) => !ctx.before.pawns[enemy].doubledFiles.includes(f),
      )
      const newEnemyIsolated =
        ctx.after.pawns[enemy].isolatedSquares.length - ctx.before.pawns[enemy].isolatedSquares.length
      const newOpen = ctx.after.files.open.filter((f) => !ctx.before.files.open.includes(f))
      const reasons: string[] = []
      if (gain >= 1) reasons.push('it wins material')
      if (newEnemyDoubled.length) reasons.push(`it gives ${colorName(enemy)} doubled ${newEnemyDoubled.join('/')}-pawns`)
      if (newEnemyIsolated > 0) reasons.push(`it leaves ${colorName(enemy)} with an isolated pawn`)
      if (newOpen.length) reasons.push(`it opens the ${newOpen.join('/')}-file`)
      if (reasons.length) {
        return {
          status: 'follows',
          confidence: 'medium',
          importance: 55,
          explanation: `Releasing the tension is justified here because ${reasons.join(' and ')}. That is exactly the kind of concrete gain that makes a capture better than keeping the pressure.`,
        }
      }
      return {
        status: 'partially-follows',
        confidence: 'low',
        importance: 50,
        explanation: `Capturing releases the central tension without an obvious gain. Often it is stronger to keep the tension — capturing can free the opponent’s pieces or let them fix their structure. Make sure releasing genuinely helps you.`,
        alternatives: [{ kind: 'keep-tension', text: 'Consider keeping the tension and improving a piece instead.' }],
      }
    }
    // kept the tension
    if (pawnTension(ctx.after, sel).length && ctx.move.captured !== 'p') {
      return {
        status: 'follows',
        confidence: 'low',
        importance: 40,
        explanation: `You keep the central tension rather than resolving it. That is often the mature choice: the opponent must keep watching the capture, and you retain the option to open the position on your terms.`,
      }
    }
    return null
  },
)

function enemyFlankStorm(ctx: MoveContext, sel: Color): boolean {
  // enemy pawns advanced on the flank where our king lives
  const enemy = opposite(sel)
  const kingFile = fileIndex(ctx.before.king[sel].square)
  let count = 0
  for (const p of ctx.before.pawns[enemy].pawns) {
    const f = fileIndex(p.square)
    const flank = f <= 2 || f >= 5
    const nearKing = Math.abs(f - kingFile) <= 3
    const advanced = enemy === 'w' ? p.rank >= 4 : p.rank <= 5
    if (flank && nearKing && advanced) count++
  }
  return count >= 2
}

// 19. Wing attack should be met by central counterplay.
export const centralCounterplay = defineRule(
  {
    id: 'central-counterplay',
    title: 'Meet a wing attack with central counterplay',
    category: 'center-breaks',
    description:
      'When the opponent attacks on a flank, the classical response is to strike in the centre, where a break undermines the whole attack.',
    positiveSignals: ['You answered a flank attack with a central break'],
    negativeSignals: ['You defended passively while a central break was available'],
  },
  (ctx) => {
    const sel = ctx.selectedColor
    const underAttack = ctx.before.king[sel].attackers >= 2 || enemyFlankStorm(ctx, sel)
    if (!underAttack) return null
    const centralBreaks = ctx.breaks.before.filter(isCentralBreak)
    const playedCentral =
      (ctx.move.piece === 'p' && 'cdef'.includes(fileOf(ctx.move.to))) ||
      ctx.breaks.before.some((b) => b.move === ctx.move.san && isCentralBreak(b))
    if (playedCentral) {
      return {
        status: 'follows',
        confidence: 'medium',
        importance: 56,
        explanation: `${colorName(opposite(sel))} is coming at you on the wing, and you are hitting back in the centre — the classical antidote. Central counterplay undercuts a flank attack.`,
      }
    }
    if (centralBreaks.length) {
      const b = centralBreaks[0]
      return {
        status: 'relevant-unclear',
        confidence: 'low',
        importance: 44,
        explanation: `${colorName(opposite(sel))} is attacking on the flank, so look for central counterplay — for example ${b.move}. Striking in the centre is usually a better response than defending passively.`,
        alternatives: [{ kind: 'central-counterplay', text: `Break in the centre with ${b.move}.` }],
      }
    }
    return null
  },
)

// 20. Do not start a flank attack before the centre is safe.
export const flankBeforeCenter = defineRule(
  {
    id: 'flank-before-center',
    title: 'Don’t attack on the flank with an unstable centre',
    category: 'center-breaks',
    description:
      'Flank pawn storms need a stable centre behind them; if the centre can be opened first, the attack rebounds on your own king.',
    positiveSignals: ['Flank push with a closed/locked, stable centre'],
    negativeSignals: ['Flank pawn storm while the centre is still open'],
  },
  (ctx) => {
    if (!isFlankPawnPush(ctx.move)) return null
    const sel = ctx.selectedColor
    // only treat advancing pushes as an "attack", not quiet luft moves like h3/a3
    const advanced = sel === 'w' ? rankIndex(ctx.move.to) >= 3 : rankIndex(ctx.move.to) <= 4
    if (!advanced) return null
    const center = ctx.before.center.state
    const stable = center === 'closed' || center === 'locked'
    if (stable) {
      return {
        status: 'follows',
        confidence: 'medium',
        importance: 50,
        explanation: `Launching this flank pawn is well timed: the centre is ${center}, so it cannot be blown open against you. With a fixed centre, a wing pawn storm is a sound plan.`,
      }
    }
    return {
      status: 'violates',
      confidence: 'medium',
      importance: 54,
      explanation: `This flank pawn push is risky because the centre is still ${center}. If the opponent opens the centre, your king can come under fire before your wing attack arrives. Stabilise the centre (and your king) first.`,
      alternatives: [{ kind: 'king-safety', text: 'Secure the centre and king before pushing on the wing.' }],
    }
  },
)

export const centerRules = [identifyBreaks, prepareBreaks, tension, centralCounterplay, flankBeforeCenter]
