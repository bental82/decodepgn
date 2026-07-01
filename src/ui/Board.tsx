import type { BoardProps } from './contract'

interface SquareCell {
  square: string
  piece: { type: string; white: boolean } | null
}

// Pieces are the classic cburnett SVG set. The sprite is inlined once by
// <PieceSprite>; here we reference each piece by its same-document id
// (#wk, #bq, …) via <use>, which gives crisp vector pieces at any size.
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
          cells.push({ square: files[fileIdx] + rank, piece: null })
          fileIdx++
        }
      } else {
        const white = ch === ch.toUpperCase()
        cells.push({ square: files[fileIdx] + rank, piece: { type: ch.toLowerCase(), white } })
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
          const fileCh = square[0]
          const rankNum = parseInt(square[1], 10)
          const fileIdx = files.indexOf(fileCh)
          const dark = (fileIdx + rankNum - 1) % 2 === 0
          const hi = !!lastMove && (square === lastMove.from || square === lastMove.to)
          // Coordinates only along the two outer edges, respecting orientation.
          const showRank = orientation === 'w' ? fileCh === 'a' : fileCh === 'h'
          const showFile = orientation === 'w' ? rankNum === 1 : rankNum === 8
          return (
            <div
              key={square}
              className={'sq ' + (dark ? 'dark' : 'light') + (hi ? ' hi' : '')}
            >
              {showRank && <span className="coord rank">{rankNum}</span>}
              {showFile && <span className="coord file">{fileCh}</span>}
              {piece && (
                <svg className="piece" viewBox="0 0 40 40" aria-hidden="true">
                  <use href={`#${piece.white ? 'w' : 'b'}${piece.type}`} />
                </svg>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
