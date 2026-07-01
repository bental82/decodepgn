// A. Trading rules (1-7).

import { opposite } from '../engine/board'
import type { Color, PositionInfo } from '../engine/types'
import {
  activityAt,
  aheadState,
  colorName,
  defineRule,
  enemyKingPressure,
  fileOf,
  isCapture,
  isCheck,
  moveSee,
  pieceWord,
  selMaterial,
  squaresAttackingKingZone,
  tradeInfo,
} from './helpers'

function describeActivity(score: number): string {
  if (score >= 62) return 'active'
  if (score >= 40) return 'reasonably placed'
  if (score >= 22) return 'passive'
  return 'very passive'
}

function ownSpace(info: PositionInfo, color: Color): number {
  return color === 'w' ? info.space.white : info.space.black
}

// 1. Trade your bad pieces for your opponent's good pieces.
export const tradeBadForGood = defineRule(
  {
    id: 'trade-bad-for-good',
    title: 'Trade bad pieces for good pieces',
    category: 'trading',
    description:
      'An exchange is attractive when you give up a passive piece for one of the opponent’s active, well-placed pieces.',
    positiveSignals: ['Your traded piece was passive', 'The enemy piece you took was active/central'],
    negativeSignals: ['You gave up an active piece for a passive one'],
  },
  (ctx) => {
    const t = tradeInfo(ctx)
    if (!t.isTrade) return null
    const given = activityAt(ctx.before, ctx.move.from)
    const won = activityAt(ctx.before, ctx.move.to)
    if (!given || !won) return null
    const diff = won.score - given.score
    const yourPiece = `your ${describeActivity(given.score)} ${pieceWord(given.type)}`
    const theirPiece = `their ${describeActivity(won.score)} ${pieceWord(won.type)}`
    if (diff >= 14) {
      return {
        status: 'follows',
        confidence: 'medium',
        importance: 62,
        explanation: `This trade looks favourable: you gave up ${yourPiece} for ${theirPiece}. Removing an active enemy piece while parting with a less useful one of your own is usually a good deal.`,
      }
    }
    if (diff <= -14) {
      return {
        status: 'violates',
        confidence: 'medium',
        importance: 60,
        explanation: `This trade may help the opponent: you gave up ${yourPiece} for ${theirPiece}. Handing over your more active piece for their passive one tends to ease their position.`,
      }
    }
    return {
      status: 'relevant-unclear',
      confidence: 'low',
      importance: 40,
      explanation: `You exchanged ${yourPiece} for ${theirPiece}. The two pieces were similarly placed, so the trade is roughly neutral on activity grounds — judge it by the resulting structure and plans.`,
    }
  },
)

// 2. When ahead in material, trade pieces, not necessarily pawns.
export const aheadTradePieces = defineRule(
  {
    id: 'ahead-trade-pieces',
    title: 'When ahead, trade pieces (keep pawns)',
    category: 'trading',
    description:
      'With extra material, trading pieces simplifies toward a winning endgame. Trading pawns can backfire — pawns are what you win with.',
    positiveSignals: ['You are ahead and traded a piece'],
    negativeSignals: ['You are ahead and traded pawns down toward a drawish ending'],
  },
  (ctx) => {
    const a = aheadState(ctx, 'before')
    if (a.state !== 'ahead') return null
    const t = tradeInfo(ctx)
    if (t.isTrade) {
      return {
        status: 'follows',
        confidence: 'high',
        importance: 66,
        explanation: `You are ahead by about ${a.margin.toFixed(0)} point(s), so trading pieces is exactly right. Every piece swap reduces the opponent’s counterplay and brings you closer to converting the win.`,
      }
    }
    if (ctx.move.piece === 'p' && ctx.move.captured === 'p') {
      return {
        status: 'partially-follows',
        confidence: 'medium',
        importance: 48,
        explanation: `You are ahead, so be a little careful about trading pawns. Pawns are what you win with — trading pieces (not pawns) is the cleaner way to simplify toward the win.`,
      }
    }
    return null
  },
)

