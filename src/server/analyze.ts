// Server-side analysis: send the game + target moves to Claude Opus and get back,
// for each move, which of the rules of thumb are relevant and how the move
// relates to them. Structured output is obtained via a forced tool call, which
// works across SDK versions and models.
//
// This module is server-only (it imports the Anthropic SDK and reads the API
// key). It must never be imported by browser code.

import { Chess } from 'chess.js'
import { rulesForPrompt, RULE_COUNT, RULES_BY_ID } from '../shared/rules.js'
import { isStudied, stripToolLeak } from '../shared/types.js'
import { summarizeGame, type SummarizableGame } from '../shared/meta.js'
import { cloudConfigured, listCloudGameData } from './games.js'
import type {
  AnalyzeRequest,
  AnalyzeResponse,
  AnnoArrow,
  AnnoColor,
  AnnoSquare,
  AskRequest,
  AskResponse,
  BoardAnnotations,
  Color,
  EngineEval,
  GameMove,
  GameOverview,
  MetaGameSummary,
  MetaInsight,
  MetaRequest,
  MetaResponse,
  OverviewRequest,
  OverviewResponse,
  MoveAlternative,
  MoveResult,
  QuizExplanation,
  QuizResponse,
  QuizRequest,
  RuleHit,
  Soundness,
} from '../shared/types'

export const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8'
/** Cheaper model for routine per-move analysis. Key moments (a meaningful
    engine loss, or no engine check to vouch for the move) stay on MODEL, as
    do the game overview, the cross-game meta report, quiz and ask. */
export const MODEL_FAST = process.env.ANTHROPIC_MODEL_FAST || 'claude-sonnet-5'
/** Bargain-bin model (via OpenRouter) for the NON-studied side's moves —
    context the reader browses past, not the coaching itself. Only used when
    OPENROUTER_API_KEY is configured; without it those moves stay unanalysed. */
export const MODEL_LITE = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash'
export const hasLiteKey = () => !!process.env.OPENROUTER_API_KEY
/** Engine loss (centipawns) from which a move counts as a key moment. */
const KEY_MOVE_CP_LOSS = 60
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

const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.slice(0, n) : '')

/** Parse the FIRST complete JSON value in a string, ignoring trailing junk
    (models that double-encode tool arrays sometimes leak an extra brace after
    the closing bracket). Null when nothing parseable is found. */
function parseJsonPrefix(s: string): unknown {
  const str = s.trim()
  const start = str.search(/[[{]/)
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < str.length; i++) {
    const c = str[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
    } else if (c === '"') inStr = true
    else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(str.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}
const intOr = (v: unknown, d: number) => (Number.isFinite(v) ? Math.trunc(v as number) : d)
/** Every model-written prose field goes through this: leak-strip, then clip. */
const cleanClip = (s: unknown, n: number) => clip(stripToolLeak(s), n)

/**
 * When tool-call syntax leaks into a prose field, the graphics the model meant
 * to attach often ride along as literal JSON ("…<parameter name=\"graphics\">
 * {\"arrows\":[…]}"). Rescue that object so the drawing isn't lost — it still
 * passes through sanitizeGraphics like any other input.
 */
function leakedGraphics(s: unknown): unknown {
  if (typeof s !== 'string') return undefined
  const at = s.indexOf('name="graphics"')
  if (at === -1) return undefined
  const start = s.indexOf('{', at)
  if (start === -1) return undefined
  let depth = 0
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}' && --depth === 0) {
      try {
        return JSON.parse(s.slice(start, i + 1))
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

/** Resolve the API key from the request or the environment, or throw 401. */
function resolveKey(input: { apiKey?: string }): string {
  const apiKey = (input.apiKey && input.apiKey.trim()) || process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new AnalyzeError(
      'No Anthropic API key available. Set ANTHROPIC_API_KEY on the server, or add your own key in Settings.',
      401,
    )
  }
  return apiKey
}

function sanitizeGame(game: unknown): GameMove[] {
  if (!Array.isArray(game)) return []
  return game.slice(0, MAX_GAME_PLIES).map((m) => ({
    ply: intOr(m?.ply, 0),
    moveNumber: intOr(m?.moveNumber, 0),
    color: m?.color === 'b' ? ('b' as const) : ('w' as const),
    san: clip(m?.san, 12),
  }))
}

function moveTextOf(game: GameMove[]): string {
  return game
    .map((m) => (m.color === 'w' ? `${m.moveNumber}. ${m.san}` : `${m.moveNumber}... ${m.san}`))
    .join('  ')
}

/** Validate a client-supplied engine principal variation (SAN list): every
    token must look like a SAN move (no whitespace, nothing to break out of
    its prompt line), and the list is cut at the first invalid entry so
    non-adjacent moves can't be spliced into a fake continuation. */
const SAN_TOKEN_RE = /^(O-O(-O)?|[KQRNB]?[a-h]?[1-8]?x?[a-h][1-8](=[QRNB])?)[+#]?$/
function sanitizePv(pv: unknown): string[] | undefined {
  if (!Array.isArray(pv)) return undefined
  const clean: string[] = []
  for (const s of pv.slice(0, 10)) {
    if (typeof s !== 'string' || !SAN_TOKEN_RE.test(s)) break
    clean.push(s)
  }
  return clean.length > 1 ? clean : undefined
}

// The rule reference is identical on every request and every mode, so it is the
// cached prompt prefix — repeat calls (analyse / quiz / ask) all reuse it cheaply.
const RULES_REFERENCE = `You are a sharp, practical chess coach for club players (beginner to intermediate). You reason using ${RULE_COUNT} strategic "rules of thumb", numbered 1-${RULE_COUNT}, grouped by theme (opening/development, trades, minor pieces, rooks and files, the center and pawn breaks, weaknesses, king safety and attacking, and endgames).

YOUR VOICE — you teach, you never scold. This applies to everything you write, in every mode:
- Diagnose the DECISION, never the person. Banned: character judgments and loaded words like "carelessly", "lazily", "hemorrhaging", "threw away", "never controlled", "simply lost". Instead use neutral, precise verbs: "lost material", "allowed", "missed", "underestimated".
- Every criticism carries its lesson: name the mechanism (what was missed and why it mattered) and the habit that prevents it ("before recapturing, count the forcing sequence to the end"). A sentence that only assigns blame teaches nothing — rewrite it as what to do next time.
- When one side is under study, speak TO that player as "you" ("you built a strong centre, but the knight on f4 was left undefended"), not about "White/Black he/she".
- Stay honest and concrete — a mistake is a mistake and sugar-coating doesn't teach either. The test: after reading, the player should know exactly what to work on and want to play the next game.

The ${RULE_COUNT} rules:
${rulesForPrompt()}`

function systemWith(task: string) {
  return [
    { type: 'text', text: RULES_REFERENCE, cache_control: { type: 'ephemeral' as const } },
    { type: 'text', text: task },
  ]
}

interface ClaudeOpts {
  maxTokens: number
  tool?: unknown
  toolName?: string
  /** wall-clock allowance for the Anthropic call (default 55s; long-form
      reports like the cross-game meta need several minutes of generation) */
  timeoutMs?: number
  /** override the model for this call (default MODEL) */
  model?: string
}

/** Single place that calls the Anthropic Messages API over HTTP and maps errors. */
async function callClaude(
  apiKey: string,
  system: unknown,
  user: string | Array<{ role: 'user' | 'assistant'; content: string }>,
  opts: ClaudeOpts,
): Promise<unknown> {
  const messages = typeof user === 'string' ? [{ role: 'user', content: user }] : user
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
        model: opts.model ?? MODEL,
        max_tokens: opts.maxTokens,
        system,
        messages,
        ...(opts.tool ? { tools: [opts.tool], tool_choice: { type: 'tool', name: opts.toolName } } : {}),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 55_000),
    })
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    throw new AnalyzeError(
      timedOut
        ? 'The Anthropic request timed out. Try again in a moment.'
        : 'Could not reach the Anthropic API. Please try again shortly.',
      timedOut ? 504 : 502,
    )
  }
  if (!resp.ok) {
    let detail = ''
    try {
      const j = (await resp.json()) as { error?: { message?: string } }
      detail = j?.error?.message || JSON.stringify(j)
    } catch {
      detail = await resp.text().catch(() => '')
    }
    const status = resp.status >= 400 && resp.status <= 599 ? resp.status : 502
    throw new AnalyzeError(friendlyAnthropicMessage(status, detail), status)
  }
  const message = (await resp.json()) as {
    content?: Array<{ type: string; input?: unknown; text?: string }>
    stop_reason?: string
  }
  if (opts.tool) {
    // A response cut off by max_tokens carries a PARTIAL tool input — early
    // fields present, the rest silently missing. Fail loudly instead of
    // returning a half-report that renders as mysteriously truncated output.
    if (message.stop_reason === 'max_tokens') {
      throw new AnalyzeError('The answer ran out of room mid-way. Please try again.', 502)
    }
    const toolUse = message.content?.find((b) => b.type === 'tool_use')
    if (!toolUse || typeof toolUse.input !== 'object' || toolUse.input === null) {
      throw new AnalyzeError('Claude did not return structured output.', 502)
    }
    return toolUse.input
  }
  const textBlock = message.content?.find((b) => b.type === 'text')
  return typeof textBlock?.text === 'string' ? textBlock.text : ''
}

