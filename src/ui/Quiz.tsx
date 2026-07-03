import { Chess } from 'chess.js'
import { RULES_BY_ID, RULE_COUNT } from '../shared/rules'
import type { AnnoArrow, AnnoColor, BoardAnnotations } from '../shared/types'
import type { QuizProps } from './contract'
import Board from './Board'

/** Resolve a SAN move to an arrow on the given position (deterministic, no AI). */
function moveArrow(fen: string, san: string, color: AnnoColor): AnnoArrow | null {
  try {
    const mv = new Chess(fen).move(san, { strict: false })
    return mv ? { from: mv.from, to: mv.to, color } : null
  } catch {
    return null
  }
}

// Presentational quiz: the quiz itself (questions, answers, position) is owned
// by App and persisted with the game, so generation keeps running and nothing
// is lost when the user switches tabs mid-way.
export default function Quiz({
  moves,
  focus,
  saved,
  loading,
  error,
  onStart,
  onChange,
  onOpenRule,
  bestMoveReady,
}: QuizProps) {
  if (loading) {
    return (
      <div className="quiz">
        <div className="loading-row">
          <span className="spinner" />
          Building your quiz… (you can browse other tabs — it keeps working)
        </div>
      </div>
    )
  }

  if (error && !saved) {
    return (
      <div className="quiz">
        <div className="error">{error}</div>
        <button className="btn" onClick={() => onStart('rules')}>
          Try a rules quiz
        </button>{' '}
        <button className="btn" onClick={() => onStart('bestmove')} disabled={bestMoveReady < 3}>
          Try a best-move quiz
        </button>
      </div>
    )
  }

  if (!saved) {
    return (
      <div className="quiz quiz-intro">
        <h2>Quiz</h2>
        <p className="muted">
          Two ways to test yourself on this game — with instant feedback and a running score. It’s
          heuristic coaching, not a rating test.
        </p>
        <div className="quiz-kinds">
          <div className="quiz-kind">
            <h3>Rules quiz</h3>
            <p>Which of the {RULE_COUNT} rules of thumb did your moves follow — or break?</p>
            <button className="btn primary" onClick={() => onStart('rules')}>
              Start rules quiz
            </button>
          </div>
          <div className="quiz-kind">
            <h3>Best-move quiz</h3>
            <p>
              Positions from your own game: find the strongest move. Where your move wasn’t ideal,
              learn what was better — and why.
            </p>
            <button className="btn primary" onClick={() => onStart('bestmove')} disabled={bestMoveReady < 3}>
              Start best-move quiz
            </button>
            {bestMoveReady < 3 ? (
              <p className="muted small">Waiting for the move analysis — it feeds this quiz.</p>
            ) : null}
          </div>
        </div>
      </div>
    )
  }

  const { questions, answers, current } = saved
  const kind = saved.kind ?? 'rules'
  const total = questions.length
  const answeredCount = answers.filter((a) => a !== null).length
  const score = questions.reduce(
    (n, q, i) => (answers[i] !== null && q.options[answers[i] as number]?.correct ? n + 1 : n),
    0,
  )
  const q = questions[current]
  const chosen = answers[current]
  const done = answeredCount === total
  const refMove = q.ply !== undefined ? moves[q.ply] : undefined

  // Best-move questions carry the position to solve; orient it to the side to
  // move (the side being quizzed). After answering, show the correct move as a
  // green arrow — and the wrong pick, if any, in red.
  const solveSide = q.fen ? (q.fen.split(' ')[1] === 'b' ? 'b' : 'w') : undefined
  let solveAnnotations: BoardAnnotations | undefined
  if (q.fen && chosen !== null) {
    const correctSan = q.options.find((o) => o.correct)?.text
    const chosenSan = q.options[chosen]?.text
    const arrows: AnnoArrow[] = []
    if (chosenSan && chosenSan !== correctSan) {
      const a = moveArrow(q.fen, chosenSan, 'red')
      if (a) arrows.push(a)
    }
    if (correctSan) {
      const a = moveArrow(q.fen, correctSan, 'green')
      if (a) arrows.push(a)
    }
    if (arrows.length) solveAnnotations = { arrows }
  }

  const choose = (i: number) => {
    if (answers[current] !== null) return
    const next = [...answers]
    next[current] = i
    onChange({ ...saved, answers: next })
  }
  const goTo = (idx: number) => {
    onChange({ ...saved, current: Math.min(total - 1, Math.max(0, idx)) })
  }

  return (
    <div className="quiz">
      <div className="quiz-head">
        <span className="quiz-count">
          {kind === 'bestmove' ? 'Best move — question' : 'Question'} {current + 1} of {total}
        </span>
        <span className="quiz-score">
          Score {score}/{answeredCount}
        </span>
      </div>

      {q.fen ? (
        <div className="quiz-board">
          <Board
            fen={q.fen}
            orientation={solveSide ?? (focus === 'b' ? 'b' : 'w')}
            caption={`${solveSide === 'b' ? 'Black' : 'White'} to move — from your game`}
            annotations={solveAnnotations}
          />
        </div>
      ) : refMove ? (
        <div className="quiz-board">
          <Board
            fen={refMove.fenAfter}
            orientation={focus === 'b' ? 'b' : 'w'}
            lastMove={{ from: refMove.from, to: refMove.to }}
            caption={`After ${refMove.moveNumber}${refMove.color === 'w' ? '.' : '…'} ${refMove.san}`}
          />
        </div>
      ) : null}

      <p className="quiz-prompt">{q.prompt}</p>

      <div className="quiz-options">
        {q.options.map((o, i) => {
          const answered = chosen !== null
          const isChosen = chosen === i
          const cls = !answered ? '' : o.correct ? ' correct' : isChosen ? ' wrong' : ''
          return (
            <button
              key={i}
              className={'quiz-option' + cls}
              disabled={answered}
              onClick={() => choose(i)}
            >
              <span className="quiz-mark">
                {answered ? (o.correct ? '✓' : isChosen ? '✕' : '') : String.fromCharCode(65 + i)}
              </span>
              {o.text}
            </button>
          )
        })}
      </div>

      {chosen !== null ? (
        <div className={'quiz-feedback ' + (q.options[chosen]?.correct ? 'ok' : 'no')}>
          <strong>{q.options[chosen]?.correct ? 'Correct.' : 'Not quite.'}</strong> {q.explanation}
          {q.ruleId ? (
            <button className="rule-link" onClick={() => onOpenRule(q.ruleId as number)}>
              {' '}
              <span className="rule-num">#{q.ruleId}</span> {RULES_BY_ID[q.ruleId]?.title}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="quiz-nav">
        <button className="btn" disabled={current === 0} onClick={() => goTo(current - 1)}>
          ◀ Prev
        </button>
        {current < total - 1 ? (
          <button className="btn primary" onClick={() => goTo(current + 1)}>
            Next ▶
          </button>
        ) : (
          <button className="btn" onClick={() => onStart(kind)}>
            New quiz
          </button>
        )}
      </div>

      {done ? (
        <div className="quiz-final">
          Final score:{' '}
          <strong>
            {score} / {total}
          </strong>
          <div className="quiz-again">
            <button className="btn" onClick={() => onStart('rules')}>
              New rules quiz
            </button>
            <button className="btn" onClick={() => onStart('bestmove')} disabled={bestMoveReady < 3}>
              New best-move quiz
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
