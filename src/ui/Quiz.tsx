import { useEffect, useMemo, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import Board from './Board'
import MoveText from './MoveText'
import type { BoardAnnotations } from '../shared/types'
import type { QuizProps } from './contract'
import type { QuizPosition } from '../lib/store'
import { winPct } from '../shared/accuracy'

// A try this close to the engine's best (in centipawns) also solves the
// position — several moves are often equally strong, and demanding the
// engine's exact pick would mark good chess as wrong.
const GOOD_ENOUGH_CP = 30

const plain = (san: string) => san.replace(/[+#]/g, '')
const pawns = (cp: number) => (cp / 100).toFixed(1)

/** Latest attempt's transient feedback (solved state lives in the save). */
interface Verdict {
  kind: 'game' | 'wrong' | 'unchecked'
  san: string
  cpLoss?: number
}

/**
 * Guess the move: the game's costliest engine-flagged moments, answered ON
 * THE BOARD. Wrong tries get unlimited retries (each graded by Stockfish), a
 * hint marks the piece to move, a reveal shows the answer — and every
 * finished position ends with concrete coaching: why the game move fell
 * short and what it cost, how the quiz tries fare, and why the best move
 * works.
 */
export default function Quiz({
  moves,
  results,
  saved,
  candidates,
  analysisPending,
  onStart,
  onChange,
  gradeMove,
  explain,
  onOpenRule,
  onJump,
}: QuizProps) {
  const [busy, setBusy] = useState(false) // an engine grade is running
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const [explainBusy, setExplainBusy] = useState(false)
  const [explainError, setExplainError] = useState<string | null>(null)
  const fetchingRef = useRef<Set<number>>(new Set())

  const pos = saved ? saved.positions[saved.current] : null
  const move = pos ? moves[pos.ply] : undefined
  const engine = pos ? results[pos.ply]?.engine : undefined
  const finished = !!pos && (pos.solved || pos.revealed)

  // Legal moves of the current puzzle position: powers tap/drag input and the
  // hint/reveal graphics.
  const verbose = useMemo(() => {
    if (!move) return []
    try {
      return new Chess(move.fenBefore).moves({ verbose: true }) as Array<{
        from: string
        to: string
        san: string
        promotion?: string
      }>
    } catch {
      return []
    }
  }, [move?.fenBefore]) // eslint-disable-line react-hooks/exhaustive-deps
  const targets = useMemo(() => {
    const t: Record<string, string[]> = {}
    for (const m of verbose) (t[m.from] ??= []).push(m.to)
    return t
  }, [verbose])
  // from->to picks the queen on promotions (underpromotion puzzles are not a thing here)
  const sanFor = (from: string, to: string): string | undefined => {
    const ms = verbose.filter((m) => m.from === from && m.to === to)
    return (ms.find((m) => !m.promotion || m.promotion === 'q') ?? ms[0])?.san
  }
  const squaresOf = (san: string) => {
    const m = verbose.find((v) => plain(v.san) === plain(san))
    return m ? { from: m.from, to: m.to } : null
  }

  const patchPos = (ply: number, patch: (p: QuizPosition) => QuizPosition) =>
    onChange((q) => ({
      ...q,
      positions: q.positions.map((p) => (p.ply === ply ? patch(p) : p)),
    }))

  const fetchExplain = async (p: QuizPosition) => {
    if (fetchingRef.current.has(p.ply)) return
    fetchingRef.current.add(p.ply)
    setExplainError(null)
    setExplainBusy(true)
    try {
      const ex = await explain(p)
      patchPos(p.ply, (q) => ({ ...q, explanation: ex }))
    } catch (e) {
      setExplainError(e instanceof Error ? e.message : 'Could not load the explanation.')
    } finally {
      setExplainBusy(false)
      fetchingRef.current.delete(p.ply)
    }
  }

  // A finished position without its coaching (fresh solve, reload, or an
  // earlier failure the user navigated away from) fetches it on sight.
  useEffect(() => {
    if (pos && finished && !pos.explanation && !explainError && !fetchingRef.current.has(pos.ply)) {
      void fetchExplain(pos)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos?.ply, finished, pos?.explanation])

  if (!saved) {
    const total = candidates.length
    const canStart = total > 0 && analysisPending === 0
    const hasEngine = Object.values(results).some((r) => r.engine)
    return (
      <div className="quiz quiz-intro">
        <h2>Guess the move</h2>
        <p className="muted">
          Your game's costliest moments, replayed: the board stops right before each mistake and
          you play what you think is the strongest move. Wrong tries get another go (Stockfish
          grades each one), a hint marks the piece to move, and every position ends with concrete
          coaching — what the game move cost, and why the best move works.
        </p>
        {analysisPending > 0 ? (
          <p className="muted small">
            Analysing your game — {analysisPending} move{analysisPending === 1 ? '' : 's'} to go.
            The quiz picks the costliest moments once the analysis is complete.
          </p>
        ) : total === 0 ? (
          <p className="muted small">
            {hasEngine
              ? 'No serious inaccuracies in the analysed moves — there is nothing to quiz here. Nice game.'
              : "The quiz builds on Stockfish's checks, and this game has none yet — re-run the analysis with the engine available."}
          </p>
        ) : null}
        <button className="btn primary" disabled={!canStart} onClick={onStart}>
          Start · {total || 'no'} position{total === 1 ? '' : 's'}
        </button>
      </div>
    )
  }

  const goTo = (idx: number) => {
    setVerdict(null)
    setExplainError(null)
    onChange((q) => ({ ...q, current: Math.min(q.positions.length - 1, Math.max(0, idx)) }))
  }

  // Chips: one per position. Unfinished ones stay unlabelled (the move itself
  // is the puzzle); finished ones show what the moment was.
  const chips = saved.positions.map((p, i) => {
    const m = moves[p.ply]
    const done = p.solved || p.revealed
    const label =
      done && m ? `${m.moveNumber}${m.color === 'w' ? '.' : '…'} ${m.san}` : `Position ${i + 1}`
    const icon = p.solved ? '✓ ' : p.revealed ? '◉ ' : ''
    return (
      <button
        key={p.ply}
        className={
          'quiz-chip' +
          (i === saved.current ? ' active' : '') +
          (p.solved ? ' ok' : p.revealed ? ' shown' : '')
        }
        onClick={() => goTo(i)}
      >
        {icon}
        {label}
      </button>
    )
  })

  // The analysis behind a saved quiz can be redone (force re-analysis) and no
  // longer carry this position — offer a fresh start instead of a dead board.
  if (!pos || !move || !engine) {
    return (
      <div className="quiz">
        <div className="quiz-chips">{chips}</div>
        <p className="muted">
          The analysis behind this quiz changed, so this position can't be graded any more. Start a
          fresh quiz from the current analysis.
        </p>
        <button className="btn primary" disabled={!candidates.length} onClick={onStart}>
          Start a fresh quiz
        </button>
      </div>
    )
  }

  const allDone = saved.positions.every((p) => p.solved || p.revealed)
  const firstTry = saved.positions.filter(
    (p) => p.solved && p.attempts.length === 0 && !p.hintUsed,
  ).length
  const moverName = move.color === 'w' ? 'White' : 'Black'

  const finish = (san: string, cpLoss: number) => {
    const next: QuizPosition = { ...pos, solved: true, solution: { san, cpLoss } }
    patchPos(pos.ply, () => next)
    setVerdict(null)
    void fetchExplain(next)
  }

  const attempt = async (from: string, to: string) => {
    if (busy || finished) return
    const san = sanFor(from, to)
    if (!san) return
    setVerdict(null)
    if (plain(san) === plain(engine.bestSan)) {
      finish(san, 0)
      return
    }
    if (plain(san) === plain(move.san)) {
      // the very move from the game — the one this quiz exists to improve on
      patchPos(pos.ply, (p) => ({
        ...p,
        attempts: [...p.attempts, { san, cpLoss: engine.cpLoss, isGameMove: true }],
      }))
      setVerdict({ kind: 'game', san, cpLoss: engine.cpLoss })
      return
    }
    setBusy(true)
    let cp: number | null = null
    try {
      cp = await gradeMove(move.fenBefore, san)
    } finally {
      setBusy(false)
    }
    const cpLoss = cp === null ? undefined : Math.max(0, engine.evalBest - cp)
    if (cpLoss !== undefined && cpLoss <= GOOD_ENOUGH_CP) {
      finish(san, cpLoss)
      return
    }
    patchPos(pos.ply, (p) => ({
      ...p,
      attempts: [...p.attempts, { san, ...(cpLoss !== undefined ? { cpLoss } : {}) }],
    }))
    setVerdict({ kind: cpLoss === undefined ? 'unchecked' : 'wrong', san, cpLoss })
  }

  const useHint = () => patchPos(pos.ply, (p) => ({ ...p, hintUsed: true }))
  const reveal = () => {
    const next: QuizPosition = { ...pos, revealed: true }
    patchPos(pos.ply, () => next)
    setVerdict(null)
    void fetchExplain(next)
  }

  // Board graphics: the hint tints the best move's from-square; a finished
  // position tells the whole story in arrows — green the answer, red the game
  // move, blue the player's equally-strong solution when it differs.
  let annotations: BoardAnnotations | undefined
  if (finished) {
    const arrows: NonNullable<BoardAnnotations['arrows']> = []
    const best = squaresOf(engine.bestSan)
    if (best) arrows.push({ from: best.from, to: best.to, color: 'green' })
    if (plain(move.san) !== plain(engine.bestSan)) {
      arrows.push({ from: move.from, to: move.to, color: 'red' })
    }
    const sol = pos.solution
    if (sol && plain(sol.san) !== plain(engine.bestSan)) {
      const s = squaresOf(sol.san)
      if (s) arrows.push({ from: s.from, to: s.to, color: 'blue' })
    }
    if (arrows.length) annotations = { arrows }
  } else if (pos.hintUsed) {
    const best = squaresOf(engine.bestSan)
    if (best) annotations = { squares: [{ square: best.from, color: 'yellow' }] }
  }

  // Winning-chances context, from the stored engine numbers (mover's view).
  const chancesBest = Math.round(winPct(engine.evalBest))
  const chancesPlayed = Math.round(winPct(engine.evalPlayed))

  const ex = pos.explanation
  const solvedFirstTry = pos.solved && pos.attempts.length === 0 && !pos.hintUsed

  return (
    <div className="quiz">
      <div className="quiz-head">
        <span className="quiz-count">
          Position {saved.current + 1} of {saved.positions.length}
        </span>
        <span className="quiz-score">{firstTry} first-try</span>
      </div>
      <div className="quiz-chips">{chips}</div>

      <div className="quiz-board">
        <Board
          fen={move.fenBefore}
          orientation={move.color}
          annotations={annotations}
          caption={
            finished
              ? `Move ${move.moveNumber}${move.color === 'w' ? '.' : '…'} — the moment from your game`
              : `${moverName} to move — from your game`
          }
          interact={
            !finished && !busy
              ? {
                  color: move.color,
                  targets,
                  onMove: (from, to) => void attempt(from, to),
                }
              : undefined
          }
        />
      </div>

      {!finished ? (
        <>
          <p className="quiz-prompt">
            {moverName} to move — this moment cost ≈{pawns(engine.cpLoss)} pawns in the game. Find
            the strongest move.{' '}
            <span className="muted small">
              Tap a piece to see its moves, then tap the target — or drag it there.
            </span>
          </p>
          {busy ? (
            <div className="loading-row">
              <span className="spinner" />
              Checking your move with Stockfish…
            </div>
          ) : verdict ? (
            <div className="quiz-feedback fb-bad">
              {verdict.kind === 'game' ? (
                <p>
                  <strong>{verdict.san}</strong> — that's exactly what you played in the game, and
                  it's the move that cost ≈{pawns(verdict.cpLoss ?? 0)} pawns. There's something
                  stronger here — try again.
                </p>
              ) : verdict.kind === 'wrong' ? (
                <p>
                  <strong>{verdict.san}</strong> isn't it either — Stockfish puts it ≈
                  {pawns(verdict.cpLoss ?? 0)} pawns below the best move. Try again.
                </p>
              ) : (
                <p>
                  <strong>{verdict.san}</strong> isn't the engine's choice here (it couldn't be
                  graded precisely just now). Try again.
                </p>
              )}
            </div>
          ) : null}
          <div className="quiz-tools">
            {!pos.hintUsed ? (
              <button className="btn ghost" onClick={useHint}>
                Hint
              </button>
            ) : null}
            <button className="btn ghost" onClick={reveal}>
              Reveal the answer
            </button>
          </div>
        </>
      ) : (
        <div className="quiz-explain">
          <div className={'quiz-feedback ' + (pos.solved ? 'fb-good' : 'fb-neutral')}>
            <p className="quiz-outcome">
              {pos.solved && pos.solution ? (
                plain(pos.solution.san) === plain(engine.bestSan) ? (
                  <>
                    ✓ <strong>{pos.solution.san}</strong> — the engine's own choice
                    {solvedFirstTry
                      ? ', found first try.'
                      : pos.attempts.length
                        ? ` (after ${pos.attempts.length} tr${pos.attempts.length === 1 ? 'y' : 'ies'}).`
                        : '.'}
                  </>
                ) : (
                  <>
                    ✓ <strong>{pos.solution.san}</strong> — just as strong as the engine's{' '}
                    {engine.bestSan}.
                  </>
                )
              ) : (
                <>
                  ◉ The answer: <strong>{engine.bestSan}</strong>.
                </>
              )}
            </p>
          </div>

          <div className="quiz-numbers">
            <p>
              In the game you played <strong>{move.san}</strong> — it gave up ≈
              {pawns(engine.cpLoss)} pawns, dropping your winning chances from about{' '}
              {chancesBest}% to {chancesPlayed}%.
            </p>
            {pos.attempts.filter((a) => !a.isGameMove).length ? (
              <ul className="quiz-tries">
                {pos.attempts
                  .filter((a) => !a.isGameMove)
                  .map((a, i) => (
                    <li key={i}>
                      {a.san} —{' '}
                      {a.cpLoss !== undefined
                        ? `≈${pawns(a.cpLoss)} pawns below best`
                        : 'not graded'}
                    </li>
                  ))}
              </ul>
            ) : null}
          </div>

          {ex ? (
            <div className="quiz-coaching">
              <p>
                <MoveText text={ex.whyPlayed} moves={moves} onJump={onJump} onOpenRule={onOpenRule} />
              </p>
              {ex.attemptNotes?.length ? (
                <ul className="quiz-tries">
                  {ex.attemptNotes.map((n, i) => (
                    <li key={i}>
                      <strong>{n.san}</strong>:{' '}
                      <MoveText text={n.note} moves={moves} onJump={onJump} onOpenRule={onOpenRule} />
                    </li>
                  ))}
                </ul>
              ) : null}
              <p>
                <MoveText text={ex.whyBest} moves={moves} onJump={onJump} onOpenRule={onOpenRule} />
              </p>
            </div>
          ) : explainBusy ? (
            <div className="loading-row">
              <span className="spinner" />
              Writing the coaching for this moment…
            </div>
          ) : explainError ? (
            <>
              <div className="error small">{explainError}</div>
              <button className="btn" onClick={() => void fetchExplain(pos)}>
                Try the explanation again
              </button>
            </>
          ) : null}

          <div className="quiz-nav">
            <button className="btn ghost" onClick={() => onJump(pos.ply)}>
              Open this moment in the game
            </button>
            {saved.current < saved.positions.length - 1 ? (
              <button className="btn primary" onClick={() => goTo(saved.current + 1)}>
                Next position →
              </button>
            ) : null}
          </div>
        </div>
      )}

      {allDone ? (
        <div className="quiz-final">
          <p>
            Round complete: <strong>{firstTry}</strong> of{' '}
            <strong>{saved.positions.length}</strong> found first try
            {saved.positions.some((p) => p.revealed)
              ? ` · ${saved.positions.filter((p) => p.revealed).length} revealed`
              : ''}
            .
          </p>
          <button className="btn" disabled={!candidates.length} onClick={onStart}>
            Restart from scratch
          </button>
        </div>
      ) : null}
    </div>
  )
}
