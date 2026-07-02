// Import games from chess.com and Lichess public APIs. Both are key-less and
// CORS-enabled, so everything here runs in the user's browser — no account
// linking needed, just a username.

export type ImportSource = 'chesscom' | 'lichess'

export interface ImportedGame {
  pgn: string
  white: string
  black: string
  /** 'w' | 'b' — which side the requested user played */
  userColor: 'w' | 'b'
  /** result from the user's perspective */
  userResult: 'won' | 'lost' | 'draw'
  endTime: number // epoch seconds
  timeClass: string
  url: string
}

const MAX_GAMES = 20

function validUsername(u: string): boolean {
  return /^[A-Za-z0-9_-]{1,50}$/.test(u)
}

async function getResponse(url: string, accept?: string): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: accept ? { accept } : undefined,
    })
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.')
  }
  if (res.status === 404) throw new Error('No account with that username was found.')
  if (res.status === 429) throw new Error('The server is rate-limiting requests. Wait a moment and try again.')
  if (!res.ok) throw new Error(`Request failed (${res.status}).`)
  return res
}

// ---- chess.com (Published-Data API) ----

const CHESSCOM_API = 'https://api.chess.com/pub'
const CHESSCOM_MAX_MONTHS = 6
const CC_WIN = new Set(['win'])
const CC_DRAW = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient'])

async function fetchChessCom(username: string): Promise<ImportedGame[]> {
  const res = await getResponse(`${CHESSCOM_API}/player/${encodeURIComponent(username)}/games/archives`)
  const archData = (await res.json()) as { archives?: string[] }
  const archives = Array.isArray(archData.archives) ? archData.archives : []
  if (archives.length === 0) return []

  const lower = username.toLowerCase()
  const games: ImportedGame[] = []
  // archives are oldest -> newest; walk backwards
  for (const url of archives.slice(-CHESSCOM_MAX_MONTHS).reverse()) {
    const monthRes = await getResponse(url)
    const month = (await monthRes.json()) as {
      games?: Array<{
        pgn?: string
        rules?: string
        end_time?: number
        time_class?: string
        url?: string
        white?: { username?: string; result?: string }
        black?: { username?: string; result?: string }
      }>
    }
    for (const g of month.games ?? []) {
      if (!g || typeof g.pgn !== 'string' || !g.pgn.trim()) continue
      if (g.rules && g.rules !== 'chess') continue // skip variants (960, bughouse, …)
      const w = g.white?.username ?? ''
      const b = g.black?.username ?? ''
      const userColor = w.toLowerCase() === lower ? 'w' : b.toLowerCase() === lower ? 'b' : null
      if (!userColor) continue
      const myResult = (userColor === 'w' ? g.white?.result : g.black?.result) ?? ''
      games.push({
        pgn: g.pgn,
        white: w || 'White',
        black: b || 'Black',
        userColor,
        userResult: CC_WIN.has(myResult) ? 'won' : CC_DRAW.has(myResult) ? 'draw' : 'lost',
        endTime: typeof g.end_time === 'number' ? g.end_time : 0,
        timeClass: typeof g.time_class === 'string' ? g.time_class : '',
        url: typeof g.url === 'string' ? g.url : '',
      })
    }
    if (games.length >= MAX_GAMES) break
  }
  games.sort((a, b) => b.endTime - a.endTime)
  return games.slice(0, MAX_GAMES)
}

// ---- Lichess (games export API) ----
// NDJSON stream, one game per line; includes games vs the Stockfish AI.

interface LichessPlayer {
  user?: { name?: string }
  aiLevel?: number
}

async function fetchLichess(username: string): Promise<ImportedGame[]> {
  // perfType narrows to standard-chess pools SERVER-side; without it the
  // max=N cap could be eaten entirely by variant games (Crazyhouse, 960, …)
  // and a player of variants would import zero games.
  const standardPerfs = 'ultraBullet,bullet,blitz,rapid,classical,correspondence'
  const url =
    `https://lichess.org/api/games/user/${encodeURIComponent(username)}` +
    `?max=${MAX_GAMES}&perfType=${standardPerfs}&pgnInJson=true&clocks=false&evals=false&opening=false`
  const res = await getResponse(url, 'application/x-ndjson')
  const text = await res.text()

  const lower = username.toLowerCase()
  const games: ImportedGame[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let g: {
      pgn?: string
      variant?: string
      speed?: string
      status?: string
      lastMoveAt?: number
      createdAt?: number
      winner?: string
      id?: string
      players?: { white?: LichessPlayer; black?: LichessPlayer }
    }
    try {
      g = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!g || typeof g.pgn !== 'string' || !g.pgn.trim()) continue
    if (g.variant && g.variant !== 'standard') continue
    if (g.status === 'aborted' || g.status === 'noStart') continue // zero-move games

    const nameOf = (p?: LichessPlayer) =>
      p?.user?.name ?? (typeof p?.aiLevel === 'number' ? `Stockfish AI level ${p.aiLevel}` : 'Anonymous')
    const wName = nameOf(g.players?.white)
    const bName = nameOf(g.players?.black)
    const userColor =
      g.players?.white?.user?.name?.toLowerCase() === lower
        ? 'w'
        : g.players?.black?.user?.name?.toLowerCase() === lower
          ? 'b'
          : null
    if (!userColor) continue

    const userResult = !g.winner
      ? 'draw'
      : (g.winner === 'white') === (userColor === 'w')
        ? 'won'
        : 'lost'
    const ms = typeof g.lastMoveAt === 'number' ? g.lastMoveAt : (g.createdAt ?? 0)
    games.push({
      pgn: g.pgn,
      white: wName,
      black: bName,
      userColor,
      userResult,
      endTime: Math.floor(ms / 1000),
      timeClass: typeof g.speed === 'string' ? g.speed : '',
      url: g.id ? `https://lichess.org/${g.id}` : '',
    })
  }
  games.sort((a, b) => b.endTime - a.endTime)
  return games.slice(0, MAX_GAMES)
}

/** Recent standard-chess games for a username on the given site, newest first. */
export async function fetchRecentGames(source: ImportSource, usernameRaw: string): Promise<ImportedGame[]> {
  const username = usernameRaw.trim()
  if (!validUsername(username)) {
    throw new Error('That does not look like a valid username.')
  }
  return source === 'lichess' ? fetchLichess(username) : fetchChessCom(username)
}
