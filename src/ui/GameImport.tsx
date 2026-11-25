import { useMemo, useRef, useState } from 'react'
import { parsePgn } from '../game'
import {
  fetchRecentGames,
  IMPORT_MAX,
  IMPORT_PAGE,
  type ImportSource,
  type ImportedGame,
} from '../lib/importers'
import { gameKey } from '../lib/store'
import type { Focus } from '../shared/types'
import type { ImportGamesFn, ImportOutcome } from './contract'

const USER_STORAGE: Record<ImportSource, string> = {
  chesscom: 'decodepgn.import.chesscom',
  lichess: 'decodepgn.import.lichess',
}

interface Props {
  /** Load a game into the analyser. Returns false if the PGN could not be parsed. */
  onPick: (pgn: string, focus: Focus) => boolean
  /** Add the ticked games to the library and queue their analysis. */
  onImport: ImportGamesFn
  /** keys of the games already in the library (they can't be ticked again) */
  knownKeys: Set<string>
}

/** A stable identity for a listed game — the selection survives "Load more". */
const idOf = (g: ImportedGame) => g.url || `${g.endTime}-${g.white}-${g.black}`

// Pull recent games straight from the chess.com / Lichess public APIs by
// username — no account linking; runs entirely in the browser. Tap a game to
// study it now, or tick several and analyse them all in one go.
export default function GameImport({ onPick, onImport, knownKeys }: Props) {
  const [source, setSource] = useState<ImportSource>('chesscom')
  const [username, setUsername] = useState<string>(
    () => localStorage.getItem(USER_STORAGE.chesscom) || '',
  )
  const [games, setGames] = useState<ImportedGame[] | null>(null)
  const [limit, setLimit] = useState(IMPORT_PAGE)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState<{ done: number; total: number } | null>(null)
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null)
  // queued this session — "in library" before the cloud list catches up
  const [added, setAdded] = useState<Set<string>>(new Set())
  // Bumped on every load/source switch so a slow response for the previous
  // source can't render its games (or its error) under the new tab.
  const reqRef = useRef(0)

  // Each listed game's library key (same move list + side = same game), so
  // games already analysed show as such and are never queued twice.
  const keyById = useMemo(() => {
    const m = new Map<string, string | null>()
    for (const g of games ?? []) {
      try {
        m.set(idOf(g), gameKey(parsePgn(g.pgn).moves, g.userColor))
      } catch {
        m.set(idOf(g), null) // unreadable (aborted, empty) — can't be imported
      }
    }
    return m
  }, [games])
  const inLibrary = (g: ImportedGame) => {
    const k = keyById.get(idOf(g))
    return !!k && (knownKeys.has(k) || added.has(k))
  }
  const pickable = (g: ImportedGame) => !!keyById.get(idOf(g)) && !inLibrary(g)

  const pickSource = (s: ImportSource) => {
    if (s === source) return
    reqRef.current++ // invalidate any in-flight fetch
    setSource(s)
    setGames(null)
    setError(null)
    setLoading(false)
    setSelected(new Set())
    setOutcome(null)
    setUsername(localStorage.getItem(USER_STORAGE[s]) || '')
  }

  const load = async (n = IMPORT_PAGE) => {
    const u = username.trim()
    if (!u || loading) return
    const reqId = ++reqRef.current
    const more = n > IMPORT_PAGE
    setLoading(true)
    setError(null)
    if (!more) {
      setGames(null)
      setSelected(new Set())
      setOutcome(null)
    }
    try {
      const list = await fetchRecentGames(source, u, n)
      if (reqRef.current !== reqId) return // stale — user switched source
      setGames(list)
      setLimit(n)
      localStorage.setItem(USER_STORAGE[source], u)
    } catch (e) {
      if (reqRef.current !== reqId) return
      setError(e instanceof Error ? e.message : 'Could not fetch games.')
    } finally {
      if (reqRef.current === reqId) setLoading(false)
    }
  }

  const pick = (g: ImportedGame) => {
    setError(null)
    const ok = onPick(g.pgn, g.userColor)
    // Surface parse failures HERE — the PGN-card error is off-screen from this list.
    if (!ok) setError('Could not read that game’s moves (it may be empty or aborted). Try another game.')
  }

  const toggle = (g: ImportedGame) => {
    const id = idOf(g)
    setOutcome(null)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const list = games ?? []
  const chosen = list.filter((g) => selected.has(idOf(g)) && pickable(g))
  const newOnes = list.filter(pickable)
  const allChosen = newOnes.length > 0 && newOnes.every((g) => selected.has(idOf(g)))
  const toggleAll = () => {
    setOutcome(null)
    setSelected(allChosen ? new Set() : new Set(newOnes.map(idOf)))
  }

  const importChosen = async () => {
    if (importing || chosen.length === 0) return
    setOutcome(null)
    setError(null)
    setImporting({ done: 0, total: chosen.length })
    try {
      const out = await onImport(
        chosen.map((g) => ({ pgn: g.pgn, focus: g.userColor })),
        (done, total) => setImporting({ done, total }),
      )
      setOutcome(out)
      if (out.keys.length) {
        setAdded((prev) => new Set([...prev, ...out.keys]))
        setSelected(new Set())
      }
    } finally {
      setImporting(null)
    }
  }

  const resultGlyph = (r: ImportedGame['userResult']) => (r === 'won' ? '1' : r === 'lost' ? '0' : '½')

  const botNote =
    source === 'chesscom' ? (
      <>
        Games against chess.com <strong>bots</strong> often don’t appear in the public API — on
        chess.com use <em>Share → Download PGN</em> on the game and paste it above.
      </>
    ) : (
      <>Lichess includes your games against the Stockfish AI too.</>
    )

  return (
    <div className="ccimport">
      <h2>…or import your games</h2>
      <div className="cc-sources" role="radiogroup" aria-label="Import source">
        <button
          className={'cc-source' + (source === 'chesscom' ? ' active' : '')}
          role="radio"
          aria-checked={source === 'chesscom'}
          onClick={() => pickSource('chesscom')}
        >
          chess.com
        </button>
        <button
          className={'cc-source' + (source === 'lichess' ? ' active' : '')}
          role="radio"
          aria-checked={source === 'lichess'}
          onClick={() => pickSource('lichess')}
        >
          lichess.org
        </button>
      </div>
      <div className="cc-row">
        <input
          className="cc-input"
          value={username}
          placeholder={source === 'chesscom' ? 'chess.com username' : 'Lichess username'}
          aria-label={`${source === 'chesscom' ? 'chess.com' : 'Lichess'} username`}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void load()
          }}
          maxLength={50}
        />
        <button className="btn" onClick={() => void load()} disabled={loading || !username.trim()}>
          {loading && !games ? 'Fetching…' : 'Fetch games'}
        </button>
      </div>
      {error ? <div className="error small">{error}</div> : null}
      {games && games.length === 0 ? (
        <p className="note small">No recent games found. {botNote}</p>
      ) : null}
      {games && games.length > 0 ? (
        <>
          <p className="muted small cc-hint">
            Tap a game to study it now — or tick several and analyse them all at once.
          </p>
          <div className="cc-toolbar">
            <label className={'cc-all' + (newOnes.length === 0 ? ' disabled' : '')}>
              <input
                type="checkbox"
                checked={allChosen}
                disabled={newOnes.length === 0 || !!importing}
                onChange={toggleAll}
              />
              {newOnes.length === 0 ? 'All in your library' : `Select all new (${newOnes.length})`}
            </label>
            <button
              className="btn primary cc-go"
              disabled={chosen.length === 0 || !!importing}
              onClick={() => void importChosen()}
            >
              {importing
                ? `Adding… ${importing.done}/${importing.total}`
                : chosen.length > 0
                  ? `Analyse ${chosen.length} game${chosen.length === 1 ? '' : 's'}`
                  : 'Analyse selected'}
            </button>
          </div>
          {outcome ? (
            <div className={outcome.error ? 'error small' : 'note import-note'} role="status">
              {outcome.message}
            </div>
          ) : null}
          <ul className="cc-list">
            {games.map((g) => {
              const id = idOf(g)
              const lib = inLibrary(g)
              const can = pickable(g)
              return (
                <li key={id} className={'cc-item' + (lib ? ' in-lib' : '')}>
                  <label
                    className={'cc-pick' + (can ? '' : ' disabled')}
                    title={lib ? 'Already in your library' : can ? 'Select for batch analysis' : 'This game has no moves to analyse'}
                  >
                    <input
                      type="checkbox"
                      checked={lib || selected.has(id)}
                      disabled={!can || !!importing}
                      onChange={() => toggle(g)}
                      aria-label={`Select ${g.white} vs ${g.black}`}
                    />
                  </label>
                  <button className="cc-game" onClick={() => pick(g)} title="Analyse this game now">
                    <span className={'cc-res r-' + g.userResult}>{resultGlyph(g.userResult)}</span>
                    <span className="cc-players">
                      {g.white} vs {g.black}
                    </span>
                    <span className="cc-meta">
                      {lib ? <span className="cc-saved">in library · </span> : null}
                      {g.userColor === 'w' ? 'White' : 'Black'} · {g.timeClass || 'game'}
                      {g.endTime
                        ? ' · ' +
                          new Date(g.endTime * 1000).toLocaleDateString(undefined, {
                            day: 'numeric',
                            month: 'short',
                          })
                        : ''}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          {games.length >= limit && limit < IMPORT_MAX ? (
            <button
              className="btn ghost cc-more"
              disabled={loading}
              onClick={() => void load(Math.min(IMPORT_MAX, limit + IMPORT_PAGE))}
            >
              {loading ? 'Fetching…' : 'Load older games'}
            </button>
          ) : null}
          <p className="note small">{botNote}</p>
        </>
      ) : null}
    </div>
  )
}
