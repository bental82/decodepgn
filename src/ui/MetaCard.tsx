import { useMemo, useState } from 'react'
import { RULES_BY_ID } from '../shared/rules'
import AskBox from './AskBox'
import type { MetaGameSummary, MetaInsight, MetaReport } from '../shared/types'
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
  /** open a cited game at a specific move (from an insight's example link) */
  onOpenGame: (key: string, ply: number) => void
  /** digests of the analysed games — context for the Ask thread */
  summaries: MetaGameSummary[]
  apiKey: string
  onNeedKey: () => void
}

function InsightList({
  items,
  onOpenRule,
  onOpenGame,
}: {
  items: MetaInsight[]
  onOpenRule: (id: number) => void
  onOpenGame: (key: string, ply: number) => void
}) {
  return (
    <ul className="meta-list">
      {items.map((x, i) => (
        <li key={i}>
          <strong>{x.title}</strong> — <RuleText text={x.detail} onOpenRule={onOpenRule} />
          {x.ruleIds?.length || x.refs?.length ? (
            <span className="meta-rules">
              {(x.ruleIds ?? []).map((id) =>
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
              {(x.refs ?? []).map((r, j) => (
                <button
                  key={`g${j}`}
                  className="rule-ref game-ref"
                  title="Open this game at this move"
                  onClick={() => onOpenGame(r.key, r.ply)}
                >
                  ↗ {r.label}
                </button>
              ))}
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
const OPEN_KEY = 'decodepgn.metaOpen'

export default function MetaCard({
  report,
  loading,
  error,
  available,
  onGenerate,
  onOpenRule,
  onOpenGame,
  summaries,
  apiKey,
  onNeedKey,
}: Props) {
  // Collapsed state survives reloads (like the game-overview card).
  const [open, setOpen] = useState<boolean>(() => localStorage.getItem(OPEN_KEY) !== '0')
  const toggle = () =>
    setOpen((v) => {
      localStorage.setItem(OPEN_KEY, v ? '0' : '1')
      return !v
    })
  // Overall chess.com-style accuracy across the analysed games, weighted by
  // how many moves the engine actually checked in each.
  const acc = useMemo(() => {
    let weight = 0
    let sum = 0
    let games = 0
    for (const s of summaries) {
      const a = s.engine?.accuracy
      if (a == null) continue
      const w = Math.max(1, s.engine?.checked ?? 1)
      weight += w
      sum += a * w
      games++
    }
    return games ? { pct: Math.round((sum / weight) * 10) / 10, games } : null
  }, [summaries])
  return (
    <div className="meta-card card">
      <button className="collapse-head" onClick={toggle} aria-expanded={open}>
        <h2>Your play, across games</h2>
        <span className="collapse-chevron">{open ? '▾' : '▸'}</span>
      </button>
      {!open ? null : loading ? (
        <div className="loading-row">
          <span className="spinner" />
          Reading all your games… writing the full report takes a few minutes — leave this page
          open.
        </div>
      ) : (
        <>
          {acc ? (
            <p
              className="meta-acc"
              title="Engine accuracy over your analysed games, on the familiar chess.com-style 0–100% scale, weighted by how many moves were checked in each game."
            >
              Accuracy across games: <strong>{acc.pct}%</strong>{' '}
              <span className="muted small">
                (engine-checked, {acc.games} game{acc.games === 1 ? '' : 's'})
              </span>
            </p>
          ) : null}
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
                  <InsightList items={report.recurringMistakes} onOpenRule={onOpenRule} onOpenGame={onOpenGame} />
                </>
              )}
              {report.strengths.length > 0 && (
                <>
                  <h3>Strengths to keep</h3>
                  <InsightList items={report.strengths} onOpenRule={onOpenRule} onOpenGame={onOpenGame} />
                </>
              )}
              {report.trends?.length ? (
                <>
                  <h3>Trends — your recent games</h3>
                  <InsightList items={report.trends} onOpenRule={onOpenRule} onOpenGame={onOpenGame} />
                </>
              ) : null}
              {report.priorities.length > 0 && (
                <>
                  <h3>Work on next</h3>
                  <InsightList items={report.priorities} onOpenRule={onOpenRule} onOpenGame={onOpenGame} />
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
          {available > 0 ? (
            <AskBox
              context={{ summaries }}
              apiKey={apiKey}
              onNeedKey={onNeedKey}
              label="Ask about your play"
              placeholder="e.g. why do I keep losing material in the middlegame?"
              onOpenRule={onOpenRule}
            />
          ) : null}
        </>
      )}
    </div>
  )
}