/** OpenRouter (OpenAI-compatible) twin of callClaude, for the lite tier.
    Takes the same system blocks + forced-tool contract and returns the parsed
    tool input, so callers can swap providers per target group. */
async function callOpenRouter(
  system: unknown,
  user: string,
  opts: {
    maxTokens: number
    tool: { name: string; description: string; input_schema: unknown }
    timeoutMs?: number
  },
): Promise<unknown> {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new AnalyzeError('No OpenRouter API key configured on the server.', 401)
  // our system prompt is Anthropic-style text blocks — flatten to one string
  const sysText = Array.isArray(system)
    ? system
        .map((b) => (b && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
        .join('\n\n')
    : String(system)
  let resp: Response
  try {
    resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL_LITE,
        max_tokens: opts.maxTokens,
        messages: [
          { role: 'system', content: sysText },
          { role: 'user', content: user },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: opts.tool.name,
              description: opts.tool.description,
              parameters: opts.tool.input_schema,
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: opts.tool.name } },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 55_000),
    })
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    throw new AnalyzeError(
      timedOut
        ? 'The OpenRouter request timed out. Try again in a moment.'
        : 'Could not reach OpenRouter. Please try again shortly.',
      timedOut ? 504 : 502,
    )
  }
  if (!resp.ok) {
    let detail = ''
    try {
      const j = (await resp.json()) as { error?: { message?: string } }
      detail = j?.error?.message || JSON.stringify(j)
    } catch {
      detail = await resp.text().catch(() => '')
    }
    const status = resp.status >= 400 && resp.status <= 599 ? resp.status : 502
    throw new AnalyzeError(`OpenRouter error (${status}): ${clip(detail, 200)}`, status)
  }
  const msg = (await resp.json()) as {
    choices?: Array<{
      message?: { content?: unknown; tool_calls?: Array<{ function?: { arguments?: unknown } }> }
    }>
  }
  const choice = msg.choices?.[0]?.message
  let raw = choice?.tool_calls?.[0]?.function?.arguments
  if (typeof raw !== 'string' || !raw.trim()) {
    // some models put the JSON in content despite a forced tool choice
    const content = typeof choice?.content === 'string' ? choice.content : ''
    const m = content.match(/\{[\s\S]*\}/)
    raw = m?.[0]
  }
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new AnalyzeError('The lite model did not return structured output.', 502)
  }
  try {
    return JSON.parse(raw)
  } catch {
    // same double-encoding tolerance as the Claude path: recover the first
    // complete JSON value when the arguments carry trailing junk
    const p = parseJsonPrefix(raw)
    if (p && typeof p === 'object') return p
    throw new AnalyzeError('The lite model returned unreadable output.', 502)
  }
}

// ---- Board graphics (shared by the analyse and ask schemas) ----

const ANNO_COLORS: AnnoColor[] = ['green', 'red', 'yellow', 'blue']
const SQUARE_RE = /^[a-h][1-8]$/
const MAX_ANNO_SQUARES = 8
const MAX_ANNO_ARROWS = 6

function graphicsSchema(description: string) {
  return {
    type: 'object',
    additionalProperties: false,
    description,
    properties: {
      squares: {
        type: 'array',
        description: `Squares to tint (max ${MAX_ANNO_SQUARES}).`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            square: { type: 'string', description: 'A square in algebraic notation, e.g. "e4".' },
            color: { type: 'string', enum: ANNO_COLORS },
          },
          required: ['square', 'color'],
        },
      },
      arrows: {
        type: 'array',
        description: `Arrows to draw, from square to square (max ${MAX_ANNO_ARROWS}). Several arrows are fine when the explanation needs them — a manoeuvre, converging attackers, competing plans.`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            from: { type: 'string', description: 'Start square, e.g. "g1".' },
            to: { type: 'string', description: 'End square, e.g. "f3".' },
            color: { type: 'string', enum: ANNO_COLORS },
          },
          required: ['from', 'to', 'color'],
        },
      },
    },
  }
}

/** Shared colour legend, kept identical across prompts so graphics mean the same thing everywhere. */
const GRAPHICS_LEGEND =
  'Colours: green = good squares / strong moves, red = weaknesses / hanging pieces / danger, yellow = key squares, files or diagonals to watch, blue = plans and manoeuvres.'

/** Keep only well-formed squares/arrows; never trust the model's geometry blindly. */
function sanitizeGraphics(g: unknown): BoardAnnotations | undefined {
  if (!g || typeof g !== 'object') return undefined
  const raw = g as { squares?: unknown; arrows?: unknown }
  const squares: AnnoSquare[] = []
  const seenSq = new Set<string>()
  for (const s of Array.isArray(raw.squares) ? raw.squares : []) {
    const sq = s as { square?: unknown; color?: unknown }
    if (typeof sq.square !== 'string' || !SQUARE_RE.test(sq.square)) continue
    if (!ANNO_COLORS.includes(sq.color as AnnoColor) || seenSq.has(sq.square)) continue
    seenSq.add(sq.square)
    squares.push({ square: sq.square, color: sq.color as AnnoColor })
    if (squares.length >= MAX_ANNO_SQUARES) break
  }
  const arrows: AnnoArrow[] = []
  const seenAr = new Set<string>()
  for (const a of Array.isArray(raw.arrows) ? raw.arrows : []) {
    const ar = a as { from?: unknown; to?: unknown; color?: unknown }
    if (typeof ar.from !== 'string' || !SQUARE_RE.test(ar.from)) continue
    if (typeof ar.to !== 'string' || !SQUARE_RE.test(ar.to) || ar.to === ar.from) continue
    if (!ANNO_COLORS.includes(ar.color as AnnoColor) || seenAr.has(ar.from + ar.to)) continue
    seenAr.add(ar.from + ar.to)
    arrows.push({ from: ar.from, to: ar.to, color: ar.color as AnnoColor })
    if (arrows.length >= MAX_ANNO_ARROWS) break
  }
  if (!squares.length && !arrows.length) return undefined
  const out: BoardAnnotations = {}
  if (squares.length) out.squares = squares
  if (arrows.length) out.arrows = arrows
  return out
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
                      'How the move relates to the rule. Use "follows" when it clearly upholds it, "partially" when it partly does, and "violates" whenever the move goes AGAINST the rule — do NOT soft-label a violation as "relevant". Reserve "relevant" for when the rule is genuinely in play but the move is neutral toward it (neither clearly following nor breaking it).',
                  },
                  why: {
                    type: 'string',
                    description: 'One plain-language sentence explaining the relevance for a club player.',
                  },
                  relevance: {
                    type: 'integer',
                    description:
                      'How central this rule is to THIS move, 1-5: 5 = the key idea of the move, 3 = clearly in play, 1 = worth a passing mention.',
                  },
                  graphics: graphicsSchema(
                    "OPTIONAL board graphics that SHOW this rule's point in the resulting position: tint the weak square, arrow the open file, mark the exposed king. Only when it genuinely illustrates the idea — accuracy over decoration.",
                  ),
                },
                required: ['id', 'status', 'why', 'relevance'],
              },
            },
            lesson: {
              type: 'string',
              description:
                'One decisive practical lesson for this move (1-2 sentences). Be direct and concrete.',
            },
            soundness: {
              type: 'string',
              enum: ['sound', 'speculative', 'dubious'],
              description:
                'Heuristic judgment of the move itself (not an engine score): "sound" = principled and low-risk; "speculative" = ambitious/double-edged (e.g. an attacking sacrifice that may or may not be fully correct); "dubious" = looks objectively risky or likely inferior.',
            },
            alternative: {
              type: 'object',
              additionalProperties: false,
              properties: {
                move: { type: 'string', description: 'A concrete alternative move in SAN, e.g. "Nf3".' },
                why: { type: 'string', description: 'One short line on why it follows the principle more cleanly.' },
              },
              required: ['move', 'why'],
              description:
                'ONLY when the played move breaks or only partly follows a key principle: one cleaner alternative move for the same side. Omit entirely if the move is already good.',
            },
          },
          required: ['ply', 'rules', 'lesson', 'soundness'],
        },
      },
    },
    required: ['results'],
  },
}

