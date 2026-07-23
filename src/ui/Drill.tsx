import { useEffect, useMemo, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import Board from './Board'
import Icon from './Icon'
import type { BoardAnnotations } from '../shared/types'
import RuleText from './RuleText'
import { RULES_BY_ID } from '../shared/rules'
import type { Color } from '../shared/types'

/** One mistake position mined from the saved analyses (built in App). */
export interface DrillItem {
  key: string // gameKey:ply — stable identity for progress tracking
  gameKey: string
  ply: number
  fen: string // the position BEFORE the mistake — the puzzle to solve
  color: Color // side to move (the user)
  played: string // what was actually played in the game
  best: string // the better move (canonical SAN, validated legal in fen)
  legal: string[] // all legal moves in fen (distractor pool)
  cpLoss?: number
  ruleIds: number[] // rules the played move violated (recurring-pattern signal)
  lesson: string
  why?: string // the AI's one-line reason for the better move
  label: string // "Ben vs Alice · move 12"
}

interface Props {
  items: DrillItem[]
  onOpenRule: (id: number) => void
  onOpenGame: (gameKey: string, ply: number) => void
  onExit: () => void
}

interface ItemStats {
  seen: number
  correct: number
  streak: number
  lastAt: number
}

const STATS_KEY = 'decodepgn.drill.v1'
const MASTERY_STREAK = 2

function loadStats(): Record<string, ItemStats> {
  try {
    const raw = JSON.parse(localStorage.getItem(STATS_KEY) || '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

const plain = (san: string) => san.replace(/[+#]/g, '')

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * Targeted practice on the player's own mistakes: each position is shown as a
 * find-the-better-move puzzle answered ON THE BOARD (tap or drag), graded
 * instantly, then re-explained with the stored coaching. A correct answer
 * removes the position from the round's queue; a wrong one sends it to the
 * END of the queue, so the round only finishes once everything was answered
 * correctly. Positions are ordered by how often their KIND of mistake
 * (violated rule) recurs across the player's games — typical patterns first.
 */
export default function Drill({ items, onOpenRule, onOpenGame, onExit }: Props) {
  const [stats, setStats] = useState<Record<string, ItemStats>>(loadStats)
  const statsRef = useRef(stats)
  statsRef.current = stats
  useEffect(() => {
    try {
      localStorage.setItem(STATS_KEY, JSON.stringify(stats))
    } catch {
      /* best-effort */
    }
  }, [stats])

  // Items arrive pre-validated from App (best is legal, canonical SAN).
  const playable = items

  // How often each violated rule appears across ALL positions — items hitting
  // a recurring rule are the "typical pattern" and drill first.
  const ruleFreq = useMemo(() => {
    const f = new Map<number, number>()
    for (const it of playable) for (const id of it.ruleIds) f.set(id, (f.get(id) ?? 0) + 1)
    return f
  }, [playable])

  const mastered = (key: string) => (statsRef.current[key]?.streak ?? 0) >= MASTERY_STREAK

  // One round = every position, sorted by how often its KIND of mistake
  // (most-frequent violated rule) recurs across all positions, then by the
  // engine cost; already-mastered ones go to the back as review.
  const buildQueue = () => {
    const score = (it: DrillItem) =>
      Math.max(0, ...it.ruleIds.map((id) => ruleFreq.get(id) ?? 0)) * 1000 + (it.cpLoss ?? 0)
    const fresh = shuffle(playable.filter((it) => !mastered(it.key))).sort(
      (a, b) => score(b) - score(a),
    )
    const review = shuffle(playable.filter((it) => mastered(it.key))).sort(
      (a, b) => score(b) - score(a),
    )
    return [...fresh, ...review].map((it) => it.key)
  }
  const [queue, setQueue] = useState<string[]>(buildQueue)
  const [idx, setIdx] = useState(0)
  const [chosen, setChosen] = useState<string | null>(null)
  const [firstTry, setFirstTry] = useState({ right: 0, total: 0 })
  // keys already answered this round — retries of a missed position must not
  // count towards the "X of Y first-try" score again
  const attemptedRef = useRef<Set<string>>(new Set())
  const byKey = useMemo(() => new Map(playable.map((it) => [it.key, it])), [playable])

  // Background re-analysis can remove a queued position mid-round (it is no
  // longer a mistake) — skip past dead keys instead of ending the round early.
  let liveIdx = idx
  while (liveIdx < queue.length && !byKey.get(queue[liveIdx])) liveIdx++
  const item = liveIdx < queue.length ? byKey.get(queue[liveIdx]) : undefined

  // Verbose legal moves for the current puzzle: powers tap/drag input
  // (from->to squares) and the reveal arrows.
  const verbose = useMemo(() => {
    if (!item) return []
    try {
      return new Chess(item.fen).moves({ verbose: true }) as Array<{
        from: string
        to: string
        san: string
        promotion?: string
      }>
    } catch {
      return []
    }
  }, [item?.key]) // eslint-disable-line react-hooks/exhaustive-deps
  const targets = useMemo(() => {
    const t: Record<string, string[]> = {}
    for (const m of verbose) (t[m.from] ??= []).push(m.to)
    return t
  }, [verbose])
  // from->to picks the queen on promotions (underpromotion drills are not a thing here)
  const sanFor = (from: string, to: string): string | undefined => {
    const ms = verbose.filter((m) => m.from === from && m.to === to)
    return (ms.find((m) => !m.promotion || m.promotion === 'q') ?? ms[0])?.san
  }
  const squaresOf = (san: string) => {
    const m = verbose.find((v) => plain(v.san) === plain(san))
    return m ? { from: m.from, to: m.to } : null
  }

  if (!playable.length) {
    return (
      <div className="drill">
        <div className="drill-head">
          <h2>Drill your mistakes</h2>
          <button className="btn" onClick={onExit}>
            <Icon name="back" size={13} /> Back
          </button>
        </div>
        <p className="muted">
          No drillable positions yet. Analyse a few games — every move the analysis flags as
          dubious (or where the engine found a clearly better move) becomes a practice position
          here.
        </p>
      </div>
    )
  }

  if (!item) {
    const masteredCount = playable.filter((it) => mastered(it.key)).length
    return (
      <div className="drill">
        <div className="drill-head">
          <h2>Round complete</h2>
          <button className="btn" onClick={onExit}>
            <Icon name="back" size={13} /> Done
          </button>
        </div>
        <p className="drill-summary">
          {firstTry.right} of {firstTry.total} first-try · {masteredCount} of {playable.length}{' '}
          positions mastered.
        </p>
        <p className="muted small">
          Mastered = answered correctly twice in a row. Unmastered positions come up first every
          round, so your weak spots keep getting drilled until they stick.
        </p>
        <button
          className="btn primary"
          onClick={() => {
            setQueue(buildQueue())
            setIdx(0)
            setChosen(null)
            setFirstTry({ right: 0, total: 0 })
            attemptedRef.current = new Set()
          }}
        >
          Run another round
        </button>
      </div>
    )
  }

  const isRight = chosen !== null && chosen === item.best
  const violated = item.ruleIds.filter((id) => RULES_BY_ID[id])
  const recurring = violated.filter((id) => (ruleFreq.get(id) ?? 0) >= 2)

  // After answering, show the story on the board: green = the better move,
  // red = what was played in the game, yellow = a wrong pick (when distinct).
  let revealGfx: BoardAnnotations | undefined
  if (chosen !== null) {
    const arrows: NonNullable<BoardAnnotations['arrows']> = []
    const best = squaresOf(item.best)
    if (best) arrows.push({ from: best.from, to: best.to, color: 'green' })
    const played = squaresOf(item.played)
    if (played && plain(item.played) !== plain(item.best)) {
      arrows.push({ from: played.from, to: played.to, color: 'red' })
    }
    if (!isRight && plain(chosen) !== plain(item.played)) {
      const picked = squaresOf(chosen)
      if (picked) arrows.push({ from: picked.from, to: picked.to, color: 'yellow' })
    }
    if (arrows.length) revealGfx = { arrows }
  }

  const answer = (opt: string) => {
    if (chosen !== null) return
    setChosen(opt)
    const right = opt === item.best
    if (!attemptedRef.current.has(item.key)) {
      attemptedRef.current.add(item.key)
      setFirstTry((s) => ({ right: s.right + (right ? 1 : 0), total: s.total + 1 }))
    }
    setStats((prev) => {
      const cur = prev[item.key] ?? { seen: 0, correct: 0, streak: 0, lastAt: 0 }
      return {
        ...prev,
        [item.key]: {
          seen: cur.seen + 1,
          correct: cur.correct + (right ? 1 : 0),
          streak: right ? cur.streak + 1 : 0,
          lastAt: Date.now(),
        },
      }
    })
  }

  const next = () => {
    if (chosen !== null && chosen !== item.best) {
      // wrong: the position goes to the END of the queue — the round only
      // completes once every position has been answered correctly
      setQueue((q) => [...q, item.key])
    }
    setChosen(null)
    setIdx(liveIdx + 1)
  }

  return (
    <div className="drill">
      <div className="drill-head">
        <h2>Drill your mistakes</h2>
        <span className="muted small drill-progress">
          {Math.min(liveIdx + 1, queue.length)} / {queue.length}
        </span>
        <button className="btn" onClick={onExit}>
          <Icon name="back" size={13} /> Done
        </button>
      </div>
      <p className="drill-source muted small">
        From {item.label}
        {recurring.length ? ' · a recurring pattern of yours' : ''}
      </p>
      <div className="drill-board">
        <Board
          fen={item.fen}
          orientation={item.color}
          annotations={revealGfx}
          interact={
            chosen === null
              ? {
                  color: item.color,
                  targets,
                  onMove: (from, to) => {
                    const san = sanFor(from, to)
                    if (san) answer(san)
                  },
                }
              : undefined
          }
        />
      </div>
      <p className="drill-prompt">
        {item.color === 'w' ? 'White' : 'Black'} (you) to move — play the better move.{' '}
        <span className="muted small">Tap a piece to see its moves, then tap the target — or drag it there.</span>
      </p>
      {chosen !== null ? (
        <div className={'quiz-feedback ' + (isRight ? 'fb-good' : 'fb-bad')}>
          <p className="drill-verdict">
            {isRight
              ? '✓ Right — ' + item.best + ' was the move.'
              : `✗ Not quite — you chose ${chosen}; ${item.best} was the move.`}
          </p>
          <p className="muted small">
            In the game you played <strong>{item.played}</strong>
            {typeof item.cpLoss === 'number' && item.cpLoss > 0
              ? ` (cost ≈ ${(item.cpLoss / 100).toFixed(1)} pawns)`
              : ''}
            .
          </p>
          {item.why ? (
            <p>
              <RuleText text={item.why} onOpenRule={onOpenRule} />
            </p>
          ) : null}
          {item.lesson ? (
            <p>
              <RuleText text={item.lesson} onOpenRule={onOpenRule} />
            </p>
          ) : null}
          {violated.length ? (
            <p className="drill-rules">
              {recurring.length ? 'Recurring rule' + (recurring.length > 1 ? 's' : '') + ' for you: ' : 'Rules involved: '}
              {(recurring.length ? recurring : violated).map((id) => (
                <button key={id} className="rule-ref" title={RULES_BY_ID[id].title} onClick={() => onOpenRule(id)}>
                  #{id} {RULES_BY_ID[id].title}
                </button>
              ))}
            </p>
          ) : null}
          <div className="drill-actions">
            <button className="btn ghost" onClick={() => onOpenGame(item.gameKey, item.ply)}>
              Open this moment in the game
            </button>
            <button className="btn primary" onClick={next}>
              Next <Icon name="next" size={14} />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
