// C. Rooks, files and activity (12-15).

import { opposite } from '../engine/board'
import type { Color, MoveContext } from '../engine/types'
import {
  activityAt,
  colorName,
  defineRule,
  fileOf,
  isAttackedBy,
  isCheck,
  moveSee,
  pieceWord,
  worstPiece,
} from './helpers'

function semiOpenForSelected(ctx: MoveContext, color: Color): string[] {
  return color === 'w' ? ctx.after.files.semiOpenForWhite : ctx.after.files.semiOpenForBlack
}

function undevelopedMinors(ctx: MoveContext, color: Color): number {
  const backRank = color === 'w' ? '1' : '8'
  return ctx.before.activity.filter(
    (a) => a.color === color && (a.type === 'n' || a.type === 'b') && a.square[1] === backRank,
  ).length
}

// 12. Rooks belong on open or semi-open files.
export const rooksOnFiles = defineRule(
  {
    id: 'rooks-on-files',
    title: 'Rooks belong on open or semi-open files',
    category: 'rooks-activity',
    description:
      'Rooks are strongest on files with no pawns (open) or no friendly pawns (semi-open), where they create pressure.',
    positiveSignals: ['A rook moved to an open or semi-open file'],
    negativeSignals: ['A rook sits passively while an open file is available'],
  },
  (ctx) => {
    const sel = ctx.selectedColor
    if (ctx.move.piece === 'r') {
      const f = fileOf(ctx.move.to)
      if (ctx.after.files.open.includes(f)) {
        return {
          status: 'follows',
          confidence: 'high',
          importance: 60,
          explanation: `Placing the rook on the open ${f}-file is a textbook improving move — an open file is exactly where a rook wants to be, ready to invade or pressure the position.`,
        }
      }
      if (semiOpenForSelected(ctx, sel).includes(f)) {
        return {
          status: 'follows',
          confidence: 'medium',
          importance: 55,
          explanation: `The rook goes to the semi-open ${f}-file, where it presses against ${colorName(opposite(sel))}’s pawn on that file. Semi-open files are natural targets for your rooks.`,
        }
      }
      return {
        status: 'partially-follows',
        confidence: 'low',
        importance: 38,
        explanation: `The rook moved to the ${f}-file, which is currently blocked by pawns. That can be fine if it supports a pawn break or a plan to open the file later — otherwise an open file would be more active.`,
      }
    }
    // suggest an idle open file
    const openFile = ctx.after.files.open[0]
    const idleRook = ctx.after.activity.find((a) => a.color === sel && a.type === 'r' && a.score < 35)
    if (openFile && idleRook) {
      return {
        status: 'relevant-unclear',
        confidence: 'low',
        importance: 33,
        explanation: `Your rook on ${idleRook.square} is fairly passive while the ${openFile}-file is open. Bringing a rook to that file would put it to work.`,
        alternatives: [{ kind: 'improve-worst-piece', text: `Move a rook to the open ${openFile}-file.` }],
      }
    }
    return null
  },
)

// 13. Improve your worst piece.
export const improveWorstPiece = defineRule(
  {
    id: 'improve-worst-piece',
    title: 'Improve your worst piece',
    category: 'rooks-activity',
    description:
      'A good quiet move often just activates your least useful piece. Find the piece doing nothing and give it a job.',
    positiveSignals: ['You moved your least active piece to a better square'],
    negativeSignals: ['You made a move while your worst piece keeps sitting idle'],
  },
  (ctx) => {
    const sel = ctx.selectedColor
    const worst = worstPiece(ctx.before, sel)
    if (!worst) return null
    if (ctx.move.from === worst.square) {
      const after = activityAt(ctx.after, ctx.move.to)
      const improved = after && after.score > worst.score + 6
      return {
        status: improved ? 'follows' : 'partially-follows',
        confidence: improved ? 'high' : 'low',
        importance: 58,
        explanation: improved
          ? `Nice improving move: your ${pieceWord(worst.type)} on ${worst.square} was your least active piece, and this brings it to a better square. Activating your worst piece is one of the most reliable ways to improve a position.`
          : `You are moving your least active piece (${pieceWord(worst.type)} on ${worst.square}), which is the right idea, though ${ctx.move.to} does not clearly increase its activity. Aim to route it toward an open file, a diagonal, or an outpost.`,
      }
    }
    if (!ctx.move.captured && worst.score < 18) {
      return {
        status: 'relevant-unclear',
        confidence: 'low',
        importance: 36,
        explanation: `Before making natural moves, note that your ${pieceWord(worst.type)} on ${worst.square} is doing very little. A plan to activate it would likely improve your position more than most alternatives.`,
        alternatives: [
          { kind: 'improve-worst-piece', text: `Find a route to activate the ${pieceWord(worst.type)} on ${worst.square}.` },
        ],
      }
    }
    return null
  },
)

