import { RULES_BY_ID } from '../shared/rules'
import type { MoveAnalysisProps } from './contract'
import { soundnessMeta, statusMeta } from './contract'

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

  const snd = result.soundness ? soundnessMeta(result.soundness) : null
  const eng = result.engine

  return (
    <div className="analysis">
      {snd || eng ? (
        <div className="verdicts">
          {snd ? (
            <span className={'soundness ' + snd.cls} title={snd.desc}>
              <span className="snd-badge">
                {snd.icon} {snd.label} move
              </span>
              <span className="snd-hint">heuristic</span>
            </span>
          ) : null}
          {eng ? (
            <span
              className={
                'badge eng-badge ' +
                (eng.isBest || eng.cpLoss < 30
                  ? 'st-follows'
                  : eng.cpLoss >= 150
                    ? 'st-violates'
                    : eng.cpLoss >= 60
                      ? 'st-partial'
                      : 'st-relevant')
              }
              title={`Stockfish, depth ${eng.depth}. Eval after best play: ${(eng.evalBest / 100).toFixed(2)}; after the played move: ${(eng.evalPlayed / 100).toFixed(2)} (from the mover's side).`}
            >
              {eng.isBest
                ? '⚙ Engine’s top choice'
                : eng.cpLoss < 30
                  ? `⚙ Engine-approved (best: ${eng.bestSan})`
                  : `⚙ Engine prefers ${eng.bestSan} (−${(eng.cpLoss / 100).toFixed(1)})`}
            </span>
          ) : null}
        </div>
      ) : null}

      {result.lesson ? (
        <div className="lesson">
          <p>{result.lesson}</p>
        </div>
      ) : null}

      <div className="findings">
        <h3>Relevant rules of thumb</h3>
        {result.rules.length === 0 ? (
          <p className="note">No single rule stood out for this move.</p>
        ) : (
          [...result.rules]
            // most important first (server pre-sorts; this also covers older saved results)
            .sort((a, b) => (b.relevance ?? 3) - (a.relevance ?? 3))
            .map((hit) => {
              const meta = statusMeta(hit.status)
              return (
                <div className="finding" key={hit.id}>
                  <div className="finding-top">
                    <span className={'badge ' + meta.cls} title={meta.desc}>
                      {meta.icon} {meta.label}
                    </span>
                    <button className="rule-link" onClick={() => onOpenRule(hit.id)}>
                      <span className="rule-num">#{hit.id}</span>{' '}
                      {RULES_BY_ID[hit.id]?.title ?? 'Rule ' + hit.id}
                    </button>
                    {(hit.relevance ?? 0) >= 5 ? (
                      <span className="key-rule" title="The key idea of this move">
                        ★ key
                      </span>
                    ) : null}
                  </div>
                  <p className="why">{hit.why}</p>
                </div>
              )
            })
        )}
      </div>

      {result.alternative ? (
        <div className="alt">
          <span className="alt-label">Cleaner here</span>
          <p>
            <strong>{result.alternative.move}</strong> — {result.alternative.why}
          </p>
        </div>
      ) : null}

      <button className="btn ghost reanalyze" onClick={onReanalyze}>
        Re-analyse
      </button>
    </div>
  )
}
