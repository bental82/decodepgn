import type { BoardProps } from './contract'
import { PIECE_GLYPH } from './contract'

interface SquareCell {
  square: string
  piece: { type: string; white: boolean } | null
}

export default function Board({ fen, orientation, lastMove, caption }: BoardProps) {
  const files = 'abcdefgh'
  const placement = fen.split(' ')[0]
  const rows = placement.split('/')

  const cells: SquareCell[] = []
  for (let r = 0; r < rows.length; r++) {
    const rank = 8 - r
    let fileIdx = 0
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '9') {
        const n = parseInt(ch, 10)
        for (let i = 0; i < n; i++) {
          const square = files[fileIdx] + rank
          cells.push({ square, piece: null })
          fileIdx++
        }
      } else {
        const square = files[fileIdx] + rank
        const white = ch === ch.toUpperCase()
        cells.push({ square, piece: { type: ch.toLowerCase(), white } })
        fileIdx++
      }
    }
  }

  const ordered = orientation === 'b' ? [...cells].reverse() : cells

  return (
    <div className="board-wrap">
      {caption && <div className="board-caption">{caption}</div>}
      <div className="board" role="img" aria-label={caption ?? 'chess position'}>
        {ordered.map(({ square, piece }) => {
          const fileIdx = 'abcdefgh'.indexOf(square[0])
          const rankIdx = parseInt(square[1], 10) - 1
          const dark = (fileIdx + rankIdx) % 2 === 0
          const hi = !!lastMove && (square === lastMove.from || square === lastMove.to)
          return (
            <div
              key={square}
              className={'sq ' + (dark ? 'dark' : 'light') + (hi ? ' hi' : '')}
            >
              {piece && (
                <span className={'piece ' + (piece.white ? 'white' : 'black')}>
                  {PIECE_GLYPH[piece.type]}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}