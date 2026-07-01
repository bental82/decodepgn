import { useMemo } from 'react'
import { RULES_BY_ID } from '../shared/rules'
import type { Soundness } from '../shared/types'
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

  const totalFocus = moves.filter((m) => m.color === focus).length

  if (analysed === 0) {
    return (
      <div className="summary">
        <h2>Game takeaways</h2>
        <p className="muted">
          Analyse your moves (open them in Study, or use “Analyse all {colorName(focus)} moves”) to see
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
        Based on {analysed} of {totalFocus} {colorName(focus)} move(s) analysed.
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
    </div>
  )
}
