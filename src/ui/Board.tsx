import { PIECE_GLYPH } from './format'
import type { Color } from '../engine/types'

interface Cell {
  square: string
  piece: { type: string; white: boolean } | null
}

function parseFen(fen: string): Cell[][] {
  const placement = fen.split(' ')[0]
  const rows = placement.split('/')
  const files = 'abcdefgh'
  const board: Cell[][] = []
  for (let r = 0; r < 8; r++) {
    const rankNumber = 8 - r
    const cells: Cell[] = []
    let fileIdx = 0
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) {
        const n = parseInt(ch, 10)
        for (let i = 0; i < n; i++) {
          cells.push({ square: files[fileIdx] + rankNumber, piece: null })
          fileIdx++
        }
      } else {
        const white = ch === ch.toUpperCase()
        cells.push({
          square: files[fileIdx] + rankNumber,
          piece: { type: ch.toLowerCase(), white },
        })
        fileIdx++
      }
    }
    board.push(cells)
  }
  return board
}

interface BoardProps {
  fen: string
  orientation: Color
  highlight?: { from?: string; to?: string }
  caption?: string
}

export default function Board({ fen, orientation, highlight, caption }: BoardProps) {
  const rows = parseFen(fen)
  const flat = rows.flat()
  const ordered = orientation === 'w' ? flat : [...flat].reverse()

  return (
    <div className="board-wrap">
      {caption && <div className="board-caption">{caption}</div>}
      <div className="board" role="img" aria-label={caption ?? 'chess position'}>
        {ordered.map((cell) => {
          const fileIdx = 'abcdefgh'.indexOf(cell.square[0])
          const rankIdx = parseInt(cell.square[1], 10) - 1
          const dark = (fileIdx + rankIdx) % 2 === 0
          const isHi = highlight && (cell.square === highlight.from || cell.square === highlight.to)
          return (
            <div key={cell.square} className={`sq ${dark ? 'dark' : 'light'} ${isHi ? 'hi' : ''}`}>
              {cell.piece && (
                <span className={`piece ${cell.piece.white ? 'white' : 'black'}`}>
                  {PIECE_GLYPH[cell.piece.type]}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
