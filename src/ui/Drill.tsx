import { useEffect, useMemo, useRef, useState } from 'react'
import Board from './Board'
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
 * find-the-better-move puzzle, graded instantly, then re-explained with the
 * stored coaching. Wrong answers come back a few positions later; a position
 * is "mastered" after two consecutive correct answers — mastered ones drop to
 * the back of future rounds so the weak spots keep coming up first.
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

  // One round = every position, weak spots first; mastered ones at the back
  // as review. Queue is per-session state so wrong answers can be re-enqueued.
  const buildQueue = () => {
    const score = (it: DrillItem) =>
      Math.max(0, ...it.ruleIds.map((id) => ruleFreq.get(id) ?? 0)) * 1000 + (it.cpLoss ?? 0)
    const fresh = shuffle(playable.filter((it) => !mastered(it.key))).sort(
      (a, b) => score(b) - score(a),
    )
    const review = shuffle(playable.filter((it) => mastered(it.key)))
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

  // Options are fixed per queue position (not re-shuffled on re-render).
  const options = useMemo(() => {
    if (!item) return []
    const set = new Set<string>([item.best])
    const playedLegal = item.legal.find((m) => plain(m) === plain(item.played))
    if (playedLegal) set.add(playedLegal)
    const pool = item.legal.filter((m) => !set.has(m))
    while (set.size < 4 && pool.length) {
      set.add(pool.splice(Math.floor(Math.random() * pool.length), 1)[0])
    }
    return shuffle([...set])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.key, liveIdx])

  if (!playable.length) {
    return (
      <div className="drill">
        <div className="drill-head">
          <h2>Drill your mistakes</h2>
          <button className="btn" onClick={onExit}>
            ← Back
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
            ← Done
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
      // wrong: the same position comes back a few puzzles later
      setQueue((q) => {
        const nq = [...q]
        nq.splice(Math.min(liveIdx + 3, nq.length), 0, item.key)
        return nq
      })
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
          ← Done
        </button>
      </div>
      <p className="drill-source muted small">
        From {item.label}
        {recurring.length ? ' · a recurring pattern of yours' : ''}
      </p>
      <div className="drill-board">
        <Board fen={item.fen} orientation={item.color} />
      </div>
      <p className="drill-prompt">
        {item.color === 'w' ? 'White' : 'Black'} (you) to move — find the better move.
      </p>
      <div className="quiz-options">
        {options.map((opt) => (
          <button
            key={opt}
            className={
              'quiz-option' +
              (chosen !== null && opt === item.best ? ' correct' : '') +
              (chosen === opt && opt !== item.best ? ' wrong' : '')
            }
            disabled={chosen !== null}
            onClick={() => answer(opt)}
          >
            {opt}
          </button>
        ))}
      </div>
      {chosen !== null ? (
        <div className={'quiz-feedback ' + (isRight ? 'fb-good' : 'fb-bad')}>
          <p className="drill-verdict">
            {isRight ? '✓ Right — ' + item.best + ' was the move.' : `✗ Not quite — ${item.best} was the move.`}
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
              Next →
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
