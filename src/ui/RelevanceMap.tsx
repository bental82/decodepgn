import type { ParsedMove, MoveResult } from '../shared/types'
import type { RelevanceMapProps } from './contract'
import { statusMeta, colorName } from './contract'
import { RULES_BY_ID } from '../shared/rules'
import { isStudied } from '../shared/types'

export default function RelevanceMap({ moves, focus, results, onJump, onPickRule }: RelevanceMapProps) {
  const map: Record<number, { ply: number; status: MoveResult['rules'][number]['status'] }[]> = {}
  for (const r of Object.values(results)) {
    for (const hit of r.rules) {
      if (!map[hit.id]) map[hit.id] = []
      map[hit.id].push({ ply: r.ply, status: hit.status })
    }
  }

  const analysedCount = Object.keys(results).length
  const totalFocus = moves.filter((m) => isStudied(m.color, focus)).length

  const ruleIds = Object.keys(map).map(Number)
  ruleIds.sort((a, b) => {
    const diff = map[b].length - map[a].length
    if (diff !== 0) return diff
    return a - b
  })

  return (
    <div className="relmap">
      <h2>Where each rule came up</h2>
      <p className="muted">
        {analysedCount} of {totalFocus} studied moves analysed ({colorName(focus)}).
      </p>
      {ruleIds.length === 0 ? (
        <p className="empty">
          Analyse some moves to build this map — click your moves in the list, or use “Analyse all”.
        </p>
      ) : (
        ruleIds.map((id) => {
          const chips = [...map[id]].sort((a, b) => a.ply - b.ply)
          return (
            <div className="relrule" key={id}>
              <div className="relrule-head">
                <button className="relrule-title rule-link" onClick={() => onPickRule(id)}>
                  <span className="rule-num">#{id}</span> {RULES_BY_ID[id]?.title}
                </button>
                <span className="relcount">{chips.length} move(s)</span>
              </div>
              <div className="relmoves">
                {chips.map(({ ply, status }) => {
                  const m: ParsedMove | undefined = moves[ply]
                  const meta = statusMeta(status)
                  const label = m ? m.moveNumber + (m.color === 'w' ? '. ' : '… ') + m.san : 'ply ' + ply
                  return (
                    <button
                      className="chip"
                      key={ply}
                      onClick={() => onJump(ply)}
                      title={`${label} — ${meta.label}. Open on the board`}
                    >
                      <span className={'cdot ' + meta.cls} /> {label} <span className="chip-go">↗</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}