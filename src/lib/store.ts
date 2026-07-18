// Local persistence of analysed games. Each game's per-move results are keyed
// by the move sequence + studied side, so re-loading the same PGN (or resuming
// after a reload) restores every analysed move instead of re-asking Claude.

import type { Color, Focus, GameOverview, MoveResult, ParsedMove, QuizExplanation } from '../shared/types'

const INDEX_KEY = 'decodepgn.games.index.v1'
const GAME_PREFIX = 'decodepgn.game.v1.'
const MAX_GAMES = 30 // LRU cap (quota-evict fallback below handles overflow)

/** One try in a guess-the-move position. */
export interface QuizAttempt {
  san: string
  /** centipawns the try gives up vs the engine's best (absent when ungraded) */
  cpLoss?: number
  /** this try was the very move played in the game */
  isGameMove?: boolean
}

/** One guess-the-move position and the player's progress on it. */
export interface QuizPosition {
  ply: number
  /** wrong tries, in order (the solving move is `solution`, not listed here) */
  attempts: QuizAttempt[]
  solved: boolean
  /** the player gave up and asked for the answer */
  revealed: boolean
  hintUsed: boolean
  /** the move that solved it (the engine's best, or one just as strong) */
  solution?: QuizAttempt
  explanation?: QuizExplanation
}

/** The guess-the-move quiz: the game's costliest moments, frozen at start. */
export interface SavedQuiz {
  v: 2
  positions: QuizPosition[]
  current: number
  /** round identity — a dangling async patch from a previous round (or another
      game) must never land on a freshly started quiz */
  round: number
}

/** Validate a stored quiz FIELD BY FIELD; older multiple-choice saves (and
    any malformed blob, e.g. a truncated cloud write) are discarded rather
    than left to crash the Quiz tab on every open. */
export function sanitizeQuiz(q: unknown): SavedQuiz | null {
  const s = q as SavedQuiz | null
  if (!s || s.v !== 2 || !Array.isArray(s.positions)) return null
  const attempt = (a: unknown): QuizAttempt | null => {
    const x = a as QuizAttempt | null
    if (!x || typeof x.san !== 'string' || !x.san.trim()) return null
    return {
      san: x.san.slice(0, 12),
      ...(Number.isFinite(x.cpLoss) ? { cpLoss: Math.max(0, Math.trunc(x.cpLoss as number)) } : {}),
      ...(x.isGameMove === true ? { isGameMove: true } : {}),
    }
  }
  const positions: QuizPosition[] = []
  for (const raw of s.positions) {
    const p = raw as QuizPosition | null
    if (!p || !Number.isInteger(p.ply) || p.ply < 0 || !Array.isArray(p.attempts)) continue
    const sol = p.solution ? attempt(p.solution) : null
    const ex = p.explanation
    const explanation =
      ex && typeof ex.whyPlayed === 'string' && typeof ex.whyBest === 'string'
        ? {
            whyPlayed: ex.whyPlayed,
            whyBest: ex.whyBest,
            ...(Array.isArray(ex.attemptNotes)
              ? {
                  attemptNotes: ex.attemptNotes.filter(
                    (n) => n && typeof n.san === 'string' && typeof n.note === 'string',
                  ),
                }
              : {}),
          }
        : undefined
    positions.push({
      ply: p.ply,
      attempts: p.attempts.map(attempt).filter((a): a is QuizAttempt => a !== null),
      solved: p.solved === true,
      revealed: p.revealed === true,
      hintUsed: p.hintUsed === true,
      ...(sol ? { solution: sol } : {}),
      ...(explanation ? { explanation } : {}),
    })
  }
  if (!positions.length) return null
  const cur = Number.isInteger(s.current) ? s.current : 0
  return {
    v: 2,
    positions,
    current: Math.min(positions.length - 1, Math.max(0, cur)),
    round: Number.isInteger(s.round) ? s.round : 1,
  }
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
