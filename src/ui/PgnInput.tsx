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
  // A mobile paste sometimes loses the tail of the game ("1. e4 … 7. O-O" of a
  // whole game) — valid PGN, so it would silently become a permanent truncated
  // game. A suspicious parse warns once; a second tap loads it anyway.
  const [shortWarn, setShortWarn] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // A finished game's movetext ends with a result token (or checkmate); a
  // paste that stops mid-game without one was almost certainly cut short.
  const GAME_END_RE = /(1-0|0-1|1\/2-1\/2|½-½|\*)\s*$/

  // The field is uncontrolled (see the textarea below) — programmatic fills
  // write the DOM directly and mirror to state.
  const setText = (t: string) => {
    if (taRef.current) taRef.current.value = t
    setPgn(t)
    setShortWarn(null)
  }

  const submit = () => {
    // The DOM is the source of truth at submit time: some mobile keyboards
    // deliver a large paste without a matching change event, so React state
    // can hold only the first chunk of what the field visibly contains.
    const text = (taRef.current?.value ?? pgn).trim()
    if (text !== pgn) setPgn(text)
    try {
      const parsed = parsePgn(text)
      const n = parsed.moves.length
      const lastSan = parsed.moves[n - 1]?.san ?? ''
      const looksComplete = GAME_END_RE.test(text) || lastSan.includes('#')
      const warn =
        n < 4
          ? `Only ${n} move${n === 1 ? '' : 's'} found — that usually means the paste was cut short. ` +
            'Check the text above, or tap Analyse again to load it anyway.'
          : !looksComplete
            ? `The game stops after ${Math.ceil(n / 2)} moves with no result (1-0, 0-1, ½-½) at the end — ` +
              'the paste may have been cut short. Re-copy the full PGN, or tap Analyse again to load it as is.'
            : null
      if (warn && shortWarn === null) {
        setShortWarn(warn)
        return
      }
    } catch {
      /* let the app surface its own parse error */
    }
    setShortWarn(null)
    onSubmit(text, color)
  }

  return (
    <div className="pgn-input card">
      <h2>1. Paste or upload a PGN</h2>
      {/* UNCONTROLLED on purpose: mobile keyboards insert a long clipboard in
          pieces, and a controlled field's re-render after the first piece
          cancels the rest of the insertion — the paste arrives cut short.
          React must never write this field's value; state only mirrors it. */}
      <textarea
        ref={taRef}
        rows={10}
        defaultValue=""
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
            reader.onload = () => setText(String(reader.result ?? ''))
            reader.readAsText(file)
            e.target.value = ''
          }}
        />
        <button className="btn ghost" onClick={() => fileRef.current?.click()}>
          Upload .pgn
        </button>
        <button className="btn ghost" onClick={() => setText(SAMPLE_PGN)}>
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
