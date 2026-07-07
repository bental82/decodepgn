import RuleText from './RuleText'
import type { ParsedMove } from '../shared/types'

interface Props {
  text: string
  moves: ParsedMove[]
  /** jump the board to this ply */
  onJump: (ply: number) => void
  onOpenRule: (id: number) => void
}

// Move references the AI writes into prose: "12. Nf3", "12... Nf6", "8.O-O".
// A match only becomes a link when it resolves to a real move of THIS game
// (same move number, side and SAN) — anything else stays plain text.
const MOVE_RE =
  /(\d{1,3})(\.{3}|\.|…)\s?((?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8]|[a-h][1-8]|O-O(?:-O)?)(?:=[QRBN])?[+#]?)/g

const plain = (san: string) => san.replace(/[+#]/g, '')

/**
 * Prose with BOTH rule citations and clickable move references. Move refs jump
 * the board to that ply; everything between them still goes through RuleText.
 */
export default function MoveText({ text, moves, onJump, onOpenRule }: Props) {
  const nodes: React.ReactNode[] = []
  let last = 0
  const re = new RegExp(MOVE_RE)
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const num = parseInt(m[1], 10)
    const color = m[2] === '.' ? 'w' : 'b'
    const san = m[3]
    const target = moves.find(
      (mv) => mv.moveNumber === num && mv.color === color && plain(mv.san) === plain(san),
    )
    if (!target) continue // not a move of this game — leave the text untouched
    if (m.index > last) {
      nodes.push(<RuleText key={last} text={text.slice(last, m.index)} onOpenRule={onOpenRule} />)
    }
    const ply = target.ply
    nodes.push(
      <button
        key={`mv-${m.index}`}
        className="move-ref"
        onClick={() => onJump(ply)}
        title="Show this move on the board"
      >
        {m[0]}
      </button>,
    )
    last = m.index + m[0].length
  }
  if (nodes.length === 0) return <RuleText text={text} onOpenRule={onOpenRule} />
  if (last < text.length) {
    nodes.push(<RuleText key="tail" text={text.slice(last)} onOpenRule={onOpenRule} />)
  }
  return <>{nodes}</>
}
