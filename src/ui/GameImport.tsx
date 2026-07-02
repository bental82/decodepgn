import { useState } from 'react'
import { fetchRecentGames, type ImportSource, type ImportedGame } from '../lib/importers'
import type { Focus } from '../shared/types'

const USER_STORAGE: Record<ImportSource, string> = {
  chesscom: 'decodepgn.import.chesscom',
  lichess: 'decodepgn.import.lichess',
}

interface Props {
  onPick: (pgn: string, focus: Focus) => void
}

// Pull recent games straight from the chess.com / Lichess public APIs by
// username — no account linking; runs entirely in the browser.
export default function GameImport({ onPick }: Props) {
  const [source, setSource] = useState<ImportSource>('chesscom')
  const [username, setUsername] = useState<string>(
    () => localStorage.getItem(USER_STORAGE.chesscom) || '',
  )
  const [games, setGames] = useState<ImportedGame[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pickSource = (s: ImportSource) => {
    if (s === source) return
    setSource(s)
    setGames(null)
    setError(null)
    setUsername(localStorage.getItem(USER_STORAGE[s]) || '')
  }

  const load = async () => {
    const u = username.trim()
    if (!u || loading) return
    setLoading(true)
    setError(null)
    setGames(null)
    try {
      const list = await fetchRecentGames(source, u)
      setGames(list)
      localStorage.setItem(USER_STORAGE[source], u)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not fetch games.')
    } finally {
      setLoading(false)
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
            if (e.key === 'Enter') load()
          }}
          maxLength={50}
        />
        <button className="btn" onClick={load} disabled={loading || !username.trim()}>
          {loading ? 'Fetching…' : 'Fetch games'}
        </button>
      </div>
      {error ? <div className="error small">{error}</div> : null}
      {games && games.length === 0 ? (
        <p className="note small">No recent games found. {botNote}</p>
      ) : null}
      {games && games.length > 0 ? (
        <>
          <ul className="cc-list">
            {games.map((g, i) => (
              <li key={g.url || i}>
                <button
                  className="cc-game"
                  onClick={() => onPick(g.pgn, g.userColor)}
                  title="Analyse this game"
                >
                  <span className={'cc-res r-' + g.userResult}>{resultGlyph(g.userResult)}</span>
                  <span className="cc-players">
                    {g.white} vs {g.black}
                  </span>
                  <span className="cc-meta">
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
            ))}
          </ul>
          <p className="note small">{botNote}</p>
        </>
      ) : null}
    </div>
  )
}
