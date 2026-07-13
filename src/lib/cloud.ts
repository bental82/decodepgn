// Optional cloud persistence: mirrors localStorage saves to /api/games, which
// proxies to Supabase. Single-user by design — no login; the server holds the
// only credentials. Every call is best-effort: when the deployment has no
// database configured (or the network is down), the app silently keeps
// working from localStorage exactly as before.

import type { SavedGame } from './store'
import type { Focus, MetaGameSummary } from '../shared/types'
import type { SavedMetaReport } from '../ui/MetaCard'

export interface CloudGameMeta {
  key: string
  pgn: string
  focus: Focus
  headers: Record<string, string>
  savedAt: number
  addedAt?: number
  analysed: number
  hasQuiz: boolean
}

async function fetchJson(url: string, init?: RequestInit): Promise<any | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000), ...init })
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

/** Digests of every cloud game (server-computed, current formulas) — feeds
    the live cross-game stats. Null when the feature is off. */
export async function cloudListSummaries(): Promise<MetaGameSummary[] | null> {
  const d = await fetchJson('/api/games?summaries=1')
  return d && d.enabled === true && Array.isArray(d.summaries)
    ? (d.summaries as MetaGameSummary[])
    : null
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

export function cloudSave(game: SavedGame, onSynced?: (key: string) => void): void {
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
      })
        .then((r) => {
          if (r.ok) onSynced?.(game.key) // confirmed in the cloud
        })
        .catch(() => {
          /* best-effort — the local copy is the source of truth for this session */
        })
    }, 1500),
  )
}

/**
 * The cross-game meta report ("Your play, across games"), or null when the
 * cloud has none / the feature is off. Stored as a reserved row so it follows
 * the user across devices like the games do.
 */
export async function cloudGetMeta(): Promise<SavedMetaReport | null> {
  const d = await fetchJson('/api/games?meta=1')
  const m = d?.enabled === true ? d.meta : null
  return m && typeof m === 'object' && typeof m.generatedAt === 'number' ? (m as SavedMetaReport) : null
}

/** Fire-and-forget upload of a freshly generated meta report. */
export function cloudSaveMeta(report: SavedMetaReport): void {
  void fetch('/api/games?meta=1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report),
  }).catch(() => {
    /* best-effort — the local copy still works on this device */
  })
}

export function cloudDelete(key: string): void {
  const t = pending.get(key)
  if (t) clearTimeout(t) // don't resurrect a game deleted mid-debounce
  pending.delete(key)
  void fetch(`/api/games?key=${encodeURIComponent(key)}`, { method: 'DELETE' }).catch(() => {})
}
