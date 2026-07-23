import { useRef, useState } from 'react'
import { parsePgn, SAMPLE_PGN } from '../game'
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
  // A mobile paste sometimes delivers only the first characters ("1. e4" of a
  // whole game) — valid PGN, so it would silently become a permanent one-move
  // game. A suspiciously short parse warns once; a second tap loads it anyway.
  const [shortWarn, setShortWarn] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const submit = () => {
    try {
      const n = parsePgn(pgn).moves.length
      if (n < 4 && shortWarn === null) {
        setShortWarn(
          `Only ${n} move${n === 1 ? '' : 's'} found — that usually means the paste was cut short. ` +
            'Check the text above, or tap Analyse again to load it anyway.',
        )
        return
      }
    } catch {
      /* let the app surface its own parse error */
    }
    setShortWarn(null)
    onSubmit(pgn, color)
  }

  return (
    <div className="pgn-input card">
      <h2>1. Paste or upload a PGN</h2>
      <textarea
        rows={10}
        value={pgn}
        spellCheck={false}
        placeholder="Paste PGN here…"
        onChange={(e) => {
          setPgn(e.target.value)
          setShortWarn(null)
        }}
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
      {shortWarn ? <div className="error">{shortWarn}</div> : null}

      <button className="btn primary big" disabled={busy || !pgn.trim()} onClick={submit}>
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