// 3. When behind in material, avoid unnecessary piece trades.
export const behindAvoidTrades = defineRule(
  {
    id: 'behind-avoid-trades',
    title: 'When behind, avoid piece trades',
    category: 'trading',
    description:
      'Behind in material, keep pieces on to preserve practical and attacking chances — unless the trade wins material back, forces a draw, or reaches a favourable endgame.',
    positiveSignals: ['The trade wins material back or forces the issue'],
    negativeSignals: ['You are behind and traded pieces with no concrete gain'],
  },
  (ctx) => {
    const a = aheadState(ctx, 'before')
    if (a.state !== 'behind') return null
    const t = tradeInfo(ctx)
    if (!t.isTrade) return null
    const gain = moveSee(ctx)
    if (gain >= 1) {
      return {
        status: 'partially-follows',
        confidence: 'medium',
        importance: 55,
        explanation: `You are behind, and this trade appears to win some material back (about ${gain.toFixed(0)} point(s)). That justifies simplifying here — otherwise, trading while behind usually helps the side that is ahead.`,
      }
    }
    if (isCheck(ctx.move)) {
      return {
        status: 'relevant-unclear',
        confidence: 'low',
        importance: 45,
        explanation: `You are behind. This trade comes with a check, so it may be part of a forcing sequence. If it does not win material or force a draw, keeping pieces on to fight would usually be better.`,
      }
    }
    return {
      status: 'violates',
      confidence: 'medium',
      importance: 58,
      explanation: `Since you are behind by about ${Math.abs(a.margin).toFixed(0)} point(s), this trade reduces your attacking and practical chances. When behind, keep pieces on the board unless the exchange wins material or forces a draw.`,
    }
  },
)

// 4. Do not trade away attacking pieces without a concrete gain.
export const keepAttackers = defineRule(
  {
    id: 'keep-attackers',
    title: 'Keep your attacking pieces',
    category: 'trading',
    description:
      'If your pieces are aimed at the enemy king, do not trade an attacker unless you remove a key defender.',
    positiveSignals: ['The trade removes a defender of the enemy king'],
    negativeSignals: ['You traded off one of your own attackers for a non-defender'],
  },
  (ctx) => {
    const pre = enemyKingPressure(ctx, 'before')
    if (pre.attackers < 1) return null
    const t = tradeInfo(ctx)
    if (!t.isTrade) return null
    const enemy = opposite(ctx.selectedColor)
    const defenders = squaresAttackingKingZone(ctx.move.before, enemy, enemy)
    const myAttackers = squaresAttackingKingZone(ctx.move.before, enemy, ctx.selectedColor)
    const capturedWasDefender = defenders.has(ctx.move.to)
    const movingWasAttacker = myAttackers.has(ctx.move.from)
    if (capturedWasDefender) {
      return {
        status: 'follows',
        confidence: 'medium',
        importance: 64,
        explanation: `This trade removes one of the enemy king’s defenders (the ${pieceWord(ctx.move.captured!)} on ${ctx.move.to}). Taking off defenders while you have an attack going is exactly the kind of exchange you want.`,
      }
    }
    if (movingWasAttacker) {
      return {
        status: 'violates',
        confidence: 'medium',
        importance: 63,
        explanation: `You have pieces aimed at ${colorName(enemy)}’s king, but this trade gives up one of your attackers for a piece that was not defending the king. That tends to make the defence easier. Keep your attackers unless you gain something concrete.`,
        alternatives: [
          { kind: 'trade-defender', text: 'Look for a way to trade off a defender of the enemy king instead.' },
        ],
      }
    }
    return null
  },
)

// 5. Consider pawn structure after recapture.
export const recaptureStructure = defineRule(
  {
    id: 'recapture-structure',
    title: 'Watch the pawn structure after a capture',
    category: 'trading',
    description:
      'Captures reshape pawns. Look for doubled, isolated or backward pawns created, files opened, and whether your own king cover is weakened.',
    positiveSignals: ['You gave the opponent doubled/isolated pawns', 'You opened a file for your rook'],
    negativeSignals: ['You doubled or isolated your own pawns', 'You opened a file toward your own king'],
  },
  (ctx) => {
    if (!isCapture(ctx.move)) return null
    const sel = ctx.selectedColor
    const enemy = opposite(sel)
    const bE = ctx.before.pawns[enemy]
    const aE = ctx.after.pawns[enemy]
    const bS = ctx.before.pawns[sel]
    const aS = ctx.after.pawns[sel]

    const newEnemyDoubled = aE.doubledFiles.filter((f) => !bE.doubledFiles.includes(f))
    const newEnemyIsolated = aE.isolatedSquares.length - bE.isolatedSquares.length
    const newOwnDoubled = aS.doubledFiles.filter((f) => !bS.doubledFiles.includes(f))
    const newOwnIsolated = aS.isolatedSquares.length - bS.isolatedSquares.length
    const newOpenFiles = ctx.after.files.open.filter((f) => !ctx.before.files.open.includes(f))

    const good: string[] = []
    if (newEnemyDoubled.length) good.push(`gives ${colorName(enemy)} doubled ${newEnemyDoubled.join('/')}-pawns`)
    if (newEnemyIsolated > 0) good.push(`leaves ${colorName(enemy)} with an isolated pawn`)

    const bad: string[] = []
    if (newOwnDoubled.length) bad.push(`doubles your own ${newOwnDoubled.join('/')}-pawns`)
    if (newOwnIsolated > 0) bad.push(`isolates one of your pawns`)
    // opened file toward own king?
    const kingFile = fileOf(ctx.after.king[sel].square)
    const openedNearOwnKing = newOpenFiles.filter((f) => Math.abs(f.charCodeAt(0) - kingFile.charCodeAt(0)) <= 1)
    if (openedNearOwnKing.length) bad.push(`opens the ${openedNearOwnKing.join('/')}-file near your own king`)

    if (!good.length && !bad.length) return null
    if (good.length && !bad.length) {
      return {
        status: 'follows',
        confidence: 'medium',
        importance: 57,
        explanation: `After the recapture, the structure favours you: this ${good.join(' and ')}, giving you a long-term target to work against.`,
      }
    }
    if (bad.length && !good.length) {
      return {
        status: 'violates',
        confidence: 'medium',
        importance: 56,
        explanation: `Be careful with the resulting structure: this capture ${bad.join(' and ')}. Weigh that structural cost against what you got for it.`,
      }
    }
    return {
      status: 'partially-follows',
      confidence: 'low',
      importance: 50,
      explanation: `Mixed structural result: it ${good.join(' and ')}, but also ${bad.join(' and ')}. Decide whether the target you create outweighs the weakness you accept.`,
    }
  },
)

