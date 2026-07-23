// Vercel serverless function: /api/analyze-run — server-side analysis jobs.
//
//   POST {key, force?, includeLite?, repairEmpty?, game?}  → queue a job, kick
//     a worker, respond immediately. `game` is a SavedGame shell so a
//     brand-new game that has no cloud row yet can be enqueued.
//   POST {work: true}  → the worker: claims jobs and processes batches until
//     near the time limit, then chains a fresh invocation of itself.
//   GET ?key=…  → the job/analysed state for one game (the client's poll).
//     Also re-kicks a worker when a job looks stalled, so a dead chain
//     self-heals off the polls alone.
//
// One worker at a time is enforced by the jobs themselves (claim tokens +
// heartbeats), not by this endpoint.

import type { VercelRequest, VercelResponse } from '@vercel/node'

export const config = { maxDuration: 300 }

const MAX_BODY_BYTES = 900 * 1024

function selfUrl(req: VercelRequest): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || 'https'
  const host = req.headers.host || ''
  return `${proto}://${host}/api/analyze-run`
}

/** Fire a worker invocation and give the request ~2.5s to leave the machine —
    enough for the new invocation to start; nobody reads its response. A lost
    kick is not fatal: the client's status polls re-kick stalled jobs. */
async function kick(req: VercelRequest): Promise<void> {
  try {
    const p = fetch(selfUrl(req), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ work: true }),
    }).catch(() => {})
    await Promise.race([p, new Promise((r) => setTimeout(r, 2500))])
  } catch {
    /* best-effort */
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const startedAt = Date.now()
  try {
    const runner = await import('../src/server/runner.js')
    const store = await import('../src/server/games.js')

    if (req.method === 'GET') {
      if (!store.cloudConfigured()) {
        res.status(200).json({ enabled: false })
        return
      }
      const key = typeof req.query.key === 'string' ? req.query.key : ''
      if (!key) {
        res.status(200).json({ enabled: true })
        return
      }
      const st = await runner.jobStatus(key)
      // Self-heal, driven purely by the client polling. A QUEUED job is
      // claimable immediately — re-kick as soon as its enqueue kick looks
      // lost. A RUNNING job can only be RE-claimed once its heartbeat is
      // stale (STALE_MS), so kicking earlier would spawn workers with
      // nothing to do — align the thresholds or the job sits in a dead zone.
      const j = st.job
      const age = j ? Date.now() - j.heartbeat : 0
      if (
        j &&
        ((j.status === 'queued' && age > 20_000) ||
          (j.status === 'running' && age > runner.STALE_MS))
      ) {
        await kick(req)
      }
      res.status(200).json({ enabled: true, ...st })
      return
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' })
      return
    }
    if (!store.cloudConfigured()) {
      res.status(501).json({ error: 'Server-side analysis needs the games database.' })
      return
    }
    const raw = JSON.stringify(req.body ?? {})
    if (raw.length > MAX_BODY_BYTES) {
      res.status(413).json({ error: 'Request too large.' })
      return
    }
    const body = (req.body ?? {}) as {
      work?: boolean
      key?: string
      force?: boolean
      includeLite?: boolean
      repairEmpty?: boolean
      game?: unknown
    }

    if (body.work === true) {
      // The worker. Its response goes nowhere — the kicker never reads it.
      const more = await runner.processJobs(startedAt + 290_000)
      if (more) await kick(req) // chain: fresh invocation, fresh time budget
      res.status(200).json({ ok: true, chained: more })
      return
    }

    const key = typeof body.key === 'string' ? body.key.trim() : ''
    if (!key) {
      res.status(400).json({ error: 'Missing game key.' })
      return
    }
    const job = await runner.enqueueJob(
      key,
      { force: body.force === true, includeLite: body.includeLite === true, repairEmpty: body.repairEmpty === true },
      body.game,
    )
    await kick(req)
    res.status(202).json({ enabled: true, job })
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500
    const msg = e instanceof Error ? e.message : 'Server analysis failed.'
    res.status(typeof status === 'number' ? status : 500).json({ error: msg })
  }
}
