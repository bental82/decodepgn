import { RULES_BY_ID, RULE_COUNT } from '../shared/rules'
import type { QuizProps } from './contract'
import Board from './Board'

// Presentational quiz: the quiz itself (questions, answers, position) is owned
// by App and persisted with the game, so generation keeps running and nothing
// is lost when the user switches tabs mid-way.
export default function Quiz({ moves, focus, saved, loading, error, onStart, onChange, onOpenRule }: QuizProps) {
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
        <button className="btn" onClick={onStart}>
          Try again
        </button>
      </div>
    )
  }

  if (!saved) {
    return (
      <div className="quiz quiz-intro">
        <h2>Quiz</h2>
        <p className="muted">
          Test yourself on the {RULE_COUNT} rules using this game — multiple-choice questions with
          instant feedback and a running score. It’s heuristic coaching, not a rating test.
        </p>
        <button className="btn primary big" onClick={onStart}>
          Start quiz
        </button>
      </div>
    )
  }

  const { questions, answers, current } = saved
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
          Question {current + 1} of {total}
        </span>
        <span className="quiz-score">
          Score {score}/{answeredCount}
        </span>
      </div>

      {refMove ? (
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
          <button className="btn" onClick={onStart}>
            New quiz
          </button>
        )}
      </div>

      {done ? (
        <div className="quiz-final">
          Final score: <strong>{score} / {total}</strong>
        </div>
      ) : null}
    </div>
  )
}