export async function runAnalyze(input: AnalyzeRequest): Promise<AnalyzeResponse> {
  const apiKey = resolveKey(input)
  if (input.focus !== 'w' && input.focus !== 'b' && input.focus !== 'both') {
    throw new AnalyzeError('focus must be "w", "b", or "both".')
  }
  if (!Array.isArray(input.game) || !Array.isArray(input.targets)) {
    throw new AnalyzeError('Malformed request: game and targets are required.')
  }
  // de-duplicate targets by ply, cap the count, and clamp per-field string sizes.
  const seen = new Set<number>()
  const targets = input.targets
    .filter((t) => {
      if (!t || typeof t.ply !== 'number' || seen.has(t.ply)) return false
      seen.add(t.ply)
      return true
    })
    .map((t) => {
      const out: { ply: number; fenAfter: string; engine?: EngineEval } = {
        ply: intOr(t.ply, 0),
        fenAfter: clip(t.fenAfter, 100),
      }
      // optional client-computed Stockfish check — validate every field
      const e = t.engine
      if (
        e &&
        typeof e.bestSan === 'string' &&
        Number.isFinite(e.evalBest) &&
        Number.isFinite(e.evalPlayed) &&
        Number.isFinite(e.cpLoss)
      ) {
        out.engine = {
          bestSan: clip(e.bestSan, 12),
          evalBest: Math.trunc(e.evalBest),
          evalPlayed: Math.trunc(e.evalPlayed),
          cpLoss: Math.max(0, Math.trunc(e.cpLoss)),
          isBest: e.isBest === true,
          depth: intOr(e.depth, 0),
        }
        const pv = sanitizePv(e.pv)
        if (pv) out.engine.pv = pv
      }
      return out
    })
  if (targets.length === 0) return { results: [] }
  if (targets.length > MAX_TARGETS) {
    throw new AnalyzeError(`Too many moves in one request (max ${MAX_TARGETS}).`)
  }
  const requestedPlies = new Set(targets.map((t) => t.ply))
  const game = sanitizeGame(input.game)

  const both = input.focus === 'both'
  const sideName = input.focus === 'w' ? 'White' : input.focus === 'b' ? 'Black' : 'each side'
  const moveText = moveTextOf(game)

  const byPly = new Map(game.map((m) => [m.ply, m]))
  const pawns = (cp: number) => (cp / 100).toFixed(2)
  const targetLinesOf = (ts: typeof targets) =>
    ts
      .map((t) => {
        const m = byPly.get(t.ply)
        const label = m ? `${m.moveNumber}${m.color === 'w' ? '.' : '...'} ${m.san}` : `ply ${t.ply}`
        const mover = m ? (m.color === 'w' ? 'White' : 'Black') : sideName
        let line = `- ply ${t.ply}: ${mover}'s move ${label}. Resulting position (FEN): ${t.fenAfter}`
        if (t.engine) {
          const e = t.engine
          line += e.isBest
            ? `\n  Engine check (Stockfish): the played move IS the engine's top choice (eval ${pawns(e.evalPlayed)}).`
            : `\n  Engine check (Stockfish): best was ${e.bestSan} (eval ${pawns(e.evalBest)}); the played move evaluates ${pawns(e.evalPlayed)} — it gives up ${pawns(e.cpLoss)} pawns vs best.`
          if (e.pv && e.pv.length > 1) {
            line += `\n  Engine's expected line from the position BEFORE the move: ${e.pv.join(' ')} — ground any claim about what the recommendation leads to in this line.`
          }
        }
        return line
      })
      .join('\n')

  const system = systemWith(`Analyse the requested move(s) and report using the report_relevance tool. ${
    both
      ? 'Both sides are under study: analyse EACH move strictly from the perspective of the side that played it.'
      : `Analyse strictly from ${sideName}'s perspective — the reader IS the ${sideName} player, so address them as "you".`
  }

Return one result object for EVERY ply listed — never skip a move. When genuinely no rule stands out for a quiet move, return an empty "rules" array but STILL write a real "lesson": one concrete observation about what the move does, keeps flexible, or should keep an eye on. An empty lesson is never acceptable.
For each move, decide which rules are genuinely relevant (usually 1-4; do not force irrelevant ones) and pick rules that fit this move and phase of the game (opening/development rules early, endgame rules once queens or most pieces are gone).
Set each rule's status honestly:
- "follows": clearly upholds the rule.
- "partially": partly upholds it, with a trade-off.
- "violates": goes AGAINST the rule — use this whenever the move breaks the principle; do NOT soft-label a violation as "relevant".
- "relevant": the rule is in play but the move is genuinely neutral toward it.
Give one clear sentence per rule, and score each rule's "relevance" 1-5 (5 = the key idea of this move, 1 = passing mention) — the app sorts by it, so the score should reflect how much this rule explains THE move.
When a rule's point can be SHOWN on the board, add "graphics" to that rule — tinted squares and arrows in the RESULTING position (the FEN given). ${GRAPHICS_LEGEND} Point at concrete things: the hole a pawn move created, the file a rook now owns, the piece left hanging, the manoeuvre the move starts. Use several arrows when the explanation warrants it (a knight's route, converging attackers). Derive every square from the FEN — a wrong square is worse than no graphics — and omit "graphics" when nothing visual would help. Also judge the MOVE ITSELF with a heuristic "soundness" (sound / speculative / dubious) — do not pretend a risky sacrifice is simply sound. When the move breaks or only partly follows a key principle, add one "alternative" (a cleaner SAN move + one-line why); omit it when the move is already good. Give one "lesson" (1-2 sentences) the player can carry into the next game — the takeaway habit, not a verdict; the app carries the not-gospel disclaimer, so be clear without hedging.

