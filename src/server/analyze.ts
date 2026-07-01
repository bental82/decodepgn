// Server-side analysis: send the game + target moves to Claude Opus and get back,
// for each move, which of the rules of thumb are relevant and how the move
// relates to them. Structured output is obtained via a forced tool call, which
// works across SDK versions and models.
//
// This module is server-only (it imports the Anthropic SDK and reads the API
// key). It must never be imported by browser code.

import { rulesForPrompt, RULE_COUNT } from '../shared/rules'
import type { AnalyzeRequest, AnalyzeResponse, MoveResult, RuleHit } from '../shared/types'

export const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8'
const MAX_TARGETS = 16 // per request (the client batches; this is a safety cap)
const MAX_GAME_PLIES = 800 // bound the context we send

export class AnalyzeError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'AnalyzeError'
    this.status = status
  }
}

/** Turn an Anthropic API error into a short, actionable message for the client. */
function friendlyAnthropicMessage(status: number, raw: string): string {
  if (status === 401 || status === 403)
    return 'Anthropic rejected the API key (invalid or unauthorized). Check the key in Settings.'
  if (status === 404)
    return `The Anthropic API did not recognise the configured model. Set ANTHROPIC_MODEL to a model your key can access. (${raw})`
  if (status === 429) return 'Anthropic rate limit reached. Wait a moment and try again.'
  if (status === 400) return `Anthropic rejected the request: ${raw}`
  if (status === 529 || status === 503) return 'Anthropic is temporarily overloaded. Please try again shortly.'
  return raw || 'The Claude request failed.'
}

const OUTPUT_TOOL = {
  name: 'report_relevance',
  description: 'Report which rules of thumb are relevant for each requested move.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      results: {
        type: 'array',
        description: 'One entry per requested move (by ply).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ply: { type: 'integer', description: 'The ply of the move being analysed.' },
            rules: {
              type: 'array',
              description: 'Rules that are genuinely relevant to this move (usually 1-4).',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'integer', description: `Rule number, 1 to ${RULE_COUNT}.` },
                  status: {
                    type: 'string',
                    enum: ['follows', 'partially', 'violates', 'relevant'],
                    description:
                      'Whether the move follows, partially follows, or violates the rule; or is just relevant/unclear.',
                  },
                  why: {
                    type: 'string',
                    description: 'One plain-language sentence explaining the relevance for a club player.',
                  },
                },
                required: ['id', 'status', 'why'],
              },
            },
            lesson: { type: 'string', description: 'One short practical lesson for this move.' },
          },
          required: ['ply', 'rules', 'lesson'],
        },
      },
    },
    required: ['results'],
  },
}

