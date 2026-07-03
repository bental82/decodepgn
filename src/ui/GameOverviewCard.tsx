import { useState } from 'react'
import type { GameOverview, ParsedMove } from '../shared/types'
import type { AskContext } from './contract'
import AskBox from './AskBox'
import RuleText from './RuleText'

interface Props {
  overview: GameOverview | null
  loading: boolean
  error: string | null
  moves: ParsedMove[]
  onJump: (ply: number) => void
  onRetry: () => void
  /** remount key for the Ask thread — changes when a different game loads */
  askKey: string
  askContext: AskContext
  apiKey: string
  onNeedKey: () => void
  onOpenRule: (id: number) => void
}

const OPEN_STORAGE = 'decodepgn.overviewOpen'

// The coach's opening word on the whole game: what decided it, the trend, and
// clickable key moments. Shown at the top of the Study tab; collapsible.
export default function GameOverviewCard({
  overview,
  loading,
  error,
  moves,
  onJump,
  onRetry,
  askKey,
  askContext,
  apiKey,
  onNeedKey,
  onOpenRule,
}: Props) {
  const [open, setOpen] = useState<boolean>(() => localStorage.getItem(OPEN_STORAGE) !== '0')
  if (!overview && !loading && !error) return null

  const toggle = () => {
    setOpen((v) => {
      localStorage.setItem(OPEN_STORAGE, v ? '0' : '1')
      return !v
    })
  }

  return (
    <div className="overview">
      <button className="overview-head" onClick={toggle} aria-expanded={open}>
        <span className="overview-label">Game overview</span>
        <span className="overview-chevron">{open ? '▾' : '▸'}</span>
      </button>
      {!open ? null : loading ? (
        <div className="loading-row">
          <span className="spinner" />
          Reading the whole game…
        </div>
      ) : error ? (
        <>
          <div className="error small">{error}</div>
          <button className="btn reanalyze" onClick={onRetry}>
            Try again
          </button>
        </>
      ) : overview ? (
        <>
          <p className="overview-summary">
            <RuleText text={overview.summary} onOpenRule={onOpenRule} />
          </p>
          {overview.trend ? (
            <p className="overview-trend">
              <RuleText text={overview.trend} onOpenRule={onOpenRule} />
            </p>
          ) : null}
          {overview.keyMoments.length > 0 ? (
            <div className="overview-moments">
              {overview.keyMoments.map((k) => {
                const m = moves[k.ply]
                const label = m ? `${m.moveNumber}${m.color === 'w' ? '.' : '…'} ${m.san}` : `ply ${k.ply}`
                return (
                  <button
                    key={k.ply}
                    className="moment"
                    onClick={() => onJump(k.ply)}
                    title={k.why}
                  >
                    <span className="moment-move">{label}</span>
                    <span className="moment-title">{k.title}</span>
                  </button>
                )
              })}
            </div>
          ) : null}
        </>
      ) : null}
      {/* Stays mounted while collapsed so the thread (and an in-flight
          question) survives closing and reopening the card. */}
      <div className="overview-ask" hidden={!open}>
        <AskBox
          key={askKey}
          context={askContext}
          apiKey={apiKey}
          onNeedKey={onNeedKey}
          label="Ask about the game"
          placeholder="e.g. where did I lose the thread?"
          onOpenRule={onOpenRule}
        />
      </div>
    </div>
  )
}
