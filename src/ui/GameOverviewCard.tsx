import { useState } from 'react'
import type { GameOverview, ParsedMove } from '../shared/types'

interface Props {
  overview: GameOverview | null
  loading: boolean
  error: string | null
  moves: ParsedMove[]
  onJump: (ply: number) => void
  onRetry: () => void
}

const OPEN_STORAGE = 'decodepgn.overviewOpen'

// The coach's opening word on the whole game: what decided it, the trend, and
// clickable key moments. Shown at the top of the Study tab; collapsible.
export default function GameOverviewCard({ overview, loading, error, moves, onJump, onRetry }: Props) {
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
          <p className="overview-summary">{overview.summary}</p>
          {overview.trend ? <p className="overview-trend">{overview.trend}</p> : null}
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
    </div>
  )
}