Some moves come with an "Engine check" (Stockfish evaluation). Treat it as ground truth for move QUALITY and calibrate accordingly:
- If the played move is the engine's top choice or within ~0.3 pawns of best, its soundness is "sound" (or "speculative" only if it is a genuine sacrifice) — do NOT call it dubious, and do not scold it for breaking a rule of thumb; instead explain why the concrete move justifies the exception.
- If the engine shows a loss of ~1.5 pawns or more, be honest that the move was an error even if it looks principled, and prefer the engine's best move as your "alternative" when it also fits the principle you cite.
- Rule statuses (follows/violates) still describe the PRINCIPLE, which is fine — a best move can still "violate" a rule of thumb; the lesson should then teach when the exception applies.
- GROUND every square-level claim in the FEN: before saying a square is protected, safe, or controlled, verify from the FEN which pieces actually attack and defend it. If the engine's best move can simply be captured, it is a SACRIFICE line — say so and name the concrete follow-up (check the position!) instead of inventing positional cover for it; if you cannot see the compensation, give your own principled alternative and mention the engine move only as "the engine's tactical suggestion". A confidently wrong claim about the board is the worst mistake you can make.`)

  const userOf = (ts: typeof targets, label = `${sideName} `) => `Full game in SAN:
${moveText}

Analyse the following ${label}move(s); return exactly one result object per ply listed:
${targetLinesOf(ts)}`

  // The NON-studied side's moves are context, not coaching — they go to the
  // bargain lite model (OpenRouter) when a key for it is configured, and are
  // simply dropped when not. Everything the reader actually studies stays on
  // the Claude tiers below.
  const isLite = (t: (typeof targets)[number]) => {
    const m = byPly.get(t.ply)
    return !!m && !isStudied(m.color, input.focus)
  }
  const liteTargets = hasLiteKey() ? targets.filter(isLite) : []
  const claudeTargets = targets.filter((t) => !isLite(t))

  // Model tiering (engine-gated): moves the engine vouches for (its top choice,
  // or a small loss) are routine and go to the cheaper model; key moments — a
  // meaningful engine loss, or no engine check at all — get the strong model.
  const isKey = (t: (typeof targets)[number]) =>
    !t.engine || (!t.engine.isBest && t.engine.cpLoss >= KEY_MOVE_CP_LOSS)
  const groups = [
    { targets: claudeTargets.filter(isKey), model: MODEL },
    { targets: claudeTargets.filter((t) => !isKey(t)), model: MODEL_FAST },
  ].filter((g) => g.targets.length > 0)

  const liteSystem = systemWith(`Analyse the requested move(s) and report using the report_relevance tool. These are moves by the reader's OPPONENT — the reader plays ${sideName}. For each move explain its IDEA plainly: what it does, threatens or concedes, which rules it relates to, and what the ${sideName} player should notice or answer. Address the reader as "you" (the ${sideName} player) — e.g. "this pins your knight". Keep it brief: 1-3 genuinely relevant rules with one clear sentence each and a relevance score, an honest "soundness" for the move, and a one-line "lesson" about what the reader should watch for. Return one result for EVERY ply listed — a quiet move still gets a real lesson (never empty), with an empty rules array if nothing stands out. Add an "alternative" only when the opponent clearly missed something instructive. Ground every square-level claim in the given FEN; skip "graphics" unless a single arrow or square makes the idea obvious.`)

  // The model sometimes DOUBLE-ENCODES the tool input: "results" arrives as a
  // JSON string instead of an array — sometimes with trailing junk after the
  // closing bracket (a leaked brace). Silently treating that as no results is
  // exactly the blank-card disease — recover the first complete JSON value.
  const resultsOf = (p: unknown): MoveResult[] => {
    const r = (p as { results?: unknown })?.results
    if (Array.isArray(r)) return r as MoveResult[]
    if (typeof r === 'string') {
      const parsed = parseJsonPrefix(r)
      return Array.isArray(parsed) ? (parsed as MoveResult[]) : []
    }
    return []
  }
  const parts = (await Promise.all([
    ...groups.map((g) =>
      callClaude(apiKey, system, userOf(g.targets), {
        maxTokens: 8000,
        tool: OUTPUT_TOOL,
        toolName: 'report_relevance',
        model: g.model,
      }),
    ),
    // Best-effort: a lite-provider failure must never sink the Claude results.
    // The lite model is per-request unreliable at forced tool calls (empty or
    // unreadable output on a meaningful fraction of calls, regardless of
    // batch size) — give it a few attempts before conceding.
    ...(liteTargets.length
      ? [
          (async (): Promise<AnalyzeResponse> => {
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const out = (await callOpenRouter(liteSystem, userOf(liteTargets, 'opponent '), {
                  maxTokens: 6000,
                  tool: OUTPUT_TOOL as { name: string; description: string; input_schema: unknown },
                })) as AnalyzeResponse
                if (resultsOf(out).length > 0) return out
              } catch (e) {
                console.error('[analyze] lite attempt failed:', e)
              }
            }
            return { results: [] }
          })(),
        ]
      : []),
  ])) as AnalyzeResponse[]
  const data: AnalyzeResponse = { results: parts.flatMap(resultsOf) }
  const validStatuses = new Set(['follows', 'partially', 'violates', 'relevant'])
  const validSoundness = new Set(['sound', 'speculative', 'dubious'])
  const seenPly = new Set<number>()
  const plyOf = (v: unknown): number => {
    const n = typeof v === 'string' ? Number(v.trim()) : (v as number)
    return Number.isFinite(n) ? Math.trunc(n) : -1
  }
  const results: MoveResult[] = (data.results || [])
    // Models occasionally emit ply as a STRING ("37"); the strict Set filter
    // then silently dropped the whole result and the move rendered as a blank
    // card. Coerce before matching.
    .map((r) => ({ ...r, ply: plyOf((r as { ply?: unknown }).ply) }))
    // only keep results for plies we actually asked about, without duplicates
    .filter((r) => requestedPlies.has(r.ply) && !seenPly.has(r.ply) && (seenPly.add(r.ply), true))
    .map((r) => {
      const rawRules: unknown = r.rules
      const ruleArr: RuleHit[] = Array.isArray(rawRules)
        ? rawRules
        : typeof rawRules === 'string'
          ? ((): RuleHit[] => {
              const p = parseJsonPrefix(rawRules)
              return Array.isArray(p) ? (p as RuleHit[]) : []
            })()
          : []
      const out: MoveResult = {
        ply: r.ply,
        lesson: stripToolLeak(r.lesson),
        rules: ruleArr
          .filter(
            (h: RuleHit) =>
              Number.isInteger(h.id) &&
              h.id >= 1 &&
              h.id <= RULE_COUNT &&
              typeof h.why === 'string' &&
              validStatuses.has(h.status),
          )
          .map((h: RuleHit) => {
            const hit: RuleHit = {
              id: h.id,
              status: h.status,
              why: stripToolLeak(h.why),
              relevance: Math.min(5, Math.max(1, intOr(h.relevance, 3))),
            }
            // graphics may arrive structured, or embedded in a why-leak
            const gfx = sanitizeGraphics(
              (h as { graphics?: unknown }).graphics ?? leakedGraphics(h.why),
            )
            if (gfx) hit.graphics = gfx
            return hit
          })
          // most important first (stable, so the model's order breaks ties)
          .sort((a: RuleHit, b: RuleHit) => (b.relevance ?? 3) - (a.relevance ?? 3)),
      }
      if (typeof r.soundness === 'string' && validSoundness.has(r.soundness)) {
        out.soundness = r.soundness as Soundness
      }
      const alt = r.alternative as MoveAlternative | undefined
      if (alt && typeof alt.move === 'string' && alt.move.trim() && typeof alt.why === 'string') {
        out.alternative = { move: clip(alt.move, 16), why: cleanClip(alt.why, 240) }
      }
      return out
    })
  return { results }
}

// ---- Quiz mode (guess the move) ----
// The client runs the quiz itself (board input, engine grading, retries);
// the server's one job is the coaching explanation once a position is done.

/** Parse a move (SAN or coordinate notation) against a FEN; returns canonical SAN or null. */
function legalSan(fen: string, move: string): string | null {
  if (!move) return null
  try {
    const mv = new Chess(fen).move(move, { strict: false })
    return mv ? mv.san : null
  } catch {
    return null
  }
}

const QUIZ_TOOL = {
  name: 'explain_quiz_move',
  description: 'Return the coaching explanation for one guess-the-move position.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      whyPlayed: {
        type: 'string',
        description:
          '2-4 sentences on the move PLAYED in the game: name it, give the concrete mechanism of why it fell short (what it allowed, missed or gave up — not just a judgment), and the habit that would catch it next time. Cite a rule number where natural (e.g. "rule 17").',
      },
      whyBest: {
        type: 'string',
        description:
          "2-4 sentences on the engine's move: what it concretely achieves, grounding every claim about what happens next in the engine continuation when one is given. End with the transferable idea to look for in positions like this.",
      },
      attemptNotes: {
        type: 'array',
        description:
          'Exactly one entry per listed quiz try: one sentence on why that specific move is inferior here. Omit when no tries are listed.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            san: { type: 'string', description: 'The tried move, exactly as listed.' },
            note: { type: 'string', description: 'One concrete sentence on this try.' },
          },
          required: ['san', 'note'],
        },
      },
    },
    required: ['whyPlayed', 'whyBest'],
  },
}

export async function runQuiz(input: QuizRequest): Promise<QuizResponse> {
  const apiKey = resolveKey(input)
  const game = sanitizeGame(input.game)
  if (game.length === 0) throw new AnalyzeError('A game is required.')
  // normalise whitespace so a crafted FEN can't smuggle its own prompt lines
  const fen = clip(input.fenBefore, 100).replace(/\s+/g, ' ').trim()
  const played = legalSan(fen, clip(input.played?.san, 12))
  const best = legalSan(fen, clip(input.best?.san, 12))
  if (!played || !best) {
    throw new AnalyzeError('A valid position with the played and best moves is required.')
  }
  const ply = intOr(input.ply, -1)
  const mv = game.find((m) => m.ply === ply)
  const moverName = fen.split(' ')[1] === 'b' ? 'Black' : 'White'
  const label = mv ? `${mv.moveNumber}${mv.color === 'w' ? '.' : '…'} ${mv.san}` : played
  const pawns = (cp: number) => (cp / 100).toFixed(1)
  const playedLoss = Math.max(0, intOr(input.played?.cpLoss, 0))

  // The player's quiz tries: legality-checked against the position, the best
  // move excluded (it needs no "why was this inferior" note).
  const tries: Array<{ san: string; cpLoss?: number }> = []
  for (const a of Array.isArray(input.attempts) ? input.attempts : []) {
    const san = legalSan(fen, clip(a?.san, 12))
    if (!san || san === best || tries.some((t) => t.san === san)) continue
    const cpLoss = Number.isFinite(a?.cpLoss) ? Math.max(0, Math.trunc(a.cpLoss as number)) : undefined
    tries.push({ san, ...(cpLoss !== undefined ? { cpLoss } : {}) })
    if (tries.length >= 6) break
  }
  const solvedWith = legalSan(fen, clip(input.solvedWith?.san, 12))
  const pv = sanitizePv(input.best?.pv)

  const lines = [
    `Position (FEN, ${moverName} to move): ${fen}`,
    `Played in the game: ${played}${
      playedLoss > 0 ? ` — Stockfish: it gave up about ${pawns(playedLoss)} pawns vs the best move` : ''
    }.`,
    `Engine best move: ${best}.`,
  ]
  if (pv) {
    lines.push(
      `Engine's expected line from this position (it BEGINS with the best move itself): ${pv.join(' ')} — treat this line as ground truth for what happens next; do not invent a different continuation.`,
    )
  }
  if (tries.length) {
    lines.push(
      `Moves the player tried in the quiz before finishing (in order): ${tries
        .map((t) => t.san + (t.cpLoss !== undefined ? ` (≈${pawns(t.cpLoss)} pawns below best)` : ''))
        .join(', ')}.`,
    )
  }
  // Only relay the "equally strong" claim when the client sent the grade that
  // backs it — an unverified claim would have the coach praising anything.
  const solvedLoss = Number.isFinite(input.solvedWith?.cpLoss)
    ? Math.max(0, Math.trunc(input.solvedWith!.cpLoss as number))
    : undefined
  if (solvedWith && solvedWith !== best && solvedLoss !== undefined && solvedLoss <= 60) {
    lines.push(
      `The player solved it with ${solvedWith}, which Stockfish graded within ${pawns(solvedLoss)} pawns of ${best} — acknowledge their move alongside the engine's in whyBest.`,
    )
  }

  const system = systemWith(`A player is training on the costliest moments of their OWN game: they just tried to find the strongest move in the position below ("guess the move"), and you now explain the moment with the explain_quiz_move tool.
Address the player who had ${moverName} as "you" — they made the game move being discussed.
Verify any claim about a piece or a square against the FEN before writing it. Keep every field tight and concrete; no square brackets, markdown or headings.`)

  const user = `Full game (SAN) for context:
${moveTextOf(game)}

The quizzed moment is ${mv ? `move ${label}` : `ply ${ply}`}.
${lines.join('\n')}

Explain it.`

  const data = (await callClaude(apiKey, system, user, {
    maxTokens: 1200,
    tool: QUIZ_TOOL,
    toolName: 'explain_quiz_move',
  })) as { whyPlayed?: unknown; whyBest?: unknown; attemptNotes?: unknown }

  const whyPlayed = cleanClip(data.whyPlayed, 700).trim()
  const whyBest = cleanClip(data.whyBest, 700).trim()
  if (!whyPlayed || !whyBest) {
    throw new AnalyzeError('Could not generate the explanation. Try again.', 502)
  }
  const explanation: QuizExplanation = { whyPlayed, whyBest }
  const rawNotes = Array.isArray(data.attemptNotes) ? data.attemptNotes : []
  const notedSans = new Set<string>()
  const notes = rawNotes
    .map((n: { san?: unknown; note?: unknown }) => ({
      san: typeof n?.san === 'string' ? clip(n.san, 12) : '',
      note: cleanClip(n?.note, 300).trim(),
    }))
    // one note per LISTED try, nothing invented, nothing repeated
    .filter(
      (n) =>
        n.san &&
        n.note &&
        tries.some((t) => t.san === n.san) &&
        !notedSans.has(n.san) &&
        (notedSans.add(n.san), true),
    )
    .slice(0, 6)
  if (notes.length) explanation.attemptNotes = notes
  return { explanation }
}

