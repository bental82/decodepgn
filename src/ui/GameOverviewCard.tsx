import { useState } from 'react'
import type { GameOverview, ParsedMove } from '../shared/types'
import type { AskContext } from './contract'
import AskBox from './AskBox'
import Icon from './Icon'
import MoveText from './MoveText'

interface Props {
  overview: GameOverview | null
  loading: boolean
  /** the move-by-move analysis is still running; the overview follows it */
  waiting?: boolean
  /** live analysed/total counts for the waiting message */
  waitingProgress?: { done: number; total: number }
  /** something is actually analysing (or queued) — without it a waiting card
      shows the stalled call-to-action instead of a spinner going nowhere */
  runActive?: boolean
  /** unanalysed move count for the stalled call-to-action */
  remaining?: number
  /** start analysing the missing moves (the stalled call-to-action) */
  onAnalyse?: () => void
  error: string | null
  moves: ParsedMove[]
  onJump: (ply: number) => void
  onRetry: () => void
  /** chess.com-style engine accuracy per side, shown in the card header */
  accuracy?: Array<{ key: string; label: string; value: number }>
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
  waiting,
  waitingProgress,
  runActive,
  remaining,
  onAnalyse,
  error,
  moves,
  onJump,
  onRetry,
  accuracy,
  askKey,
  askContext,
  apiKey,
  onNeedKey,
  onOpenRule,
}: Props) {
  const [open, setOpen] = useState<boolean>(() => localStorage.getItem(OPEN_STORAGE) !== '0')
  if (!overview && !loading && !waiting && !error) return null

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
        {accuracy && accuracy.length > 0 ? (
          <span
            className="overview-acc"
            title="Engine accuracy over the checked moves, on the familiar chess.com-style 0–100% scale — 100% means every move matched Stockfish's choice."
          >
            {accuracy.map((a) => (
              <span key={a.key} className="badge acc-badge">
                {a.label} {a.value}%
              </span>
            ))}
          </span>
        ) : null}
        <span className="overview-chevron">
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        </span>
      </button>
      {!open ? null : waiting && !loading && !runActive ? (
        // Waiting on analysis that ISN'T running: a spinner here would spin
        // forever. Say what's missing and offer the one action that unsticks it.
        <>
          <div className="loading-row">
            {waitingProgress && waitingProgress.total > 0
              ? `${waitingProgress.done} of ${waitingProgress.total} moves analysed — the overview needs the rest.`
              : 'The moves are not analysed yet — the overview needs them first.'}
          </div>
          {onAnalyse ? (
            <button className="btn reanalyze" onClick={onAnalyse}>
              {remaining && remaining > 0 ? `Analyse remaining (${remaining})` : 'Analyse the game'}
            </button>
          ) : null}
        </>
      ) : loading || waiting ? (
        <div className="loading-row">
          <span className="spinner" />
          {loading
            ? 'Reading the whole game…'
            : `Analysing every move first${
                waitingProgress && waitingProgress.total > 0
                  ? ` (${waitingProgress.done}/${waitingProgress.total} done)`
                  : ''
              }…`}
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
            <MoveText text={overview.summary} moves={moves} onJump={onJump} onOpenRule={onOpenRule} />
          </p>
          {overview.trend ? (
            <p className="overview-trend">
              <MoveText text={overview.trend} moves={moves} onJump={onJump} onOpenRule={onOpenRule} />
            </p>
          ) : null}
          {overview.phases ? (
            <p className="overview-phases">
              <MoveText text={overview.phases} moves={moves} onJump={onJump} onOpenRule={onOpenRule} />
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
          <button
            className="linkbtn overview-regen"
            onClick={onRetry}
            title="Rewrite this overview from the latest analysis and engine data"
          >
            <Icon name="refresh" size={12} /> Regenerate this overview
          </button>
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
