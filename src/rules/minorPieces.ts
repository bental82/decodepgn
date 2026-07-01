// B. Bishop, knight and endgame rules (8-11).

import { opposite, squareColorOf } from '../engine/board'
import type { MoveContext } from '../engine/types'
import {
  activityAt,
  colorName,
  defineRule,
  enemyKingPressure,
  selMaterial,
  tradeInfo,
} from './helpers'

function heavyPieceCount(ctx: MoveContext): number {
  return ctx.after.activity.filter((a) => a.type === 'r' || a.type === 'q').length
}

// 8. Opposite-coloured bishops.
export const oppositeBishops = defineRule(
  {
    id: 'opposite-bishops',
    title: 'Opposite-coloured bishops',
    category: 'minor-pieces',
    description:
      'With opposite-coloured bishops, the middlegame favours the attacker (your bishop hits squares the enemy bishop cannot defend); a pure bishop ending favours the defender and is often drawish.',
    positiveSignals: ['Opposite bishops with heavy pieces still on = attacking chances'],
    negativeSignals: ['Only opposite bishops left = an extra pawn may not win'],
  },
  (ctx) => {
    if (!ctx.after.oppositeColoredBishops) return null
    const sel = ctx.selectedColor
    const heavies = heavyPieceCount(ctx)
    const pressure = enemyKingPressure(ctx, 'after')
    if (heavies >= 2) {
      // middlegame character
      if (pressure.attackers >= 1 || pressure.exposure >= 45) {
        return {
          status: 'follows',
          confidence: 'low',
          importance: 52,
          explanation: `Opposite-coloured bishops with heavy pieces still on favour the attacker. Your bishop attacks squares the enemy bishop can never defend, so pressing for an attack on ${colorName(opposite(sel))}’s king makes sense here.`,
        }
      }
      return {
        status: 'relevant-unclear',
        confidence: 'low',
        importance: 40,
        explanation: `Opposite-coloured bishops are on the board with heavy pieces still around. That usually helps whoever attacks — try to create threats on the colour your bishop controls.`,
      }
    }
    // near-pure bishop ending
    const m = selMaterial(ctx, 'after')
    if (m >= 0.5) {
      return {
        status: 'relevant-unclear',
        confidence: 'medium',
        importance: 50,
        explanation: `With essentially only opposite-coloured bishops left, an extra pawn is often not enough to win — the defending bishop blockades on its colour. Do not assume the endgame is winning just because you are up material.`,
      }
    }
    return {
      status: 'follows',
      confidence: 'low',
      importance: 42,
      explanation: `In this near-pure opposite-bishop ending the defender has good drawing chances. If you are the one under pressure, aim to blockade on your bishop’s colour.`,
    }
  },
)

// 9. Bad bishop rule.
export const badBishop = defineRule(
  {
    id: 'bad-bishop',
    title: 'Bad bishop (blocked by your own pawns)',
    category: 'minor-pieces',
    description:
      'A bishop is bad when several of your own pawns sit on its colour. Trade it, reroute it, or change the pawn structure.',
    positiveSignals: ['You traded or activated a bad bishop'],
    negativeSignals: ['You fixed more of your pawns on your bishop’s colour'],
  },
  (ctx) => {
    const sel = ctx.selectedColor
    const bad = ctx.before.bishops[sel].find((b) => b.bad)
    if (!bad) return null
    // trading/moving the bad bishop
    if (ctx.move.from === bad.square) {
      const t = tradeInfo(ctx)
      if (t.isTrade || (ctx.move.captured && ctx.move.captured !== 'p')) {
        return {
          status: 'follows',
          confidence: 'medium',
          importance: 58,
          explanation: `Good idea to trade off your bad ${bad.squareColor}-squared bishop — it was hemmed in by your own pawns on ${bad.squareColor} squares, so exchanging it improves your remaining pieces.`,
        }
      }
      const after = activityAt(ctx.after, ctx.move.to)
      if (after && after.mobility > bad.mobility) {
        return {
          status: 'partially-follows',
          confidence: 'low',
          importance: 50,
          explanation: `You are rerouting your bad ${bad.squareColor}-squared bishop to a freer diagonal, which is a reasonable way to solve it. Trading it off is the other standard cure.`,
        }
      }
      return null
    }
    // adding another pawn onto the bishop's colour makes it worse
    if (ctx.move.piece === 'p' && squareColorOf(ctx.move.to) === bad.squareColor) {
      return {
        status: 'violates',
        confidence: 'low',
        importance: 46,
        explanation: `Careful: your ${bad.squareColor}-squared bishop is already bad, and this pawn move puts another pawn on a ${bad.squareColor} square, hemming the bishop in further. Prefer trading or freeing that bishop.`,
        alternatives: [{ kind: 'improve-worst-piece', text: `Trade or reroute the bad ${bad.squareColor}-squared bishop.` }],
      }
    }
    return null
  },
)