// ---- Game overview ----

const OVERVIEW_TOOL = {
  name: 'report_overview',
  description: 'Report a substantial overview of the whole game.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: {
        type: 'string',
        description:
          "4-6 decisive sentences on what decided the game from the studied side's perspective: the concrete cause (name the moves), the turning point, what the player did well, and the one skill to practise.",
      },
      trend: {
        type: 'string',
        description:
          '2-4 sentences on the arc of the game: who stood better in which phase, where the momentum shifted and WHY — anchored to the eval trajectory when one is provided.',
      },
      phases: {
        type: 'string',
        description:
          '3-5 sentences reading the game phase by phase: how the OPENING went (name it if you recognise it, and where theory was left), what the MIDDLEGAME hinged on (plans, pawn structure, king safety), and how the ENDGAME (or the finish) was handled. Cite concrete moves.',
      },
      keyMoments: {
        type: 'array',
        description: '3-6 pivotal moments, in game order — prefer the real eval swings when a trajectory is provided.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ply: { type: 'integer', description: 'The ply of the pivotal move.' },
            title: { type: 'string', description: 'A 2-5 word label, e.g. "The decisive sacrifice".' },
            why: { type: 'string', description: '1-2 lines on why this moment mattered and what should have happened.' },
          },
          required: ['ply', 'title', 'why'],
        },
      },
    },
    required: ['summary', 'trend', 'phases', 'keyMoments'],
  },
}

export async function runOverview(input: OverviewRequest): Promise<OverviewResponse> {
  const apiKey = resolveKey(input)
  const focus = input.focus === 'b' ? 'b' : input.focus === 'both' ? 'both' : 'w'
  const sideName = focus === 'w' ? 'White' : focus === 'b' ? 'Black' : 'both sides'
  const game = sanitizeGame(input.game)
  if (game.length === 0) throw new AnalyzeError('A game is required for an overview.')

  const h = input.headers ?? {}
  const white = clip(h.White, 40) || 'White'
  const black = clip(h.Black, 40) || 'Black'
  const result = clip(h.Result, 8)

  // Ground the overview in the ENGINE's story of the game: the win%
  // trajectory's real swings, computed here from the client's eval sweep.
  // Without this the model narrates from bare SAN and the overview reads
  // thin and speculative.
  const evalLines: string[] = []
  if (input.evals && typeof input.evals === 'object') {
    const byPly = new Map(game.map((g) => [g.ply, g]))
    const pts: Array<{ ply: number; pct: number }> = []
    for (const [k, v] of Object.entries(input.evals)) {
      const ply = Number(k)
      if (!Number.isInteger(ply) || !byPly.has(ply) || !Number.isFinite(v)) continue
      const capped = Math.max(-1000, Math.min(1000, v as number))
      pts.push({ ply, pct: Math.round(50 + 50 * (2 / (1 + Math.exp(-0.00368208 * capped)) - 1)) })
    }
    pts.sort((a, b) => a.ply - b.ply)
    // A PARTIAL trajectory (the sweep still running when the overview was
    // requested) must never be narrated as the whole game — that produced
    // "a stable game, final 50%" for a game that was -6 from move 5.
    const lastGamePly = game[game.length - 1].ply
    const full =
      pts.length >= 4 &&
      pts[pts.length - 1].ply >= lastGamePly - 3 &&
      pts.length >= Math.floor(game.length * 0.7)
    if (pts.length >= 4) {
      const label = (ply: number) => {
        const m = byPly.get(ply)
        return m ? `${m.moveNumber}${m.color === 'w' ? '.' : '...'} ${m.san}` : `ply ${ply}`
      }
      // the significant swings, biggest first, capped — plus start and finish
      const swings: Array<{ ply: number; from: number; to: number }> = []
      for (let i = 1; i < pts.length; i++) {
        const d = pts[i].pct - pts[i - 1].pct
        if (Math.abs(d) >= 12) swings.push({ ply: pts[i].ply, from: pts[i - 1].pct, to: pts[i].pct })
      }
      swings.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from))
      const shown = swings.slice(0, 8).sort((a, b) => a.ply - b.ply)
      evalLines.push(
        `Engine eval trajectory (Stockfish; White's winning chances after the move). Treat this as ground truth for who stood better when — anchor "trend", "phases" and the keyMoments to it and never contradict it:`,
      )
      if (!full) {
        evalLines.push(
          `- NOTE: the trajectory covers only ${pts.length} of ${game.length} positions, up to ${label(pts[pts.length - 1].ply)}. Say NOTHING about the eval of the rest of the game or the final position — judge those from the moves alone.`,
        )
      }
      for (const s of shown) {
        evalLines.push(
          `- after ${label(s.ply)} (ply ${s.ply}): ${s.from}% -> ${s.to}% for White (${s.to - s.from > 0 ? '+' : ''}${s.to - s.from})`,
        )
      }
      if (shown.length === 0) {
        evalLines.push(
          full
            ? '- no swing above 12 percentage points: a stable game — say so.'
            : '- no swing above 12 percentage points within the covered stretch.',
        )
      }
      if (full) evalLines.push(`- final position: ${pts[pts.length - 1].pct}% for White`)
      else evalLines.push(`- latest covered position (${label(pts[pts.length - 1].ply)}): ${pts[pts.length - 1].pct}% for White`)
    }
  }
  const acc = input.accuracy
  const accLine =
    acc && (Number.isFinite(acc.w) || Number.isFinite(acc.b))
      ? `Engine accuracy (chess.com-style): ${[
          Number.isFinite(acc.w) ? `White ${acc.w}%` : '',
          Number.isFinite(acc.b) ? `Black ${acc.b}%` : '',
        ]
          .filter(Boolean)
          .join(', ')}.`
      : ''

  const system = systemWith(`Write a substantial OVERVIEW of the whole game ${sideName === 'both sides' ? 'as a coach reviewing both sides' : `for the player who had ${sideName} — address them as "you"`}, using the report_overview tool. Concrete and instructive — this is the opening word a coach gives before going move by move, and it sets the tone for the whole review. It must feel like the coach actually studied the game: name moves, name squares, name plans.
- "summary": what decided the game and the lesson in it (4-6 sentences). Name the concrete cause (e.g. a loose piece, a king left in the centre, a winning attack), what the player did WELL, and the skill to practise, citing rule numbers where natural. Remember your voice: diagnose decisions, no scolding words.
- "trend": the arc of the game — who stood better in which phase and where the momentum shifted, and why (2-4 sentences). When an eval trajectory is provided, follow it exactly.
- "phases": the game phase by phase (3-5 sentences): the opening (name it if recognisable, where the game left known paths), the middlegame battle (plans, structure, king safety), and the endgame or finish.
- "keyMoments": 3-6 pivotal plies in game order, each with a short title and 1-2 lines on why it mattered and what should have happened. When an eval trajectory is provided, pick the real swings. Use the ply numbers as given (White's first move is ply 0, Black's reply is ply 1, and so on).`)

  const user = `Game: ${white} vs ${black}${result ? ` (result ${result})` : ''}. The side under study: ${sideName}.
Moves (SAN):
${moveTextOf(game)}
${evalLines.length ? `\n${evalLines.join('\n')}\n` : ''}${accLine ? `${accLine}\n` : ''}
Give the overview.`

  const data = (await callClaude(apiKey, system, user, {
    maxTokens: 2500,
    tool: OVERVIEW_TOOL,
    toolName: 'report_overview',
  })) as { summary?: unknown; trend?: unknown; phases?: unknown; keyMoments?: unknown }

  const rawMoments = Array.isArray(data.keyMoments) ? data.keyMoments : []
  const keyMoments = rawMoments
    .filter(
      (m: { ply?: unknown; title?: unknown; why?: unknown }) =>
        m &&
        Number.isInteger(m.ply) &&
        game.some((gm) => gm.ply === m.ply) &&
        typeof m.title === 'string' &&
        typeof m.why === 'string',
    )
    .slice(0, 6)
    .map((m: { ply: number; title: string; why: string }) => ({
      ply: m.ply,
      title: cleanClip(m.title, 60),
      why: cleanClip(m.why, 300),
    }))

  const overview: GameOverview = {
    summary: cleanClip(data.summary, 1400),
    trend: cleanClip(data.trend, 700),
    keyMoments,
  }
  const phases = cleanClip(data.phases, 900)
  if (phases) overview.phases = phases
  if (!overview.summary) throw new AnalyzeError('Claude did not return an overview.', 502)
  return { overview }
}