// 14. Do not grab pawns if development or king safety suffers.
export const pawnGrab = defineRule(
  {
    id: 'pawn-grab',
    title: 'Don’t grab pawns at the cost of development/king safety',
    category: 'rooks-activity',
    description:
      'A “free” pawn is not free if taking it loses time, sidelines your queen, or exposes your king.',
    positiveSignals: ['The pawn was genuinely free with no downside'],
    negativeSignals: ['You grabbed a pawn with the queen or fell behind in development'],
  },
  (ctx) => {
    if (ctx.move.captured !== 'p') return null
    const gain = moveSee(ctx)
    if (gain <= 0) return null // not actually winning the pawn — other rules cover that
    const sel = ctx.selectedColor
    const queenGrab = ctx.move.piece === 'q'
    const early = ctx.moveNumber <= 12
    const grabberHit = isAttackedBy(ctx.move.after, ctx.move.to, opposite(sel))
    const behindDevelopment = undevelopedMinors(ctx, sel) >= 2

    if (queenGrab && (early || grabberHit)) {
      return {
        status: 'violates',
        confidence: 'medium',
        importance: 57,
        explanation: `Taking this pawn with the queen looks risky. The pawn is not truly free: ${
          grabberHit ? 'your queen can already be hit with tempo, ' : ''
        }and pulling the queen out early lets the opponent develop with threats while you spend moves saving her.`,
        alternatives: [{ kind: 'king-safety', text: 'Complete development / castle before going pawn-hunting.' }],
      }
    }
    if (early && behindDevelopment) {
      return {
        status: 'partially-follows',
        confidence: 'low',
        importance: 46,
        explanation: `You win a pawn, but you are still behind in development (${undevelopedMinors(
          ctx,
          sel,
        )} minor pieces at home). Grabbing material before developing can hand the opponent dangerous initiative — make sure the pawn is worth the time.`,
      }
    }
    if (grabberHit) {
      return {
        status: 'relevant-unclear',
        confidence: 'low',
        importance: 40,
        explanation: `You win a pawn, but the capturing ${pieceWord(
          ctx.move.piece,
        )} can be attacked, so count the tempi carefully — the opponent may regain time or the initiative.`,
      }
    }
    return {
      status: 'follows',
      confidence: 'low',
      importance: 34,
      explanation: `This pawn looks genuinely free — no obvious loss of time or king safety in return. Taking it is fine.`,
    }
  },
)

// 15. The queen is powerful but not a developer.
export const queenNotDeveloper = defineRule(
  {
    id: 'queen-not-developer',
    title: 'The queen is not a developer',
    category: 'rooks-activity',
    description:
      'Bringing the queen out early rarely develops anything — it usually just gives the opponent tempo to develop by attacking her.',
    positiveSignals: ['The queen move made a real threat, check, or capture'],
    negativeSignals: ['An early aimless queen move that can be hit with tempo'],
  },
  (ctx) => {
    if (ctx.move.piece !== 'q') return null
    if (ctx.moveNumber > 10) return null
    const sel = ctx.selectedColor
    const check = isCheck(ctx.move)
    const capGain = moveSee(ctx)
    const queenAttacked = isAttackedBy(ctx.move.after, ctx.move.to, opposite(sel))
    if (check || capGain >= 1) {
      return {
        status: 'follows',
        confidence: 'medium',
        importance: 48,
        explanation: `This early queen move has a concrete point (${
          check ? 'a check' : 'winning material'
        }), so it is justified rather than routine development.`,
      }
    }
    if (queenAttacked) {
      return {
        status: 'violates',
        confidence: 'medium',
        importance: 54,
        explanation: `Risky early queen move: the queen can already be attacked, which lets ${colorName(
          opposite(sel),
        )} develop a piece with tempo by hitting her. Develop minor pieces and castle first; bring the queen out once she has a real job.`,
        alternatives: [{ kind: 'king-safety', text: 'Develop a minor piece or castle instead.' }],
      }
    }
    return {
      status: 'partially-follows',
      confidence: 'low',
      importance: 42,
      explanation: `An early queen move without a clear threat. It is not losing anything yet, but the queen does not develop your army — make sure she is not about to be chased around.`,
    }
  },
)

export const activityRules = [rooksOnFiles, improveWorstPiece, pawnGrab, queenNotDeveloper]
