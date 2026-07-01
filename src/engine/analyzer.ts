// Orchestrates per-move analysis from the selected colour's perspective.

import { ALL_RULES } from '../rules'
import { PIECE_NAME, PIECE_VALUE, opposite } from './board'
import { breaksFor } from './breaks'
import { parsePgn } from './game'
import { analyzePosition, materialFor } from './position'
import { bestCaptureFor, see, staticRead } from './tactics'
import type {
  Alternative,
  Color,
  GameAnalysis,
  MoveAnalysis,
  MoveContext,
  RuleFinding,
  TacticalRead,
  TacticalWarning,
  VerboseMove,
} from './types'
import { summarize } from './summary'

function colorName(c: Color): string {
  return c === 'w' ? 'White' : 'Black'
}

const EMPTY_READ: TacticalRead = { bestCaptureGain: 0, hanging: [], inCheck: false }

function moveSee(move: VerboseMove): number {
  if (!move.captured) return -see(move.after, move.to)
  return PIECE_VALUE[move.captured] - see(move.after, move.to)
}

function buildContext(moves: VerboseMove[], ply: number, selectedColor: Color): MoveContext {
  const move = moves[ply]
  const bySelected = move.color === selectedColor
  const before = analyzePosition(move.before)
  const after = analyzePosition(move.after)
  return {
    ply,
    moveNumber: Math.floor(ply / 2) + 1,
    selectedColor,
    move,
    bySelected,
    before,
    after,
    tactics: bySelected
      ? { before: staticRead(move.before), after: staticRead(move.after) }
      : { before: EMPTY_READ, after: EMPTY_READ },
    breaks: bySelected
      ? { before: breaksFor(move.before, selectedColor), after: breaksFor(move.after, selectedColor) }
      : { before: [], after: [] },
    game: moves,
  }
}

function tacticalWarnings(ctx: MoveContext, opponentThreatBefore: number): TacticalWarning[] {
  const out: TacticalWarning[] = []
  const enemy = opposite(ctx.selectedColor)
  const afterThreat = ctx.tactics.after.bestCaptureGain
  const sq = ctx.tactics.after.bestCaptureSquare
  const movedHanging = sq === ctx.move.to
  const delta = afterThreat - opponentThreatBefore
  const isMate = ctx.move.san.includes('#')

  if (!isMate && afterThreat >= 1 && (movedHanging || delta >= 1)) {
    const severity = afterThreat >= 5 ? 'danger' : afterThreat >= 2 ? 'warning' : 'info'
    const tail =
      severity === 'info'
        ? 'This may be an intended gambit — just make sure the pawn is worth it.'
        : 'Double-check this isn’t a blunder.'
    out.push({
      severity,
      confidence: 'medium',
      text: movedHanging
        ? `After ${ctx.move.san}, the ${PIECE_NAME[ctx.move.piece]} on ${ctx.move.to} looks loose — ${colorName(
            enemy,
          )} appears to win about ${afterThreat.toFixed(0)} point(s) (for example a capture on ${sq}). ${tail}`
        : `${ctx.move.san} appears to let ${colorName(enemy)} win about ${afterThreat.toFixed(
            0,
          )} point(s) (for example a capture on ${sq}). ${tail}`,
    })
  }

  const beforeBest = ctx.tactics.before.bestCaptureGain
  const beforeSq = ctx.tactics.before.bestCaptureSquare
  const played = moveSee(ctx.move)
  if (beforeBest >= 2 && played < beforeBest - 0.5 && ctx.move.to !== beforeSq) {
    out.push({
      severity: 'info',
      confidence: 'medium',
      text: `You may have missed a stronger tactic: capturing on ${beforeSq} looked like it wins about ${beforeBest.toFixed(
        0,
      )} point(s). Worth checking whether ${ctx.move.san} was the best use of the position.`,
    })
  }
  return out
}

/**
 * Keep the substantive findings and only surface the gentle "reminder" findings
 * (low importance, relevant-but-unclear) on quiet moves that have little else to
 * say. This keeps the panel focused and keeps the summary counts meaningful.
 */