// ---- Ask mode (free-form question) ----

const ASK_TOOL = {
  name: 'answer_question',
  description: "Answer the user's chess question, optionally pointing at the board.",
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      answer: { type: 'string', description: 'The answer: 2-4 concise, decisive sentences.' },
      graphics: graphicsSchema(
        'OPTIONAL board graphics for the position under discussion (its FEN is in the context). Use them whenever pointing at squares or drawing arrows would make the answer clearer; omit when no specific position is in context.',
      ),
    },
    required: ['answer'],
  },
}

export async function runAsk(input: AskRequest): Promise<AskResponse> {
  const apiKey = resolveKey(input)
  const question = clip(input.question, 500).trim()
  if (!question) throw new AnalyzeError('Please enter a question.')

  const contextLines: string[] = []
  if (input.me === 'w' || input.me === 'b') {
    const name = clip(input.me === 'w' ? input.white : input.black, 40)
    contextLines.push(
      `The person asking IS the ${sideName(input.me)} player${name ? ` (${name})` : ''} in this game. When they say "I", "me" or "my", they mean ${sideName(input.me)}'s moves and position — answer from their side's perspective.`,
    )
  }
  const game = Array.isArray(input.game) ? sanitizeGame(input.game) : []
  if (game.length) {
    contextLines.push(`Game so far (SAN): ${moveTextOf(game)}`)
  }
  if (input.san) {
    // Say WHO played the move under discussion and whether that's the asker —
    // without this the coach mixes up whose move it is judging. No guessing:
    // if the ply isn't in the game we were given, we say nothing about the
    // mover (games can start from a custom position with Black to move, so
    // ply parity is not a safe fallback).
    const m = Number.isInteger(input.ply) ? game.find((g) => g.ply === input.ply) : undefined
    const moverColor: Color | undefined = m?.color
    const label = m ? `${m.moveNumber}${m.color === 'w' ? '.' : '...'} ${m.san}` : clip(input.san, 12)
    const who = moverColor
      ? `, played by ${sideName(moverColor)}${
          input.me === 'w' || input.me === 'b'
            ? input.me === moverColor
              ? ' (the person asking)'
              : " (the asker's opponent)"
            : ''
        }`
      : ''
    contextLines.push(`The move under discussion: ${label}${who}.`)
    if (input.fenBefore) {
      contextLines.push(
        `Position BEFORE that move (FEN — the engine continuation below starts here): ${clip(input.fenBefore, 100)}`,
      )
    }
    if (input.fen) {
      contextLines.push(
        `Position AFTER that move (FEN — note the side to move here is the opponent of the mover): ${clip(input.fen, 100)}`,
      )
    }
  } else if (input.fen) {
    contextLines.push(`The position under discussion (FEN): ${clip(input.fen, 100)}.`)
  }
  // The coaching the app is showing for this move: questions like "why is
  // your suggestion better?" refer to THIS, so the coach must see it.
  const shown = input.analysis
  if (shown && typeof shown === 'object') {
    const bits: string[] = []
    if (typeof shown.soundness === 'string' && ['sound', 'speculative', 'dubious'].includes(shown.soundness)) {
      bits.push(`verdict shown: ${shown.soundness}`)
    }
    const okStatuses = new Set(['follows', 'partially', 'violates', 'relevant'])
    const hits = (Array.isArray(shown.rules) ? shown.rules : [])
      .filter((h) => Number.isInteger(h?.id) && h.id >= 1 && h.id <= RULE_COUNT && okStatuses.has(h?.status))
      .slice(0, 6)
    if (hits.length) {
      bits.push(
        `rules cited: ${hits.map((h) => `#${h.id} ${RULES_BY_ID[h.id]?.title ?? ''} (${h.status})`).join('; ')}`,
      )
    }
    if (typeof shown.lesson === 'string' && shown.lesson.trim()) {
      bits.push(`lesson shown: "${cleanClip(shown.lesson, 300)}"`)
    }
    const alt = shown.alternative
    if (alt && typeof alt.move === 'string' && alt.move.trim()) {
      bits.push(
        `suggested cleaner move: ${clip(alt.move, 12)}${typeof alt.why === 'string' && alt.why.trim() ? ` — "${cleanClip(alt.why, 240)}"` : ''}`,
      )
    }
    const eng = shown.engine
    if (eng && typeof eng.bestSan === 'string' && Number.isFinite(eng.cpLoss)) {
      let engLine =
        eng.isBest === true
          ? `Stockfish check (depth ${intOr(eng.depth, 0)}): the played move IS the engine's top choice`
          : `Stockfish check (depth ${intOr(eng.depth, 0)}): the engine's best was ${clip(eng.bestSan, 12)}; the played move gave up ${(Math.max(0, Math.trunc(eng.cpLoss)) / 100).toFixed(2)} pawns vs it`
      const pv = sanitizePv(eng.pv)
      if (pv) {
        engLine += `. Stockfish's expected continuation from the position BEFORE the move: ${pv.join(' ')}`
      }
      bits.push(engLine)
    }
    if (bits.length) {
      contextLines.push(
        `The app's coaching currently shown for this move — questions about "the suggestion"/"the recommendation" refer to this:\n- ${bits.join('\n- ')}`,
      )
    }
  }
  const rid = input.ruleId
  if (Number.isInteger(rid) && (rid as number) >= 1 && (rid as number) <= RULE_COUNT) {
    const rule = RULES_BY_ID[rid as number]
    if (rule) contextLines.push(`Asked in the context of rule #${rule.id} "${rule.title}" — ${rule.detail}`)
  }
  // Cross-game questions (the "Your play" card): ground the answer in the
  // player's whole analysed history, cloud archive included.
  if (Array.isArray(input.summaries)) {
    const sums = await collectSummaries(input.summaries)
    if (sums.length) {
      contextLines.push(
        `The question is about the player's play ACROSS games — address them as "you". Their analysed game history:\n${sums
          .map(summaryLine)
          .join('\n\n')}`,
      )
    }
  }
  const context = contextLines.length ? `Context:\n${contextLines.join('\n')}\n\n` : ''

  const system = systemWith(`Answer the user's chess question concisely and decisively (2-4 sentences) using the answer_question tool, grounded in the ${RULE_COUNT} rules of thumb above. The user may ask follow-up questions — treat the conversation as one thread about the same position/rule unless they change the subject. Cite relevant rule numbers/titles when helpful. This is heuristic coaching for club players, not engine analysis — be direct but do not overstate certainty, and do not hedge every sentence. If the question is not about chess, briefly say you only help with chess strategy.
When the context says who played the move under discussion and who is asking, keep the perspective straight: "I/me/my" is the asker's side, and judge the move from its mover's point of view.
When the context includes the app's shown coaching, questions about "the suggestion", "the recommendation" or "that move you gave" refer to EXACTLY that — engage with it specifically (you may agree or point out its risks; if the engine's move loses material to a simple capture, call it the engine's tactical/sacrifice idea rather than defending it with invented safety).
When a Stockfish continuation line is provided, treat it as ground truth for what happens next: base concrete claims on that line and cite a move or two from it; never invent a different engine verdict. Note the continuation starts from the position BEFORE the move under discussion (its FEN is provided when available) — its first move replaces the played one when they differ. Verify any square-level claim (attacked, defended, protected, hanging) against the relevant FEN before asserting it.
When the context includes a position (FEN) and showing beats telling, also fill "graphics": tinted squares and arrows on that position. ${GRAPHICS_LEGEND} Several arrows are fine when the answer describes a sequence or manoeuvre. Derive every square from the FEN; omit "graphics" when no position is in context or nothing visual would help.`)

  // Rebuild the thread: earlier exchanges (bounded), then the new question.
  // The shared context rides on the FIRST user turn so the cache-friendly
  // system prefix stays identical across calls.
  const history = (Array.isArray(input.history) ? input.history : [])
    .filter((h) => h && typeof h.q === 'string' && typeof h.a === 'string')
    .slice(-6)
    .map((h) => ({ q: clip(h.q, 500), a: clip(h.a, 1500) }))

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []
  if (history.length) {
    history.forEach((h, i) => {
      messages.push({ role: 'user', content: i === 0 ? `${context}${h.q}` : h.q })
      messages.push({ role: 'assistant', content: h.a })
    })
    messages.push({ role: 'user', content: question })
  } else {
    messages.push({ role: 'user', content: `${context}User question: ${question}` })
  }

  const data = (await callClaude(apiKey, system, messages, {
    maxTokens: 900,
    tool: ASK_TOOL,
    toolName: 'answer_question',
  })) as { answer?: unknown; graphics?: unknown }
  const answer = cleanClip(data.answer, 1500).trim()
  const out: AskResponse = { answer: answer || 'No answer was returned. Please try rephrasing.' }
  // Graphics only make sense against a concrete position the client showed us.
  // They may arrive structured — or embedded in an answer-leak (see cleanClip).
  if (input.fen) {
    const gfx = sanitizeGraphics(data.graphics ?? leakedGraphics(data.answer))
    if (gfx) out.graphics = gfx
  }
  return out
}

