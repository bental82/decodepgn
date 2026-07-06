// Optional cloud persistence: mirrors localStorage saves to /api/games, which
// proxies to Supabase. Single-user by design — no login; the server holds the
// only credentials. Every call is best-effort: when the deployment has no
// database configured (or the network is down), the app silently keeps
// working from localStorage exactly as before.

import type { SavedGame } from './store'
import type { Focus } from '../shared/types'

export interface CloudGameMeta {
  key: string
  pgn: string
  focus: Focus
  headers: Record<string, string>
  savedAt: number
  analysed: number
  hasQuiz: boolean
}

async function fetchJson(url: string, init?: RequestInit): Promise<any | null> {
  try {
    const r = await fetch(url, init)
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

/** All cloud-saved games (light metadata), or null when the feature is off. */
export async function cloudList(): Promise<CloudGameMeta[] | null> {
  const d = await fetchJson('/api/games')
  return d && d.enabled === true && Array.isArray(d.games) ? (d.games as CloudGameMeta[]) : null
}

/** The full saved game, or null when missing/off. */
export async function cloudGet(key: string): Promise<SavedGame | null> {
  const d = await fetchJson(`/api/games?key=${encodeURIComponent(key)}`)
  const g = d?.game
  return g && typeof g.key === 'string' && typeof g.pgn === 'string' && g.results ? (g as SavedGame) : null
}

// Saves stream in while the analysis runs (a state change per batch), so each
// game's upload is debounced: one PUT shortly after the last change.
const pending = new Map<string, ReturnType<typeof setTimeout>>()

export function cloudSave(game: SavedGame): void {
  const t = pending.get(game.key)
  if (t) clearTimeout(t)
  pending.set(
    game.key,
    setTimeout(() => {
      pending.delete(game.key)
      void fetch('/api/games', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(game),
      }).catch(() => {
        /* best-effort — the local copy is the source of truth for this session */
      })
    }, 1500),
  )
}

export function cloudDelete(key: string): void {
  const t = pending.get(key)
  if (t) clearTimeout(t) // don't resurrect a game deleted mid-debounce
  pending.delete(key)
  void fetch(`/api/games?key=${encodeURIComponent(key)}`, { method: 'DELETE' }).catch(() => {})
}