export async function runAnalyze(input: AnalyzeRequest): Promise<AnalyzeResponse> {
  const apiKey = (input.apiKey && input.apiKey.trim()) || process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new AnalyzeError(
      'No Anthropic API key available. Set ANTHROPIC_API_KEY on the server, or add your own key in Settings.',
      401,
    )
  }
  if (input.focus !== 'w' && input.focus !== 'b') {
    throw new AnalyzeError('focus must be "w" or "b".')
  }
  if (!Array.isArray(input.game) || !Array.isArray(input.targets)) {
    throw new AnalyzeError('Malformed request: game and targets are required.')
  }
  // de-duplicate targets by ply, cap the count, and clamp per-field string sizes
  // so a client can't inflate the prompt with megabytes of text.
  const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.slice(0, n) : '')
  const intOr = (v: unknown, d: number) => (Number.isFinite(v) ? Math.trunc(v as number) : d)
  const seen = new Set<number>()
  const targets = input.targets
    .filter((t) => {
      if (!t || typeof t.ply !== 'number' || seen.has(t.ply)) return false
      seen.add(t.ply)
      return true
    })
    .map((t) => ({ ply: intOr(t.ply, 0), fenAfter: clip(t.fenAfter, 100) }))
  if (targets.length === 0) return { results: [] }
  if (targets.length > MAX_TARGETS) {
    throw new AnalyzeError(`Too many moves in one request (max ${MAX_TARGETS}).`)
  }
  const requestedPlies = new Set(targets.map((t) => t.ply))
  const game = input.game.slice(0, MAX_GAME_PLIES).map((m) => ({
    ply: intOr(m?.ply, 0),
    moveNumber: intOr(m?.moveNumber, 0),
    color: m?.color === 'b' ? ('b' as const) : ('w' as const),
    san: clip(m?.san, 12),
  }))

  const sideName = input.focus === 'w' ? 'White' : 'Black'

  const moveText = game
    .map((m) => (m.color === 'w' ? `${m.moveNumber}. ${m.san}` : `${m.moveNumber}... ${m.san}`))
    .join('  ')

  const byPly = new Map(game.map((m) => [m.ply, m]))
  const targetLines = targets
    .map((t) => {
      const m = byPly.get(t.ply)
      const label = m ? `${m.moveNumber}${m.color === 'w' ? '.' : '...'} ${m.san}` : `ply ${t.ply}`
      return `- ply ${t.ply}: ${sideName}'s move ${label}. Resulting position (FEN): ${t.fenAfter}`
    })
    .join('\n')

  // The big, invariant part of the prompt (role + the full rule set) is a stable
  // prefix — mark it for prompt caching so every request reuses it cheaply.
  // The tiny perspective line comes after the cache breakpoint.
  const rulesBlock = `You are a friendly, practical chess coach for club players (beginner to intermediate).

You are given a list of ${RULE_COUNT} strategic "rules of thumb", numbered 1-${RULE_COUNT}, grouped by theme (opening/development, trades, minor pieces, rooks and files, the center and pawn breaks, weaknesses, king safety and attacking, and endgames). For a requested move by the side under study, decide which of these rules are genuinely RELEVANT at that moment, and for each relevant rule state whether the move "follows", "partially" follows, "violates" it, or is just "relevant" (matters here but neutral/unclear).

Pick the rules that fit THIS move and phase of the game: opening/development rules early, middlegame rules (trades, pawn breaks, weaknesses, king safety, attacks) in the middlegame, and endgame rules once queens or most pieces are gone. Give one plain-language sentence per relevant rule that a club player can understand, using honest, hedged language ("appears", "may", "likely"). Only list rules that truly apply — usually 1 to 4 per move. Do not force irrelevant rules. Also give one short practical "lesson" sentence for the move. Refer to rules by their NUMBER (1-${RULE_COUNT}) exactly.

The ${RULE_COUNT} rules:
${rulesForPrompt()}`

  const system = [
    { type: 'text', text: rulesBlock, cache_control: { type: 'ephemeral' as const } },
    { type: 'text', text: `Analyse strictly from ${sideName}'s perspective.` },
  ]

  const user = `Full game in SAN:
${moveText}

Analyse the following ${sideName} move(s) and report using the report_relevance tool. Return exactly one result object per ply listed:
${targetLines}`

  // Call the Anthropic Messages API directly over HTTP. Using fetch (built into
  // the Node 18+ runtime) means the serverless function has NO third-party
  // dependency to bundle, which removes a whole class of Vercel load failures.
  let resp: Response
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        system,
        tools: [OUTPUT_TOOL],
        tool_choice: { type: 'tool', name: 'report_relevance' },
        messages: [{ role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(55_000),
    })
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    throw new AnalyzeError(
      timedOut
        ? 'The Anthropic request timed out. Try again, or analyse fewer moves at once.'
        : 'Could not reach the Anthropic API. Please try again shortly.',
      timedOut ? 504 : 502,
    )
  }

  if (!resp.ok) {
    // Preserve the real HTTP status (401 bad key, 404 unknown model, 429 rate
    // limit, 529 overloaded) and surface a short, actionable message.
    let detail = ''
    try {
      const errJson = (await resp.json()) as { error?: { message?: string } }
      detail = errJson?.error?.message || JSON.stringify(errJson)
    } catch {
      detail = await resp.text().catch(() => '')
    }
    const status = resp.status >= 400 && resp.status <= 599 ? resp.status : 502
    throw new AnalyzeError(friendlyAnthropicMessage(status, detail), status)
  }

  const message = (await resp.json()) as { content?: Array<{ type: string; input?: unknown }> }
  const toolUse = message.content?.find((b) => b.type === 'tool_use')
  if (!toolUse || typeof toolUse.input !== 'object' || toolUse.input === null) {
    throw new AnalyzeError('Claude did not return structured output.', 502)
  }

  const data = toolUse.input as AnalyzeResponse
  const validStatuses = new Set(['follows', 'partially', 'violates', 'relevant'])
  const seenPly = new Set<number>()
  const results: MoveResult[] = (data.results || [])
    // only keep results for plies we actually asked about, without duplicates
    .filter((r) => requestedPlies.has(r.ply) && !seenPly.has(r.ply) && (seenPly.add(r.ply), true))
    .map((r) => ({
      ply: r.ply,
      lesson: typeof r.lesson === 'string' ? r.lesson : '',
      rules: (r.rules || []).filter(
        (h: RuleHit) =>
          Number.isInteger(h.id) &&
          h.id >= 1 &&
          h.id <= RULE_COUNT &&
          typeof h.why === 'string' &&
          validStatuses.has(h.status),
      ),
    }))
  return { results }
}