// ---- Meta analysis (patterns across ALL analysed games) ----

const META_INSIGHT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'A short, concrete label (3-8 words).' },
    detail: {
      type: 'string',
      description:
        '2-4 sentences: the pattern, the evidence (how many games / which openings), and — for mistakes and priorities — the habit that fixes it. Cite rule numbers like "rule 61".',
    },
    ruleIds: {
      type: 'array',
      items: { type: 'integer' },
      description: `The rules of thumb involved (1-${RULE_COUNT}).`,
    },
    examples: {
      type: 'array',
      maxItems: 2,
      description:
        'Up to 2 concrete moments backing this insight: the game NUMBER exactly as listed (1-based) and the ply from that game\'s lesson lines. The app turns these into links the player can tap to open that exact move.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          game: { type: 'integer', description: 'game number as listed, 1-based' },
          ply: { type: 'integer', description: 'the ply cited in that game\'s lesson lines' },
        },
        required: ['game', 'ply'],
      },
    },
  },
  required: ['title', 'detail'],
}

// The report is generated as TWO parallel Claude calls (style/trends and
// coaching). One call writing every section is thousands of tokens — slow
// enough to brush serverless time limits, and a truncation used to surface as
// a report that silently "stopped" after the first sections.
const META_CORE_TOOL = {
  name: 'report_meta_core',
  description: "Report the style, openings and trends part of the player's cross-game review.",
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      profile: {
        type: 'string',
        description:
          "3-5 sentences: the player's style as the data shows it — attacking or positional, development habits, risk appetite, where in the game they are strongest and weakest, accuracy trend.",
      },
      openings: {
        type: 'string',
        description:
          '2-4 sentences: what they actually play as White and as Black (name the openings from the move sequences), which lines score well or badly for them, and one concrete repertoire suggestion.',
      },
      trends: {
        type: 'array',
        description:
          '2-4 trend observations comparing the MOST RECENT games with the earlier ones: accuracy rising or falling (quote the percentages), recurring mistakes fading or persisting, opening shifts, results. With under ~4 games, return ONE item saying the sample is too small to call a trend yet.',
        items: META_INSIGHT_SCHEMA,
      },
    },
    required: ['profile', 'openings', 'trends'],
  },
}

const META_COACH_TOOL = {
  name: 'report_meta_coaching',
  description: "Report the mistakes, strengths and priorities part of the player's cross-game review.",
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      recurringMistakes: {
        type: 'array',
        description: '3-5 patterns that repeat ACROSS games — not one-offs.',
        items: META_INSIGHT_SCHEMA,
      },
      strengths: {
        type: 'array',
        description: '2-4 things they consistently do well, worth keeping on purpose.',
        items: META_INSIGHT_SCHEMA,
      },
      priorities: {
        type: 'array',
        description:
          'EXACTLY 3 training priorities, most impactful first — each a concrete habit or drill tied to the recurring mistakes.',
        items: META_INSIGHT_SCHEMA,
      },
    },
    required: ['recurringMistakes', 'strengths', 'priorities'],
  },
}

const sideName = (c: Color) => (c === 'w' ? 'White' : 'Black')

function sanitizeSummaries(raw: unknown): MetaGameSummary[] {
  if (!Array.isArray(raw)) return []
  const out: MetaGameSummary[] = []
  for (const s of raw as MetaGameSummary[]) {
    if (!s || typeof s.key !== 'string' || typeof s.opening !== 'string') continue
    const pair = (arr: unknown) =>
      (Array.isArray(arr) ? arr : [])
        .filter((x) => Number.isInteger(x?.id) && x.id >= 1 && x.id <= RULE_COUNT)
        .slice(0, 5)
        .map((x) => ({ id: x.id as number, n: Math.max(1, intOr(x.n, 1)) }))
    const snd = s.soundness ?? { sound: 0, speculative: 0, dubious: 0 }
    const sum: MetaGameSummary = {
      key: clip(s.key, 80),
      white: clip(s.white, 40) || 'White',
      black: clip(s.black, 40) || 'Black',
      focus: s.focus === 'b' || s.focus === 'both' ? s.focus : 'w',
      opening: clip(s.opening, 140),
      analysed: Math.max(0, intOr(s.analysed, 0)),
      ruleBroken: pair(s.ruleBroken),
      ruleFollowed: pair(s.ruleFollowed),
      soundness: {
        sound: Math.max(0, intOr(snd.sound, 0)),
        speculative: Math.max(0, intOr(snd.speculative, 0)),
        dubious: Math.max(0, intOr(snd.dubious, 0)),
      },
      // older clients send plain strings; newer ones send { ply, text }
      lessons: (Array.isArray(s.lessons) ? s.lessons : [])
        .map((l: unknown) =>
          typeof l === 'string'
            ? { text: l }
            : l && typeof (l as { text?: unknown }).text === 'string'
              ? {
                  text: (l as { text: string }).text,
                  ...(Number.isInteger((l as { ply?: unknown }).ply)
                    ? { ply: (l as { ply: number }).ply }
                    : {}),
                }
              : null,
        )
        .filter((l): l is { ply?: number; text: string } => !!l)
        .slice(0, 3)
        .map((l) => ({ ...l, text: cleanClip(l.text, 220) })),
    }
    if (s.me === 'w' || s.me === 'b') sum.me = s.me
    if (typeof s.result === 'string') sum.result = clip(s.result, 8)
    if (typeof s.date === 'string') sum.date = clip(s.date, 12)
    if (Number.isFinite(s.addedAt)) sum.addedAt = s.addedAt
    const e = s.engine
    if (e && Number.isFinite(e.avgCpLoss)) {
      sum.engine = {
        avgCpLoss: Math.max(0, intOr(e.avgCpLoss, 0)),
        worst: Math.max(0, intOr(e.worst, 0)),
        blunders: Math.max(0, intOr(e.blunders, 0)),
        checked: Math.max(0, intOr(e.checked, 0)),
      }
      if (Number.isFinite(e.accuracy)) {
        sum.engine.accuracy = Math.max(0, Math.min(100, Math.round((e.accuracy as number) * 10) / 10))
      }
    }
    out.push(sum)
    if (out.length >= 60) break
  }
  return out
}

