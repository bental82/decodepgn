import type { ParsedMove, MoveResult } from '../shared/types'
import type { RelevanceMapProps } from './contract'
import { statusMeta, colorName } from './contract'
import { RULES_BY_ID } from '../shared/rules'
import { isStudied } from '../shared/types'

export default function RelevanceMap({
  moves,
  focus,
  results,
  onJump,
  onPickRule,
  onReanalyzeAll,
  reanalyzing,
}: RelevanceMapProps) {
  const map: Record<
    number,
    { ply: number; status: MoveResult['rules'][number]['status']; cpLoss?: number }[]
  > = {}
  for (const r of Object.values(results)) {
    for (const hit of r.rules) {
      if (!map[hit.id]) map[hit.id] = []
      map[hit.id].push({ ply: r.ply, status: hit.status, cpLoss: r.engine?.cpLoss })
    }
  }

  // Engine cost of breaking vs following a rule: total centipawn loss (per
  // Stockfish) across the moves where the rule got that status.
  const engImpact = (hits: { status: string; cpLoss?: number }[]) => {
    const agg = (statuses: string[]) => {
      const withEng = hits.filter((h) => statuses.includes(h.status) && h.cpLoss !== undefined)
      return withEng.length
        ? { n: withEng.length, cp: withEng.reduce((s, h) => s + (h.cpLoss ?? 0), 0) }
        : null
    }
    return { broke: agg(['violates']), followed: agg(['follows']) }
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
      {analysedCount > 0 &&
      !ruleIds.some((id) => map[id].some((h) => h.cpLoss !== undefined)) ? (
        <p className="note small">
          ⚙ No Stockfish data on these moves — they were analysed before the engine check was added
          (or the engine didn’t load).{' '}
          <button className="linkbtn" onClick={onReanalyzeAll} disabled={reanalyzing}>
            {reanalyzing ? 'Re-analysing…' : 'Re-analyse with the engine'}
          </button>
        </p>
      ) : null}
      {ruleIds.length === 0 ? (
        <p className="empty">
          Analyse some moves to build this map — click your moves in the list, or use “Analyse all”.
        </p>
      ) : (
        ruleIds.map((id) => {
          const chips = [...map[id]].sort((a, b) => a.ply - b.ply)
          const impact = engImpact(map[id])
          return (
            <div className="relrule" key={id}>
              <div className="relrule-head">
                <button className="relrule-title rule-link" onClick={() => onPickRule(id)}>
                  <span className="rule-num">#{id}</span> {RULES_BY_ID[id]?.title}
                </button>
                <span className="relcount">{chips.length} move(s)</span>
              </div>
              {impact.broke || impact.followed ? (
                <p className="rel-impact" title="Total centipawn loss (Stockfish) on the moves where this rule got that label">
                  ⚙{' '}
                  {impact.broke
                    ? `breaking it cost ${(impact.broke.cp / 100).toFixed(1)} pawns over ${impact.broke.n} move(s)`
                    : null}
                  {impact.broke && impact.followed ? ' · ' : null}
                  {impact.followed
                    ? `following it cost ${(impact.followed.cp / 100).toFixed(1)} over ${impact.followed.n}`
                    : null}
                </p>
              ) : null}
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