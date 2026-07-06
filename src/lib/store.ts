// Local persistence of analysed games. Each game's per-move results are keyed
// by the move sequence + studied side, so re-loading the same PGN (or resuming
// after a reload) restores every analysed move instead of re-asking Claude.

import type { Color, Focus, GameOverview, MoveResult, ParsedMove, QuizKind, QuizQuestion } from '../shared/types'

const INDEX_KEY = 'decodepgn.games.index.v1'
const GAME_PREFIX = 'decodepgn.game.v1.'
const MAX_GAMES = 30 // LRU cap (quota-evict fallback below handles overflow)

/** A generated quiz plus the player's progress through it. */
export interface SavedQuiz {
  questions: QuizQuestion[]
  answers: (number | null)[]
  current: number
  /** which quiz this is (older saves have none = 'rules') */
  kind?: QuizKind
}

export interface SavedGame {
  key: string
  pgn: string
  focus: Focus
  headers: Record<string, string>
  /** last write (bumps on every analysis save) */
  savedAt: number
  /** when the game was FIRST added — set once, never bumped */
  addedAt?: number
  results: Record<number, MoveResult>
  quiz?: SavedQuiz
  overview?: GameOverview
  /** ply -> centipawns after that move, from White's perspective (eval bar) */
  evals?: Record<number, number>
  /** which side is the user, when they flagged it */
  me?: Color
}

function djb2(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

/** Stable identity for a game+side: the SAN sequence, not the header text. */
export function gameKey(moves: Pick<ParsedMove, 'san'>[], focus: Focus): string {
  const sans = moves.map((m) => m.san).join(' ')
  return `${focus}${moves.length}-${djb2(sans)}`
}

function readIndex(): string[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter((k) => typeof k === 'string') : []
  } catch {
    return []
  }
}

function writeIndex(keys: string[]) {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(keys))
  } catch {
    /* best-effort */
  }
}

export function loadGame(key: string): SavedGame | null {
  try {
    const raw = localStorage.getItem(GAME_PREFIX + key)
    if (!raw) return null
    const g = JSON.parse(raw) as SavedGame
    if (!g || typeof g.pgn !== 'string' || typeof g.results !== 'object') return null
    return g
  } catch {
    return null
  }
}

/** All saved games, most recent first, for the history list. */
export function listGames(): SavedGame[] {
  return readIndex()
    .map(loadGame)
    .filter((g): g is SavedGame => g !== null)
}

export function removeGame(key: string) {
  try {
    localStorage.removeItem(GAME_PREFIX + key)
  } catch {
    /* ignore */
  }
  writeIndex(readIndex().filter((k) => k !== key))
}

export function saveGame(game: SavedGame) {
  // addedAt is stable: keep the first save's value across every later write
  const prev = loadGame(game.key)
  game = { ...game, addedAt: prev?.addedAt ?? game.addedAt ?? Date.now() }
  const write = () => localStorage.setItem(GAME_PREFIX + game.key, JSON.stringify(game))
  try {
    write()
  } catch {
    // Quota: evict the oldest saved games and retry once.
    const index = readIndex()
    for (const k of index.slice(Math.max(1, index.length - 4))) {
      try {
        localStorage.removeItem(GAME_PREFIX + k)
      } catch {
        /* ignore */
      }
    }
    try {
      write()
    } catch {
      return // give up quietly — persistence is best-effort
    }
  }
  // move-to-front LRU index + evict beyond the cap
  const index = readIndex().filter((k) => k !== game.key)
  index.unshift(game.key)
  for (const k of index.slice(MAX_GAMES)) {
    try {
      localStorage.removeItem(GAME_PREFIX + k)
    } catch {
      /* ignore */
    }
  }
  writeIndex(index.slice(0, MAX_GAMES))
}
