// Digest one analysed game into the compact summary the meta-analysis feeds
// on. Shared: the browser summarizes its local games, the server summarizes
// the cloud archive — both must produce identical shapes.

import { gameAccuracy } from './accuracy'
import type { Color, EngineEval, Focus, MetaGameSummary, MoveResult } from './types'

/** The minimal saved-game shape needed (SavedGame satisfies it structurally). */
export interface SummarizableGame {
  key: string
  pgn: string
  focus: Focus
  headers: Record<string, string>
  results: Record<number, MoveResult>
  me?: Color
  addedAt?: number
}

const top5 = (m: Map<number, number>) =>
  [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, n]) => ({ id, n }))

export function summarizeGame(g: SummarizableGame): MetaGameSummary {
  // Opening: the first moves of the movetext (headers/comments stripped).
  const movetext = g.pgn
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const opening = movetext.split(' ').slice(0, 18).join(' ')

  const broken = new Map<number, number>()
  const followed = new Map<number, number>()
  const soundness = { sound: 0, speculative: 0, dubious: 0 }
  let cpSum = 0
  let checked = 0
  let worst = 0
  let blunders = 0
  const lessons: Array<{ cp: number; text: string }> = []
  // Accuracy is personal: when a game studied both sides, only the flagged
  // player's own moves count towards it.
  const meSide = g.me ?? (g.focus !== 'both' ? g.focus : undefined)
  const ownEvals: EngineEval[] = []

  for (const r of Object.values(g.results ?? {})) {
    for (const h of r.rules ?? []) {
      if (h.status === 'violates') broken.set(h.id, (broken.get(h.id) ?? 0) + 1)
      else if (h.status === 'follows') followed.set(h.id, (followed.get(h.id) ?? 0) + 1)
    }
    if (r.soundness && soundness[r.soundness] !== undefined) soundness[r.soundness]++
    if (r.engine) {
      cpSum += r.engine.cpLoss
      checked++
      worst = Math.max(worst, r.engine.cpLoss)
      if (r.engine.cpLoss >= 150) blunders++
      if (!meSide || (r.ply % 2 === 0 ? 'w' : 'b') === meSide) ownEvals.push(r.engine)
    }
    if (r.lesson) lessons.push({ cp: r.engine?.cpLoss ?? 0, text: r.lesson })
  }

  const out: MetaGameSummary = {
    key: g.key,
    white: g.headers?.White || 'White',
    black: g.headers?.Black || 'Black',
    focus: g.focus,
    opening,
    analysed: Object.keys(g.results ?? {}).length,
    ruleBroken: top5(broken),
    ruleFollowed: top5(followed),
    soundness,
    lessons: lessons
      .sort((a, b) => b.cp - a.cp)
      .slice(0, 3)
      .map((l) => l.text),
  }
  if (meSide) out.me = meSide
  if (g.headers?.Result) out.result = g.headers.Result
  if (g.headers?.Date) out.date = g.headers.Date
  if (Number.isFinite(g.addedAt)) out.addedAt = g.addedAt
  if (checked > 0) {
    out.engine = {
      avgCpLoss: Math.round(cpSum / checked),
      worst,
      blunders,
      checked,
    }
    const acc = gameAccuracy(ownEvals)
    if (acc != null) out.engine.accuracy = acc
  }
  return out
}
