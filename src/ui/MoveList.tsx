import type { ParsedMove } from '../shared/types'
import type { MoveListProps } from './contract'
import { colorName } from './contract'

interface CellProps {
  move: ParsedMove | undefined
  focus: MoveListProps['focus']
  selectedPly: number
  analyzed: Set<number>
  loading: Set<number>
  onSelect: (ply: number) => void
}

function Cell({ move, focus, selectedPly, analyzed, loading, onSelect }: CellProps) {
  if (!move) {
    return <span className="move-cell empty" />
  }

  const isFocus = move.color === focus
  let cls = 'move-cell'
  cls += isFocus ? ' own' : ' other'
  if (move.ply === selectedPly) cls += ' active'

  let dotCls = 'dot'
  if (loading.has(move.ply)) dotCls += ' loading'
  else if (analyzed.has(move.ply)) dotCls += ' analyzed'

  return (
    <button className={cls} onClick={() => onSelect(move.ply)} title={move.san}>
      <span className="san">{move.san}</span>
      {isFocus ? <span className={dotCls} /> : null}
    </button>
  )
}

export default function MoveList({
  moves,
  focus,
  selectedPly,
  analyzed,
  loading,
  onSelect,
}: MoveListProps) {
  const rows = new Map<number, { white?: ParsedMove; black?: ParsedMove }>()
  for (const move of moves) {
    let row = rows.get(move.moveNumber)
    if (!row) {
      row = {}
      rows.set(move.moveNumber, row)
    }
    if (move.color === 'w') row.white = move
    else row.black = move
  }

  const rowNumbers = Array.from(rows.keys()).sort((a, b) => a - b)

  return (
    <div className="movelist">
      <div className="movelist-head">
        Moves — studying <strong>{colorName(focus)}</strong>
      </div>
      <div className="movelist-body">
        {rowNumbers.map((n) => {
          const row = rows.get(n)!
          return (
            <div className="move-row" key={n}>
              <span className="move-no">{n}.</span>
              <Cell
                move={row.white}
                focus={focus}
                selectedPly={selectedPly}
                analyzed={analyzed}
                loading={loading}
                onSelect={onSelect}
              />
              <Cell
                move={row.black}
                focus={focus}
                selectedPly={selectedPly}
                analyzed={analyzed}
                loading={loading}
                onSelect={onSelect}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
