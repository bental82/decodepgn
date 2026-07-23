import { useEffect, useRef } from 'react'
import { isStudied } from '../shared/types'
import type { Focus, MoveResult, ParsedMove } from '../shared/types'

interface Props {
  moves: ParsedMove[]
  results: Record<number, MoveResult>
  focus: Focus
  selectedPly: number
  onSelect: (ply: number) => void
}

/** Soundness dot for one move: the AI's verdict first, a heavy engine loss
    overrides it to red — same thresholds as the dubious-stepper. */
function dotClass(r?: MoveResult): string {
  if (!r) return ''
  if (r.soundness === 'dubious' || (r.engine?.cpLoss ?? 0) >= 150) return ' d-bad'
  if (r.soundness === 'speculative' || (r.engine?.cpLoss ?? 0) >= 60) return ' d-warn'
  return ' d-good'
}

// The game's score sheet: scan the whole game, see flagged moves at a glance,
// click any move to jump the board there. Lives in the board column; on phones
// it flows between the sticky board and the analysis panel.
export default function MoveList({ moves, results, focus, selectedPly, onSelect }: Props) {
  const activeRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  // Keep the current move visible while stepping — scroll ONLY the list's own
  // box. scrollIntoView would also scroll the window (the list sits below a
  // tall board), making the page jump under the sticky topbar on every step.
  useEffect(() => {
    const list = listRef.current
    const btn = activeRef.current
    if (!list || !btn) return
    const l = list.getBoundingClientRect()
    const b = btn.getBoundingClientRect()
    if (b.top < l.top || b.bottom > l.bottom) {
      list.scrollTop += b.top - l.top - l.height / 2
    }
  }, [selectedPly])

  // Pair by COLOUR, not by index: a game starting from a Black-to-move FEN
  // has no leading white move, and index-pairing would mislabel the column.
  const rows: Array<{ n: number; w?: ParsedMove; b?: ParsedMove }> = []
  for (const m of moves) {
    const last = rows[rows.length - 1]
    if (m.color === 'w') rows.push({ n: m.moveNumber, w: m })
    else if (last && last.n === m.moveNumber) last.b = m
    else rows.push({ n: m.moveNumber, b: m })
  }

  const cell = (m?: ParsedMove) => {
    if (!m) return <span className="ml-cell" />
    const cur = m.ply === selectedPly
    return (
      <button
        ref={cur ? activeRef : undefined}
        className={
          'ml-cell ml-move' +
          (cur ? ' cur' : '') +
          (isStudied(m.color, focus) ? '' : ' opp') +
          dotClass(results[m.ply])
        }
        aria-current={cur || undefined}
        title={m.san}
        onClick={() => onSelect(m.ply)}
      >
        {m.san}
      </button>
    )
  }

  return (
    <div className="movelist" role="navigation" aria-label="Game moves" ref={listRef}>
      {rows.map((r) => (
        <div className="ml-row" key={r.n}>
          <span className="ml-num">{r.n}.</span>
          {cell(r.w)}
          {cell(r.b)}
        </div>
      ))}
    </div>
  )
}
