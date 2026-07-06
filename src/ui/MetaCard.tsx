import { RULES_BY_ID } from '../shared/rules'
import type { MetaInsight, MetaReport } from '../shared/types'
import RuleText from './RuleText'

export interface SavedMetaReport extends MetaReport {
  generatedAt: number
  gamesCount: number
}

interface Props {
  report: SavedMetaReport | null
  loading: boolean
  error: string | null
  /** how many analysed games are available to feed the report */
  available: number
  onGenerate: () => void
  onOpenRule: (id: number) => void
}

function InsightList({
  items,
  onOpenRule,
}: {
  items: MetaInsight[]
  onOpenRule: (id: number) => void
}) {
  return (
    <ul className="meta-list">
      {items.map((x, i) => (
        <li key={i}>
          <strong>{x.title}</strong> — <RuleText text={x.detail} onOpenRule={onOpenRule} />
          {x.ruleIds?.length ? (
            <span className="meta-rules">
              {x.ruleIds.map((id) =>
                RULES_BY_ID[id] ? (
                  <button
                    key={id}
                    className="rule-ref"
                    title={RULES_BY_ID[id].title}
                    onClick={() => onOpenRule(id)}
                  >
                    #{id}
                  </button>
                ) : null,
              )}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

// Cross-game coaching: openings, recurring mistakes, strengths and training
// priorities, generated from EVERY analysed game (this device + the cloud
// archive). Lives on the landing page.
export default function MetaCard({ report, loading, error, available, onGenerate, onOpenRule }: Props) {
  return (
    <div className="meta-card card">
      <h2>Your play, across games</h2>
      {loading ? (
        <div className="loading-row">
          <span className="spinner" />
          Reading all your games… (this looks at every analysed game)
        </div>
      ) : (
        <>
          {report ? (
            <div className="meta-report">
              <p className="meta-profile">
                <RuleText text={report.profile} onOpenRule={onOpenRule} />
              </p>
              <h3>Openings</h3>
              <p>
                <RuleText text={report.openings} onOpenRule={onOpenRule} />
              </p>
              {report.recurringMistakes.length > 0 && (
                <>
                  <h3>Recurring mistakes</h3>
                  <InsightList items={report.recurringMistakes} onOpenRule={onOpenRule} />
                </>
              )}
              {report.strengths.length > 0 && (
                <>
                  <h3>Strengths to keep</h3>
                  <InsightList items={report.strengths} onOpenRule={onOpenRule} />
                </>
              )}
              {report.priorities.length > 0 && (
                <>
                  <h3>Work on next</h3>
                  <InsightList items={report.priorities} onOpenRule={onOpenRule} />
                </>
              )}
              <p className="muted small">
                From {report.gamesCount} analysed game{report.gamesCount === 1 ? '' : 's'} ·{' '}
                {new Date(report.generatedAt).toLocaleDateString(undefined, {
                  day: 'numeric',
                  month: 'short',
                })}{' '}
                ·{' '}
                <button className="linkbtn" onClick={onGenerate}>
                  Regenerate
                </button>
              </p>
            </div>
          ) : (
            <>
              <p className="muted">
                A coach's view of your whole history: the openings you actually play, mistakes
                that repeat across games, your reliable strengths, and the three things to work
                on next.
              </p>
              <button className="btn primary" onClick={onGenerate} disabled={available < 2}>
                Analyse my play{available > 0 ? ` (${available} game${available === 1 ? '' : 's'})` : ''}
              </button>
              {available < 2 ? (
                <p className="muted small">Analyse at least two games first — patterns need repetition.</p>
              ) : null}
            </>
          )}
          {error ? <div className="error small">{error}</div> : null}
        </>
      )}
    </div>
  )
}
