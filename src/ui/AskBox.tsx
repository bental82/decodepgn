import { useState } from 'react'
import { ask as fetchAsk } from '../lib/api'
import type { AskExchange } from '../shared/types'
import type { AskBoxProps } from './contract'
import Board from './Board'
import RuleText from './RuleText'

// A small "ask a question" thread. Answers are grounded in the rule set (and
// any context passed in — the current move/position or a specific rule), and
// follow-up questions continue the same conversation.
export default function AskBox({ context, apiKey, onNeedKey, placeholder, label, onOpenRule }: AskBoxProps) {
  const [q, setQ] = useState('')
  const [thread, setThread] = useState<AskExchange[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const question = q.trim()
    if (!question || loading) return
    setLoading(true)
    setError(null)
    try {
      const resp = await fetchAsk({
        mode: 'ask',
        question,
        // graphics stay client-side; the model only needs the words
        history: thread.map(({ q, a }) => ({ q, a })),
        ...context,
        apiKey: apiKey.trim() || undefined,
      })
      const exchange: AskExchange = { q: question, a: resp.answer }
      if (resp.graphics && context.fen) exchange.graphics = resp.graphics
      setThread((prev) => [...prev, exchange])
      setQ('')
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not get an answer.'
      setError(msg)
      if (/api key|401|authentication/i.test(msg)) onNeedKey()
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="askbox">
      <div className="ask-head">
        <span className="ask-label">{label ?? 'Ask a question'}</span>
        {thread.length > 0 && (
          <button className="linkbtn" onClick={() => setThread([])}>
            Clear thread
          </button>
        )}
      </div>

      {thread.length > 0 && (
        <div className="ask-thread">
          {thread.map((x, i) => (
            <div className="ask-exchange" key={i}>
              <p className="ask-q">{x.q}</p>
              <p className="ask-a">
                {onOpenRule ? <RuleText text={x.a} onOpenRule={onOpenRule} /> : x.a}
              </p>
              {x.graphics && context.fen ? (
                <div className="ask-board">
                  <Board
                    fen={context.fen}
                    orientation={context.focus === 'b' ? 'b' : 'w'}
                    annotations={x.graphics}
                  />
                </div>
              ) : null}
            </div>
          ))}
          <span className="ask-note">Heuristic coaching — not gospel.</span>
        </div>
      )}

      <div className="ask-row">
        <input
          className="ask-input"
          value={q}
          placeholder={
            thread.length
              ? 'Ask a follow-up…'
              : (placeholder ?? 'e.g. why is this move risky here?')
          }
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          maxLength={500}
          aria-label="Ask a chess question"
        />
        <button className="btn primary" onClick={submit} disabled={loading || !q.trim()}>
          {loading ? '…' : thread.length ? 'Follow up' : 'Ask'}
        </button>
      </div>
      {loading ? (
        <div className="loading-row">
          <span className="spinner" /> Thinking…
        </div>
      ) : null}
      {error ? <div className="error small">{error}</div> : null}
    </div>
  )
}
