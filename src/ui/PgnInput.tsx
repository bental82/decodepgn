import { useMemo, useRef, useState } from 'react'
import { commonPlayer, parsePgn, SAMPLE_PGN, sideOf, splitPgnGames } from '../game'
import type { Focus } from '../shared/types'
import type { ImportOutcome, PgnInputProps } from './contract'
import Icon from './Icon'

export default function PgnInput({
  onSubmit,
  onImportMany,
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
  // A PGN file often holds a whole database (a chess.com / Lichess export).
  // Several games switch the card into a batch import: every game is added
  // and queued, and the side to study defaults to the player found in all of
  // them — whoever exported their own games.
  const games = useMemo(() => splitPgnGames(pgn), [pgn])
  const multi = games.length > 1
  const player = useMemo(() => (multi ? commonPlayer(games) : null), [multi, games])
  const [byPlayer, setByPlayer] = useState(true)
  const usePlayer = multi && !!player && byPlayer
  const [importing, setImporting] = useState<{ done: number; total: number } | null>(null)
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null)

  // A finished game's movetext ends with a result token (or checkmate); a
  // paste that stops mid-game without one was almost certainly cut short.
  const GAME_END_RE = /(1-0|0-1|1\/2-1\/2|½-½|\*)\s*$/

  // The field is uncontrolled (see the textarea below) — programmatic fills
  // write the DOM directly and mirror to state.
  const setText = (t: string) => {
    if (taRef.current) taRef.current.value = t
    setPgn(t)
    setShortWarn(null)
    setOutcome(null)
  }

  const importAll = async () => {
    if (importing) return
    const text = taRef.current?.value ?? pgn
    const list = splitPgnGames(text)
    const who = usePlayer ? player : null
    const items = list.map((g) => ({ pgn: g, focus: (who ? sideOf(g, who) : null) ?? color }))
    setOutcome(null)
    setImporting({ done: 0, total: items.length })
    try {
      const out = await onImportMany(items, (done, total) => setImporting({ done, total }))
      setOutcome(out)
      // the games are in the library now — clear the box for the next file
      if (out.queued > 0 && taRef.current) {
        taRef.current.value = ''
        setPgn('')
      }
    } finally {
      setImporting(null)
    }
  }

  const submit = () => {
    // The DOM is the source of truth at submit time: some mobile keyboards
    // deliver a large paste without a matching change event, so React state
    // can hold only the first chunk of what the field visibly contains.
    const text = (taRef.current?.value ?? pgn).trim()
    if (text !== pgn) setPgn(text)
    if (splitPgnGames(text).length > 1) {
      void importAll()
      return
    }
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
          setOutcome(null)
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

      {multi ? (
        <p className="pgn-multi note small">
          <strong>{games.length} games</strong> in this PGN — they are all added to your library
          and analysed one after another.
        </p>
      ) : null}

      <h2>2. Which side do you want to study{multi ? ' in each game' : ''}?</h2>
      <div className={'color-select' + (multi && player ? ' with-player' : '')}>
        {multi && player ? (
          <label className={usePlayer ? 'active' : ''} title={`Study ${player}'s moves in every game`}>
            <input
              type="radio"
              name="focus"
              checked={usePlayer}
              onChange={() => setByPlayer(true)}
            />
            <Icon name="pawn" size={16} />
            <span className="side-player">{player}</span>
          </label>
        ) : null}
        <label className={!usePlayer && color === 'w' ? 'active' : ''}>
          <input
            type="radio"
            name="focus"
            checked={!usePlayer && color === 'w'}
            onChange={() => {
              setColor('w')
              setByPlayer(false)
            }}
          />
          <img className="side-ico" src="/piece/staunty/wK.svg" alt="" />
          White
        </label>
        <label className={!usePlayer && color === 'b' ? 'active' : ''}>
          <input
            type="radio"
            name="focus"
            checked={!usePlayer && color === 'b'}
            onChange={() => {
              setColor('b')
              setByPlayer(false)
            }}
          />
          <img className="side-ico" src="/piece/staunty/bK.svg" alt="" />
          Black
        </label>
        <label className={!usePlayer && color === 'both' ? 'active' : ''}>
          <input
            type="radio"
            name="focus"
            checked={!usePlayer && color === 'both'}
            onChange={() => {
              setColor('both')
              setByPlayer(false)
            }}
          />
          <img className="side-ico" src="/piece/staunty/wK.svg" alt="" />
          <img className="side-ico" src="/piece/staunty/bK.svg" alt="" />
          Both sides
        </label>
      </div>

      {error && !multi ? <div className="error">{error}</div> : null}
      {shortWarn && !multi ? <div className="error">{shortWarn}</div> : null}
      {outcome ? (
        <div className={outcome.error ? 'error' : 'note import-note'} role="status">
          {outcome.message}
        </div>
      ) : null}

      <button
        className="btn primary big"
        disabled={busy || !!importing || !pgn.trim()}
        onClick={submit}
      >
        {importing
          ? `Adding games… ${importing.done}/${importing.total}`
          : busy
            ? 'Working…'
            : multi
              ? `3. Analyse all ${games.length} games`
              : '3. Analyse the game'}
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
