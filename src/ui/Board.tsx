import type { AnnoColor, BoardAnnotations } from '../shared/types'
import type { BoardProps, Orientation } from './contract'

interface SquareCell {
  square: string
  piece: { type: string; white: boolean } | null
}

const files = 'abcdefgh'
const ANNO_COLORS = new Set<string>(['green', 'red', 'yellow', 'blue'])

/** Centre of a square in the 8x8 SVG overlay space, respecting orientation. */
function squareCenter(sq: string, orientation: Orientation): { x: number; y: number } | null {
  const f = files.indexOf(sq[0])
  const r = parseInt(sq[1], 10)
  if (f < 0 || !(r >= 1 && r <= 8)) return null
  return orientation === 'b' ? { x: 7 - f + 0.5, y: r - 1 + 0.5 } : { x: f + 0.5, y: 8 - r + 0.5 }
}

/** Shaft + head geometry for one arrow; null when the squares are junk. */
function arrowShape(from: string, to: string, orientation: Orientation) {
  const p1 = squareCenter(from, orientation)
  const p2 = squareCenter(to, orientation)
  if (!p1 || !p2) return null
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  const len = Math.hypot(dx, dy)
  if (len < 0.5) return null
  const ux = dx / len
  const uy = dy / len
  const head = 0.38 // arrowhead length
  const halfW = 0.2 // arrowhead half-width
  const start = { x: p1.x + ux * 0.3, y: p1.y + uy * 0.3 } // keep the piece visible
  const base = { x: p2.x - ux * head, y: p2.y - uy * head }
  const px = -uy
  const py = ux
  return {
    line: { x1: start.x, y1: start.y, x2: base.x, y2: base.y },
    head: [
      `${p2.x},${p2.y}`,
      `${base.x + px * halfW},${base.y + py * halfW}`,
      `${base.x - px * halfW},${base.y - py * halfW}`,
    ].join(' '),
  }
}

/** color-by-square lookup, ignoring anything malformed (saved data is untrusted). */
function tintMap(annotations?: BoardAnnotations): Map<string, AnnoColor> {
  const m = new Map<string, AnnoColor>()
  for (const s of annotations?.squares ?? []) {
    if (s && typeof s.square === 'string' && ANNO_COLORS.has(s.color) && !m.has(s.square)) {
      m.set(s.square, s.color)
    }
  }
  return m
}

// Pieces are the classic cburnett SVG set. The sprite is inlined once by
// <PieceSprite>; here we reference each piece by its same-document id
// (#wk, #bq, …) via <use>, which gives crisp vector pieces at any size.
export default function Board({ fen, orientation, lastMove, caption, annotations }: BoardProps) {
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
  const tints = tintMap(annotations)
  const arrows = (annotations?.arrows ?? []).filter((a) => a && ANNO_COLORS.has(a.color))

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
          const tint = tints.get(square)
          // Coordinates only along the two outer edges, respecting orientation.
          const showRank = orientation === 'w' ? fileCh === 'a' : fileCh === 'h'
          const showFile = orientation === 'w' ? rankNum === 1 : rankNum === 8
          return (
            <div
              key={square}
              className={
                'sq ' + (dark ? 'dark' : 'light') + (hi ? ' hi' : '') + (tint ? ' anno-' + tint : '')
              }
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
        {arrows.length > 0 && (
          <svg className="board-arrows" viewBox="0 0 8 8" aria-hidden="true">
            {arrows.map((a, i) => {
              const shape = arrowShape(a.from, a.to, orientation)
              if (!shape) return null
              return (
                <g key={i} className={'ar-' + a.color}>
                  <line {...shape.line} />
                  <polygon points={shape.head} />
                </g>
              )
            })}
          </svg>
        )}
      </div>
    </div>
  )
}