function trimFindings(findings: RuleFinding[]): RuleFinding[] {
  const strong = findings.filter((f) => f.importance >= 44)
  const weak = findings.filter((f) => f.importance < 44)
  const kept = strong.length >= 2 ? strong : [...strong, ...weak.slice(0, 2 - strong.length)]
  return kept.slice(0, 7)
}

function dedupeAlternatives(list: Alternative[]): Alternative[] {
  const seen = new Set<string>()
  const out: Alternative[] = []
  for (const a of list) {
    const key = a.kind + '|' + a.text
    if (seen.has(key)) continue
    seen.add(key)
    out.push(a)
  }
  return out.slice(0, 4)
}

function humanLesson(findings: RuleFinding[], warnings: TacticalWarning[]): string {
  const danger = warnings.find((w) => w.severity === 'danger')
  if (danger) {
    return `The key point here is tactical. ${danger.text} Strategy matters, but not losing material comes first.`
  }
  const top = findings[0]
  if (top) {
    const lead =
      top.status === 'follows'
        ? 'Well judged. '
        : top.status === 'violates'
          ? 'Something to reconsider. '
          : top.status === 'partially-follows'
            ? 'On the right track. '
            : ''
    let lesson = `${lead}${top.explanation}`
    const warn = warnings.find((w) => w.severity === 'warning' || w.severity === 'info')
    if (warn) lesson += ` Also: ${warn.text}`
    return lesson
  }
  if (warnings.length) return warnings[0].text
  return `No single rule dominates here. Run the quick checklist: is my king safe? is there a tactic for either side? what is my worst piece? do I have a pawn break, and are my pieces ready for it?`
}

export function analyzeGame(pgn: string, selectedColor: Color): GameAnalysis {
  const { headers, moves } = parsePgn(pgn)
  const analyses: MoveAnalysis[] = []

  for (let ply = 0; ply < moves.length; ply++) {
    const move = moves[ply]
    const before = analyzePosition(move.before)
    const after = analyzePosition(move.after)
    const moveNumber = Math.floor(ply / 2) + 1
    const materialBefore = materialFor(before, selectedColor)
    const materialAfter = materialFor(after, selectedColor)

    if (move.color !== selectedColor) {
      analyses.push({
        ply,
        moveNumber,
        color: move.color,
        san: move.san,
        from: move.from,
        to: move.to,
        bySelected: false,
        fenBefore: move.before,
        fenAfter: move.after,
        materialBefore,
        materialAfter,
        findings: [],
        tacticalWarnings: [],
        humanLesson: `${colorName(move.color)}’s move. You chose to study ${colorName(
          selectedColor,
        )}, so the strategic breakdown is shown for ${colorName(selectedColor)}’s moves.`,
        alternatives: [],
      })
      continue
    }

    const ctx = buildContext(moves, ply, selectedColor)
    const allFindings = ALL_RULES.map((r) => r.detect(ctx))
      .filter((f): f is RuleFinding => f !== null)
      .sort((a, b) => b.importance - a.importance)
    const findings = trimFindings(allFindings)
    const opponentThreatBefore = bestCaptureFor(move.before, opposite(selectedColor)).gain
    const warnings = tacticalWarnings(ctx, opponentThreatBefore)
    const alternatives = dedupeAlternatives(findings.flatMap((f) => f.alternatives ?? []))
    const humanLessonText = humanLesson(findings, warnings)

    analyses.push({
      ply,
      moveNumber,
      color: move.color,
      san: move.san,
      from: move.from,
      to: move.to,
      bySelected: true,
      fenBefore: move.before,
      fenAfter: move.after,
      materialBefore,
      materialAfter,
      findings,
      tacticalWarnings: warnings,
      humanLesson: humanLessonText,
      alternatives,
    })
  }

  const summary = summarize(analyses, selectedColor)
  return { selectedColor, headers, moves: analyses, summary }
}