// 6. Cramped side wants trades; space-advantage side usually avoids them.
export const spaceAndTrades = defineRule(
  {
    id: 'space-and-trades',
    title: 'Cramped side wants trades; more space avoids them',
    category: 'trading',
    description:
      'If you are cramped, trading pieces relieves the squeeze. If you have more space, keeping pieces on preserves your advantage.',
    positiveSignals: ['You are cramped and traded to get breathing room'],
    negativeSignals: ['You have more space but traded pieces unnecessarily'],
  },
  (ctx) => {
    const sel = ctx.selectedColor
    const diff = ownSpace(ctx.before, sel) - ownSpace(ctx.before, opposite(sel))
    const t = tradeInfo(ctx)
    if (!t.isTrade) return null
    if (diff <= -3) {
      return {
        status: 'follows',
        confidence: 'medium',
        importance: 54,
        explanation: `You have less space here, so trading pieces is useful — it gives your cramped position room to breathe. The cramped side generally welcomes exchanges.`,
      }
    }
    if (diff >= 3) {
      return {
        status: 'partially-follows',
        confidence: 'low',
        importance: 48,
        explanation: `You appear to hold more space, so an unnecessary trade may help the opponent unwind. With a space advantage, keeping pieces on the board usually preserves the pressure.`,
      }
    }
    return null
  },
)

// 7. Before entering an endgame, ask whether the endgame is good.
export const endgameCheck = defineRule(
  {
    id: 'endgame-check',
    title: 'Before the endgame, ask if the endgame is good',
    category: 'trading',
    description:
      'When the queens come off, name the likely endgame. Opposite-coloured bishops and many pure-piece endings can be drawish even a pawn up.',
    positiveSignals: ['You are ahead and heading into a clean, winnable endgame'],
    negativeSignals: ['You traded into a drawish (e.g. opposite-bishop) ending while trying to win'],
  },
  (ctx) => {
    const enteringEndgame = ctx.after.queensOff && !ctx.before.queensOff
    if (!enteringEndgame) return null
    const m = selMaterial(ctx, 'after')
    const ocb = ctx.after.oppositeColoredBishops
    if (ocb) {
      return {
        status: m > 0.5 ? 'violates' : 'relevant-unclear',
        confidence: 'medium',
        importance: 60,
        explanation: `This queen trade is not automatically good. The resulting opposite-coloured-bishop ending is often drawish${
          m > 0.5 ? ', so simplifying may be throwing away winning chances even a pawn up' : ''
        }. Make sure the endgame is actually one you want before committing to it.`,
      }
    }
    if (m >= 1.5) {
      return {
        status: 'follows',
        confidence: 'medium',
        importance: 56,
        explanation: `Trading queens while up about ${m.toFixed(0)} point(s) is sensible: with the queens off, your extra material is easier to convert and the opponent has less counterplay.`,
      }
    }
    if (m <= -1.5) {
      return {
        status: 'violates',
        confidence: 'medium',
        importance: 54,
        explanation: `You are down material and heading into an endgame by trading queens. Queens usually give the side that is behind the best swindling chances — think twice before simplifying.`,
      }
    }
    return {
      status: 'relevant-unclear',
      confidence: 'low',
      importance: 45,
      explanation: `The queens are coming off. Pause to name the endgame you are getting (rook ending, minor-piece ending, pawn ending) and decide whether it suits you before committing.`,
    }
  },
)

export const tradingRules = [
  tradeBadForGood,
  aheadTradePieces,
  behindAvoidTrades,
  keepAttackers,
  recaptureStructure,
  spaceAndTrades,
  endgameCheck,
]
