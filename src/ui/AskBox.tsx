import { useState } from 'react'
import { ask as fetchAsk } from '../lib/api'
import type { AskBoxProps } from './contract'

// A small "ask a free-form question" box. Answers are grounded in the rule set
// (and any context passed in — the current move/position or a specific rule).
export default function AskBox({ context, apiKey, onNeedKey, placeholder, label }: AskBoxProps) {
  const [q, setQ] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const question = q.trim()
    if (!question || loading) return
    setLoading(true)
    setError(null)
    setAnswer(null)
    try {
      const resp = await fetchAsk({
        mode: 'ask',
        question,
        ...context,
        apiKey: apiKey.trim() || undefined,
      })
      setAnswer(resp.answer)
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
      <div className="ask-label">{label ?? 'Ask a question'}</div>
      <div className="ask-row">
        <input
          className="ask-input"
          value={q}
          placeholder={placeholder ?? 'e.g. why is this move risky here?'}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          maxLength={500}
          aria-label="Ask a chess question"
        />
        <button className="btn primary" onClick={submit} disabled={loading || !q.trim()}>
          {loading ? '…' : 'Ask'}
        </button>
      </div>
      {error ? <div className="error small">{error}</div> : null}
      {answer ? (
        <div className="ask-answer">
          <p>{answer}</p>
          <span className="ask-note">Heuristic coaching — not gospel.</span>
        </div>
      ) : null}
    </div>
  )
}
