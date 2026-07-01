import type { SummaryReport } from '../engine/types'

interface Props {
  summary: SummaryReport
  onJumpTo: (ply: number) => void
}

const SEVERITY_LABEL: Record<string, string> = {
  warning: 'Work on this',
  info: 'Worth noticing',
  good: 'Good habits',
}

export default function SummaryTab({ summary, onJumpTo }: Props) {
  const groups: Record<string, typeof summary.patterns> = { warning: [], info: [], good: [] }
  for (const p of summary.patterns) groups[p.severity].push(p)

  return (
    <div className="summary">
      <div className="summary-headline">
        <h2>Recurring patterns</h2>
        <p>{summary.headline}</p>
        <p className="muted">
          Based on {summary.movesAnalyzed} move{summary.movesAnalyzed === 1 ? '' : 's'} by{' '}
          {summary.selectedColor === 'w' ? 'White' : 'Black'}. These are heuristic tendencies, not a verdict —
          use them as prompts for what to study.
        </p>
      </div>

      {summary.patterns.length === 0 && (
        <p className="muted">Nothing stood out strongly. Play through the moves for the per-move breakdown.</p>
      )}

      {(['warning', 'info', 'good'] as const).map((sev) =>
        groups[sev].length ? (
          <div className="summary-group" key={sev}>
            <h3 className={`sev-${sev}`}>{SEVERITY_LABEL[sev]}</h3>
            {groups[sev].map((p) => (
              <div className="pattern" key={p.id}>
                <div className="pattern-top">
                  <span className="pattern-label">{p.label}</span>
                  <span className="pattern-count">
                    {p.count} / {p.total} moves
                  </span>
                </div>
                <p className="pattern-desc">{p.description}</p>
                <div className="pattern-examples">
                  {p.examples.map((ply) => (
                    <button key={ply} className="chip" onClick={() => onJumpTo(ply)}>
                      move {Math.floor(ply / 2) + 1}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null,
      )}
    </div>
  )
}
