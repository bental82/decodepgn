import { useRef, useState } from 'react'
import { SAMPLE_PGN } from '../game'
import type { Focus } from '../shared/types'
import type { PgnInputProps } from './contract'

export default function PgnInput({
  onSubmit,
  onOpenSettings,
  error,
  busy,
  hasServerKey,
}: PgnInputProps) {
  const [pgn, setPgn] = useState('')
  const [color, setColor] = useState<Focus>('w')
  const fileRef = useRef<HTMLInputElement>(null)

  return (
    <div className="pgn-input card">
      <h2>1. Paste or upload a PGN</h2>
      <textarea
        rows={10}
        value={pgn}
        spellCheck={false}
        placeholder="Paste PGN here…"
        onChange={(e) => setPgn(e.target.value)}
      />

      <div className="pgn-actions">
        <input
          ref={fileRef}
          type="file"
          accept=".pgn,text/plain"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (!file) return
            const reader = new FileReader()
            reader.onload = () => setPgn(String(reader.result ?? ''))
            reader.readAsText(file)
            e.target.value = ''
          }}
        />
        <button className="btn ghost" onClick={() => fileRef.current?.click()}>
          Upload .pgn
        </button>
        <button className="btn ghost" onClick={() => setPgn(SAMPLE_PGN)}>
          Load example game
        </button>
      </div>

      <h2>2. Which side do you want to study?</h2>
      <div className="color-select">
        <label className={color === 'w' ? 'active' : ''}>
          <input
            type="radio"
            name="focus"
            checked={color === 'w'}
            onChange={() => setColor('w')}
          />
          Study White’s decisions
        </label>
        <label className={color === 'b' ? 'active' : ''}>
          <input
            type="radio"
            name="focus"
            checked={color === 'b'}
            onChange={() => setColor('b')}
          />
          Study Black’s decisions
        </label>
        <label className={color === 'both' ? 'active' : ''}>
          <input
            type="radio"
            name="focus"
            checked={color === 'both'}
            onChange={() => setColor('both')}
          />
          Study both sides
        </label>
      </div>

      {error ? <div className="error">{error}</div> : null}

      <button
        className="btn primary big"
        disabled={busy || !pgn.trim()}
        onClick={() => onSubmit(pgn, color)}
      >
        {busy ? 'Working…' : '3. Analyse the game'}
      </button>

      <p className="muted small">
        Analysis runs through Claude.{' '}
        {hasServerKey ? (
          <>
            A key may already be configured on the server, but you can also{' '}
            <button className="settings-link" onClick={onOpenSettings}>
              add your Anthropic key
            </button>{' '}
            to use your own.
          </>
        ) : (
          <>
            You’ll need to{' '}
            <button className="settings-link" onClick={onOpenSettings}>
              add your Anthropic key
            </button>{' '}
            before the game can be analysed.
          </>
        )}
      </p>
    </div>
  )
}
