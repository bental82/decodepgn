// Recurring-pattern summary for the selected colour, aggregated across the game.

import type { Color, MoveAnalysis, PatternStat, SummaryReport } from './types'

interface PatternDef {
  id: string
  label: string
  description: string
  severity: PatternStat['severity']
  match: (f: { ruleId: string; status: string }) => boolean
}

const PATTERNS: PatternDef[] = [
  {
    id: 'trades-when-behind',
    label: 'Trades pieces when behind',
    description: 'Exchanging pieces while down material usually helps the side that is ahead.',
    severity: 'warning',
    match: (f) => f.ruleId === 'behind-avoid-trades' && f.status === 'violates',
  },
  {
    id: 'releases-tension-early',
    label: 'Releases central tension too early',
    description: 'Capturing to resolve tension with no concrete gain often frees the opponent’s game.',
    severity: 'warning',
    match: (f) => f.ruleId === 'tension' && f.status === 'partially-follows',
  },
  {
    id: 'misses-breaks',
    label: 'Overlooks pawn breaks',
    description: 'A thematic pawn break was available but not played.',
    severity: 'info',
    match: (f) => f.ruleId === 'identify-breaks' && f.status === 'relevant-unclear',
  },
  {
    id: 'early-queen',
    label: 'Brings the queen out too early',
    description: 'Early queen moves let the opponent develop with tempo.',
    severity: 'warning',
    match: (f) => f.ruleId === 'queen-not-developer' && f.status !== 'follows',
  },
  {
    id: 'idle-worst-piece',
    label: 'Leaves the worst piece idle',
    description: 'A clearly passive piece was left doing nothing.',
    severity: 'info',
    match: (f) => f.ruleId === 'improve-worst-piece' && f.status === 'relevant-unclear',
  },
  {
    id: 'unsound-sacs',
    label: 'Sacrifices without enough attackers',
    description: 'Material was given up without the attackers/forcing moves to back it.',
    severity: 'warning',
    match: (f) => f.ruleId === 'sac-warning' || (f.ruleId === 'sac-soundness' && f.status === 'violates'),
  },
  {
    id: 'flank-open-center',
    label: 'Attacks on the flank with an unstable centre',
    description: 'Wing pawn storms are risky while the centre can still be opened.',
    severity: 'warning',
    match: (f) => f.ruleId === 'flank-before-center' && f.status === 'violates',
  },
  {
    id: 'passive-vs-wing-attack',
    label: 'Meets wing attacks passively',
    description: 'Central counterplay was available against a flank attack but not taken.',
    severity: 'info',
    match: (f) => f.ruleId === 'central-counterplay' && f.status === 'relevant-unclear',
  },
  {
    id: 'pawn-grabbing',
    label: 'Grabs pawns at the cost of development',
    description: 'Pawns were taken while behind in development or with the queen.',
    severity: 'warning',
    match: (f) => f.ruleId === 'pawn-grab' && f.status === 'violates',
  },
  // positive habits
  {
    id: 'simplifies-when-ahead',
    label: 'Simplifies well when ahead',
    description: 'Trades pieces to convert a material advantage — good technique.',
    severity: 'good',
    match: (f) => f.ruleId === 'ahead-trade-pieces' && f.status === 'follows',
  },
  {
    id: 'uses-outposts',
    label: 'Uses knight outposts',
    description: 'Places knights on strong, protected advanced squares.',
    severity: 'good',
    match: (f) => f.ruleId === 'knight-outposts' && f.status === 'follows',
  },
  {
    id: 'activates-rooks',
    label: 'Puts rooks on good files',
    description: 'Brings rooks to open and semi-open files.',
    severity: 'good',
    match: (f) => f.ruleId === 'rooks-on-files' && f.status === 'follows',
  },
  {
    id: 'improves-pieces',
    label: 'Improves the worst piece',
    description: 'Regularly activates the least useful piece — a strong habit.',
    severity: 'good',
    match: (f) => f.ruleId === 'improve-worst-piece' && f.status === 'follows',
  },
  {
    id: 'central-counter',
    label: 'Answers wing attacks in the centre',
    description: 'Uses central counterplay against flank attacks.',
    severity: 'good',
    match: (f) => f.ruleId === 'central-counterplay' && f.status === 'follows',
  },
]

const SEVERITY_ORDER: Record<PatternStat['severity'], number> = { warning: 0, info: 1, good: 2 }

export function summarize(analyses: MoveAnalysis[], selectedColor: Color): SummaryReport {
  const own = analyses.filter((a) => a.bySelected)
  const total = own.length
  const patterns: PatternStat[] = []
  for (const def of PATTERNS) {
    const examples: number[] = []
    for (const a of own) {
      if (a.findings.some((f) => def.match(f))) examples.push(a.ply)
    }
    if (examples.length) {
      patterns.push({
        id: def.id,
        label: def.label,
        description: def.description,
        severity: def.severity,
        count: examples.length,
        total,
        examples: examples.slice(0, 8),
      })
    }
  }
  patterns.sort((a, b) => {
    const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    return s !== 0 ? s : b.count - a.count
  })

  const topWarning = patterns.find((p) => p.severity === 'warning')
  const topGood = patterns.find((p) => p.severity === 'good')
  let headline: string
  if (topWarning) {
    headline = `Recurring theme to work on: ${topWarning.label.toLowerCase()} (${topWarning.count}× this game).`
  } else if (topGood) {
    headline = `Nice habit: ${topGood.label.toLowerCase()} (${topGood.count}× this game).`
  } else {
    headline = 'Balanced play — no single habit stands out strongly in this game.'
  }

  return { selectedColor, movesAnalyzed: total, patterns, headline }
}
