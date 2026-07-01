import type { Color, MoveAnalysis } from '../engine/types'
import { aggregateStatus, statusMeta } from './format'

interface MoveListProps {
  moves: MoveAnalysis[]
  selectedPly: number
  selectedColor: Color
  onSelect: (ply: number) => void
}

function Cell({
  move,
  selectedPly,
  onSelect,
}: {
  move?: MoveAnalysis
  selectedPly: number
  onSelect: (ply: number) => void
}) {
  if (!move) return <span className="move-cell empty" />
  const status = move.bySelected ? aggregateStatus(move.findings) : null
  const meta = status ? statusMeta(status) : null
  return (
    <button
      className={`move-cell ${move.bySelected ? 'own' : 'other'} ${
        move.ply === selectedPly ? 'active' : ''
      }`}
      onClick={() => onSelect(move.ply)}
      title={move.bySelected ? 'Click for the strategic breakdown' : 'Opponent move'}
    >
      <span className="san">{move.san}</span>
      {meta && <span className={`dot ${meta.cls}`} aria-hidden />}
    </button>
  )
}

export default function MoveList({ moves, selectedPly, selectedColor, onSelect }: MoveListProps) {
  const rows: { n: number; white?: MoveAnalysis; black?: MoveAnalysis }[] = []
  for (const m of moves) {
    const n = m.moveNumber
    let row = rows.find((r) => r.n === n)
    if (!row) {
      row = { n }
      rows.push(row)
    }
    if (m.color === 'w') row.white = m
    else row.black = m
  }

  return (
    <div className="movelist">
      <div className="movelist-head">
        Moves — you are studying <strong>{selectedColor === 'w' ? 'White' : 'Black'}</strong>
      </div>
      <div className="movelist-body">
        {rows.map((row) => (
          <div className="move-row" key={row.n}>
            <span className="move-no">{row.n}.</span>
            <Cell move={row.white} selectedPly={selectedPly} onSelect={onSelect} />
            <Cell move={row.black} selectedPly={selectedPly} onSelect={onSelect} />
          </div>
        ))}
      </div>
    </div>
  )
}