function summaryLine(s: MetaGameSummary, i: number): string {
  const who = s.me ? `you were ${sideName(s.me)}` : `studied ${s.focus === 'both' ? 'both sides' : sideName(s.focus as Color)}`
  const rules = (arr: Array<{ id: number; n: number }>) =>
    arr.map((r) => `#${r.id} x${r.n}`).join(', ') || 'none'
  let line = `Game ${i + 1}: ${s.white} vs ${s.black} (${who}${s.result ? `, result ${s.result}` : ''}${s.date ? `, ${s.date}` : ''})
  Opening: ${s.opening}
  Analysed ${s.analysed} of your moves. Soundness: ${s.soundness.sound} sound / ${s.soundness.speculative} speculative / ${s.soundness.dubious} dubious.
  Most-broken rules: ${rules(s.ruleBroken)}. Most-followed: ${rules(s.ruleFollowed)}.`
  if (s.engine) {
    line += `\n  Stockfish: ${s.engine.accuracy != null ? `accuracy ${s.engine.accuracy}%, ` : ''}average loss ${(s.engine.avgCpLoss / 100).toFixed(2)} pawns/move over ${s.engine.checked} checked moves, worst single loss ${(s.engine.worst / 100).toFixed(1)}, blunders (>=1.5): ${s.engine.blunders}.`
  }
  if (s.lessons.length) {
    line += `\n  Lessons from the costliest moves: ${s.lessons
      .map((l) => `${l.ply !== undefined ? `(ply ${l.ply}) ` : ''}"${l.text}"`)
      .join(' | ')}`
  }
  return line
}

/**
 * Client digests + the cloud archive, deduped and sanitized — the data both
 * the meta report and cross-game Ask questions run on. Cloud merge is
 * best-effort: with the database unreachable, the client's games suffice.
 */
async function collectSummaries(raw: unknown): Promise<MetaGameSummary[]> {
  const summaries = sanitizeSummaries(raw)
  try {
    if (cloudConfigured()) {
      const seen = new Set(summaries.map((s) => s.key))
      for (const data of await listCloudGameData()) {
        const g = data as SummarizableGame
        if (!g || typeof g.key !== 'string' || seen.has(g.key)) continue
        if (!g.results || typeof g.results !== 'object') continue
        seen.add(g.key)
        summaries.push(...sanitizeSummaries([summarizeGame(g)]))
        if (summaries.length >= 60) break
      }
    }
  } catch {
    /* cloud unavailable — proceed with what the client sent */
  }
  return summaries.filter((s) => s.analysed > 0)
}

export async function runMeta(input: MetaRequest): Promise<MetaResponse> {
  const apiKey = resolveKey(input)
  const withAnalysis = await collectSummaries(input.summaries)
  if (withAnalysis.length === 0) {
    throw new AnalyzeError('No analysed games to review yet — analyse a game or two first.')
  }

  // Oldest first, so "the last N games" genuinely means the player's most
  // recent play — that ordering is what the trends section reads.
  const stampOf = (s: MetaGameSummary): number => {
    if (s.date && /^\d{4}\.\d{2}\.\d{2}$/.test(s.date)) {
      const t = Date.parse(s.date.replace(/\./g, '-'))
      if (Number.isFinite(t)) return t
    }
    return s.addedAt ?? 0
  }
  withAnalysis.sort((a, b) => stampOf(a) - stampOf(b))
  const recentN =
    withAnalysis.length >= 4 ? Math.min(5, Math.max(2, Math.round(withAnalysis.length / 3))) : 0

  const intro = `You are reviewing this player's WHOLE recent history — ${withAnalysis.length} analysed game(s) — to surface the patterns no single game can show. Address the player as "you" throughout.

Each game summary below was computed from full per-move analysis: the opening moves, which rules of thumb were followed or broken (with counts), a soundness tally, Stockfish accuracy (a chess.com-style accuracy %, average centipawn loss, worst slip, blunder count), and the lessons attached to the costliest moves. "you were White/Black" marks the player's own side — their habits are what you are profiling; ignore the opponent's play except as context. Games are listed OLDEST FIRST.

Each lesson line carries its ply number. When an insight rests on a concrete moment, attach "examples": the game number exactly as listed plus that ply — the app turns them into links the player taps to open that exact move. Only cite plies that appear in the lesson lines.

Ground every claim in the data given — never invent games, moves or numbers. With a small sample (under ~5 games), say so and keep claims proportional. Where the engine data and the rule data disagree, trust the engine for accuracy and the rules for themes.`

  const coreSystem = systemWith(`${intro}

Use the report_meta_core tool. What to produce:
- "profile": their playing style as the DATA shows it — attacking or positional, fast or slow development, material-grabbing or safety-first, where in the game accuracy drops (opening, middlegame, conversions), and the overall trend across games.
- "openings": what they actually play as White and as Black — NAME the openings from the move sequences (e.g. "Italian Game", "Caro-Kann") — which of their lines score well or badly, and one concrete repertoire suggestion.
- "trends": 2-4 observations comparing the MOST RECENT games with the earlier ones: is accuracy rising or falling (quote the percentages), which recurring mistakes are fading and which persist, opening shifts, results. With under ~4 games, return one item saying the sample is too small to call a trend yet — never invent a direction.`)

  const coachSystem = systemWith(`${intro}

Use the report_meta_coaching tool. What to produce:
- "recurringMistakes": 3-5 patterns that appear in SEVERAL games, not one-offs. Each names the mechanism, cites the rules involved by number (e.g. "rule 61"), and states the evidence ("in 4 of 6 games, always in the late middlegame"). Diagnose decisions, never character.
- "strengths": 2-4 things they consistently do well — rules repeatedly followed, phases with low centipawn loss — so they keep doing them on purpose.
- "priorities": exactly 3 training priorities, most impactful first. Each is a concrete habit or drill ("before every recapture, count the forcing sequence to the end"), tied to the recurring mistakes, with rule numbers.`)

  const user = `The player's analysed games, oldest first:

${withAnalysis.map(summaryLine).join('\n\n')}
${recentN ? `\nGames ${withAnalysis.length - recentN + 1}-${withAnalysis.length} are the player's most recent — compare them with the earlier ones for the trends section.\n` : ''}
Write your part of the meta-analysis.`

  // Two parallel calls, each roughly half the output: the wall-clock is the
  // slower call, not the sum, and each stays comfortably inside serverless
  // time limits that a single full-report generation used to brush against.
  const [core, coach] = (await Promise.all([
    callClaude(apiKey, coreSystem, user, {
      maxTokens: 3000,
      timeoutMs: 280_000,
      tool: META_CORE_TOOL,
      toolName: 'report_meta_core',
    }),
    callClaude(apiKey, coachSystem, user, {
      maxTokens: 3500,
      timeoutMs: 280_000,
      tool: META_COACH_TOOL,
      toolName: 'report_meta_coaching',
    }),
  ])) as [
    { profile?: unknown; openings?: unknown; trends?: unknown },
    { recurringMistakes?: unknown; strengths?: unknown; priorities?: unknown },
  ]

  const insights = (raw: unknown, max: number): MetaInsight[] =>
    (Array.isArray(raw) ? raw : [])
      .filter((x) => x && typeof x.title === 'string' && typeof x.detail === 'string')
      .slice(0, max)
      .map((x) => {
        const out: MetaInsight = { title: cleanClip(x.title, 80), detail: cleanClip(x.detail, 600) }
        const ids = (Array.isArray(x.ruleIds) ? x.ruleIds : []).filter(
          (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= RULE_COUNT,
        )
        if (ids.length) out.ruleIds = ids.slice(0, 6)
        // resolve "game N, ply P" citations to tappable game links
        const refs = (Array.isArray(x.examples) ? x.examples : [])
          .map((e: { game?: unknown; ply?: unknown }) => {
            const g = Number.isInteger(e?.game) ? withAnalysis[(e.game as number) - 1] : undefined
            if (!g || !Number.isInteger(e?.ply) || (e.ply as number) < 0) return null
            const ply = e.ply as number
            return {
              key: g.key,
              ply,
              label: `${g.white} vs ${g.black} · move ${Math.floor(ply / 2) + 1}`,
            }
          })
          .filter((r: { key: string; ply: number; label: string } | null): r is { key: string; ply: number; label: string } => !!r)
          .slice(0, 2)
        if (refs.length) out.refs = refs
        return out
      })

  const report = {
    profile: cleanClip(core.profile, 1200),
    openings: cleanClip(core.openings, 900),
    trends: insights(core.trends, 4),
    recurringMistakes: insights(coach.recurringMistakes, 5),
    strengths: insights(coach.strengths, 4),
    priorities: insights(coach.priorities, 3),
  }
  // Never hand back a partial report: a report missing whole sections reads
  // as "it stopped after the openings paragraph" with no visible error.
  if (
    !report.profile ||
    !report.openings ||
    !report.trends.length ||
    !report.recurringMistakes.length ||
    !report.strengths.length ||
    !report.priorities.length
  ) {
    throw new AnalyzeError('The report came back incomplete. Please try regenerating.', 502)
  }
  return { report, gamesUsed: withAnalysis.length }
}
