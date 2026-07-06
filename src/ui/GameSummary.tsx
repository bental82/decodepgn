import { useMemo } from 'react'
import { gameAccuracy } from '../shared/accuracy'
import { RULES_BY_ID } from '../shared/rules'
import type { Color, EngineEval, Soundness } from '../shared/types'
import { isStudied } from '../shared/types'
import type { GameSummaryProps } from './contract'
import { colorName } from './contract'

interface Tally {
  id: number
  n: number
}

function top3(rec: Record<number, number>): Tally[] {
  return Object.entries(rec)
    .map(([id, n]) => ({ id: Number(id), n }))
    .sort((a, b) => b.n - a.n || a.id - b.id)
    .slice(0, 3)
}

export default function GameSummary({ moves, focus, results, onPickRule }: GameSummaryProps) {
  const { broke, followed, sound, analysed } = useMemo(() => {
    const brokeRec: Record<number, number> = {}
    const followedRec: Record<number, number> = {}
    const soundCount: Record<Soundness, number> = { sound: 0, speculative: 0, dubious: 0 }
    let analysedN = 0
    for (const r of Object.values(results)) {
      analysedN++
      if (r.soundness) soundCount[r.soundness]++
      for (const h of r.rules) {
        if (h.status === 'violates') brokeRec[h.id] = (brokeRec[h.id] || 0) + 1
        else if (h.status === 'follows') followedRec[h.id] = (followedRec[h.id] || 0) + 1
      }
    }
    return { broke: top3(brokeRec), followed: top3(followedRec), sound: soundCount, analysed: analysedN }
  }, [results])

  // Chess.com-style accuracy % per side, from the engine-checked moves.
  const accuracy = useMemo(() => {
    const forSide = (c: Color) => {
      const evals: EngineEval[] = []
      for (const r of Object.values(results)) {
        if (r.engine && moves[r.ply]?.color === c) evals.push(r.engine)
      }
      return gameAccuracy(evals)
    }
    return { w: forSide('w'), b: forSide('b') }
  }, [results, moves])

  const totalFocus = moves.filter((m) => isStudied(m.color, focus)).length

  if (analysed === 0) {
    return (
      <div className="summary">
        <h2>Game takeaways</h2>
        <p className="muted">
          Analyse your moves (they analyse automatically after loading; see “Analyse remaining” if any were skipped) to see
          which principles you followed and broke most across the game.
        </p>
      </div>
    )
  }

  const renderList = (items: Tally[], empty: string) =>
    items.length === 0 ? (
      <p className="note small">{empty}</p>
    ) : (
      <ul className="summary-list">
        {items.map(({ id, n }) => (
          <li key={id}>
            <button className="rule-link" onClick={() => onPickRule(id)}>
              <span className="rule-num">#{id}</span> {RULES_BY_ID[id]?.title ?? 'Rule ' + id}
            </button>
            <span className="summary-count">
              ×{n} {n === 1 ? 'move' : 'moves'}
            </span>
          </li>
        ))}
      </ul>
    )

  return (
    <div className="summary">
      <h2>Game takeaways</h2>
      <p className="muted small">
        Based on {analysed} of {totalFocus} studied move(s) ({colorName(focus)}).
      </p>
      <div className="summary-cols">
        <div className="summary-col">
          <div className="summary-h broke">✕ Most-broken principles</div>
          {renderList(broke, 'No clear violations yet.')}
        </div>
        <div className="summary-col">
          <div className="summary-h followed">✓ Most-followed principles</div>
          {renderList(followed, 'Nothing stood out yet.')}
        </div>
      </div>
      <div className="summary-sound">
        <span className="summary-sound-label">Move soundness</span>
        <span className="badge snd-sound">● {sound.sound} sound</span>
        <span className="badge snd-spec">◆ {sound.speculative} speculative</span>
        <span className="badge snd-dubious">▲ {sound.dubious} dubious</span>
      </div>
      {accuracy.w != null || accuracy.b != null ? (
        <div
          className="summary-sound"
          title="Engine accuracy over the checked moves, on the familiar chess.com-style 0–100% scale — 100% means every move matched Stockfish's choice."
        >
          <span className="summary-sound-label">Accuracy</span>
          {accuracy.w != null ? (
            <span className="badge acc-badge">{focus === 'both' ? `White ${accuracy.w}` : accuracy.w}%</span>
          ) : null}
          {accuracy.b != null ? (
            <span className="badge acc-badge">{focus === 'both' ? `Black ${accuracy.b}` : accuracy.b}%</span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
