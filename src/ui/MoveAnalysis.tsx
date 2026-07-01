import { RULES_BY_ID } from '../shared/rules'
import type { MoveAnalysisProps } from './contract'
import { statusMeta } from './contract'

export default function MoveAnalysis({
  result,
  loading,
  error,
  onReanalyze,
  onOpenRule,
}: MoveAnalysisProps) {
  if (error) {
    return (
      <div className="analysis">
        <div className="error">{error}</div>
        <button className="btn reanalyze" onClick={onReanalyze}>
          Try again
        </button>
      </div>
    )
  }

  if (loading && !result) {
    return (
      <div className="analysis">
        <div className="loading-row">
          <span className="spinner" />
          Asking Claude which rules apply…
        </div>
      </div>
    )
  }

  if (!result) return null

  return (
    <div className="analysis">
      {result.lesson ? (
        <div className="lesson">
          <span className="lesson-label">Lesson</span>
          <p>{result.lesson}</p>
        </div>
      ) : null}
      <div className="findings">
        <h3>Relevant rules of thumb</h3>
        {result.rules.length === 0 ? (
          <p className="note">No single rule stood out for this move.</p>
        ) : (
          result.rules.map((hit) => {
            const meta = statusMeta(hit.status)
            return (
              <div className="finding" key={hit.id}>
                <div className="finding-top">
                  <span className={'badge ' + meta.cls}>
                    {meta.icon} {meta.label}
                  </span>
                  <button className="rule-link" onClick={() => onOpenRule(hit.id)}>
                    <span className="rule-num">#{hit.id}</span>{' '}
                    {RULES_BY_ID[hit.id]?.title ?? 'Rule ' + hit.id}
                  </button>
                </div>
                <p className="why">{hit.why}</p>
              </div>
            )
          })
        )}
      </div>
      <button className="btn ghost reanalyze" onClick={onReanalyze}>
        Re-analyse
      </button>
    </div>
  )
}
