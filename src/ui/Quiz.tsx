import { useState } from 'react'
import { toGameMoves } from '../game'
import { quiz as fetchQuiz } from '../lib/api'
import { RULES_BY_ID } from '../shared/rules'
import type { QuizQuestion } from '../shared/types'
import type { QuizProps } from './contract'
import Board from './Board'

export default function Quiz({ moves, focus, apiKey, onNeedKey, onOpenRule }: QuizProps) {
  const [questions, setQuestions] = useState<QuizQuestion[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [current, setCurrent] = useState(0)
  const [answers, setAnswers] = useState<(number | null)[]>([])

  const start = async () => {
    setLoading(true)
    setError(null)
    // Drop any previous quiz up front: if the request fails we show the error
    // screen instead of silently re-rendering the stale quiz.
    setQuestions(null)
    setAnswers([])
    try {
      const resp = await fetchQuiz({
        mode: 'quiz',
        focus,
        game: toGameMoves(moves),
        apiKey: apiKey.trim() || undefined,
      })
      setQuestions(resp.questions)
      setAnswers(resp.questions.map(() => null))
      setCurrent(0)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not build the quiz.'
      setError(msg)
      if (/api key|401|authentication/i.test(msg)) onNeedKey()
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="quiz">
        <div className="loading-row">
          <span className="spinner" />
          Building your quiz…
        </div>
      </div>
    )
  }

  if (error && !questions) {
    return (
      <div className="quiz">
        <div className="error">{error}</div>
        <button className="btn" onClick={start}>
          Try again
        </button>
      </div>
    )
  }

  if (!questions) {
    return (
      <div className="quiz quiz-intro">
        <h2>Quiz</h2>
        <p className="muted">
          Test yourself on the 60 rules using this game — multiple-choice questions with instant
          feedback and a running score. It’s heuristic coaching, not a rating test.
        </p>
        <button className="btn primary big" onClick={start}>
          Start quiz
        </button>
      </div>
    )
  }

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
    setAnswers((prev) => {
      const c = [...prev]
      c[current] = i
      return c
    })
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
            orientation={focus}
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
        <button
          className="btn"
          disabled={current === 0}
          onClick={() => setCurrent((c) => Math.max(0, c - 1))}
        >
          ◀ Prev
        </button>
        {current < total - 1 ? (
          <button className="btn primary" onClick={() => setCurrent((c) => Math.min(total - 1, c + 1))}>
            Next ▶
          </button>
        ) : (
          <button className="btn" onClick={start}>
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