// 10. Knights love outposts.
export const knightOutposts = defineRule(
  {
    id: 'knight-outposts',
    title: 'Knights love outposts',
    category: 'minor-pieces',
    description:
      'An outpost is an advanced square, defended by your pawn, that no enemy pawn can attack. A knight there is a monster.',
    positiveSignals: ['A knight reached a protected outpost'],
    negativeSignals: ['A strong outpost is available but the knight went elsewhere'],
  },
  (ctx) => {
    const sel = ctx.selectedColor
    if (ctx.move.piece === 'n') {
      const landed = ctx.after.outposts.find((o) => o.square === ctx.move.to && o.color === sel)
      if (landed) {
        return {
          status: 'follows',
          confidence: landed.pawnSupported ? 'high' : 'medium',
          importance: 64,
          explanation: `The knight reaches an outpost on ${ctx.move.to}${
            landed.pawnSupported ? ', protected by your own pawn' : ''
          }. No enemy pawn can chase it away, so it is superbly placed and hard to challenge.`,
        }
      }
    }
    // suggest an unused outpost
    const free = ctx.after.outposts.find((o) => o.color === sel && o.pawnSupported && !o.occupiedByKnight)
    const hasKnight = ctx.after.activity.some((a) => a.color === sel && a.type === 'n')
    if (free && hasKnight && ctx.move.piece !== 'n') {
      return {
        status: 'relevant-unclear',
        confidence: 'low',
        importance: 34,
        explanation: `There is a protected outpost on ${free.square} that a knight could occupy. Manoeuvring a knight there would give you a strong, permanent piece.`,
        alternatives: [{ kind: 'improve-worst-piece', text: `Reroute a knight toward the outpost on ${free.square}.` }],
      }
    }
    return null
  },
)

// 11. Bishops like open positions; knights like closed positions.
export const bishopsVsKnights = defineRule(
  {
    id: 'bishops-vs-knights',
    title: 'Bishops for open positions, knights for closed',
    category: 'minor-pieces',
    description:
      'In open positions bishops shine; in closed/locked positions knights are often stronger. Let that guide which minor piece you trade.',
    positiveSignals: ['Kept the right minor piece for the pawn structure'],
    negativeSignals: ['Traded a bishop in an open position, or a knight in a locked one'],
  },
  (ctx) => {
    const t = tradeInfo(ctx)
    if (!t.isTrade) return null
    const given = ctx.move.piece
    const won = ctx.move.captured
    if (!((given === 'b' && won === 'n') || (given === 'n' && won === 'b'))) return null
    const center = ctx.before.center.state
    const open = center === 'open'
    const closed = center === 'closed' || center === 'locked'
    if (open) {
      if (given === 'b' && won === 'n') {
        return {
          status: 'violates',
          confidence: 'medium',
          importance: 55,
          explanation: `The centre is open, where bishops are usually the better minor piece. Giving up your bishop for a knight here tends to hand the opponent the more useful piece.`,
        }
      }
      return {
        status: 'follows',
        confidence: 'medium',
        importance: 55,
        explanation: `The centre is open, so bishops are at their best. Trading your knight to keep bishops (or win the bishop pair) fits the position well.`,
      }
    }
    if (closed) {
      if (given === 'n' && won === 'b') {
        return {
          status: 'violates',
          confidence: 'medium',
          importance: 55,
          explanation: `The centre is ${center}, where knights are often stronger than bishops. Trading your knight for a bishop gives up your better minor piece for the structure.`,
        }
      }
      return {
        status: 'follows',
        confidence: 'medium',
        importance: 55,
        explanation: `The centre is ${center}, so knights tend to outshine bishops. Trading your bishop for a knight here is well judged.`,
      }
    }
    return null
  },
)

export const minorPieceRules = [oppositeBishops, badBishop, knightOutposts, bishopsVsKnights]
