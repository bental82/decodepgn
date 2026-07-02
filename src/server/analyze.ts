// Server-side analysis: send the game + target moves to Claude Opus and get back,
// for each move, which of the rules of thumb are relevant and how the move
// relates to them. Structured output is obtained via a forced tool call, which
// works across SDK versions and models.
//
// This module is server-only (it imports the Anthropic SDK and reads the API
// key). It must never be imported by browser code.

import { rulesForPrompt, RULE_COUNT, RULES_BY_ID } from '../shared/rules.js'
import type {
  AnalyzeRequest,
  AnalyzeResponse,
  AskRequest,
  AskResponse,
  EngineEval,
  GameMove,
  OverviewRequest,
  OverviewResponse,
  MoveAlternative,
  MoveResult,
  QuizQuestion,
  QuizResponse,
  QuizRequest,
  RuleHit,
  Soundness,
} from '../shared/types'

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

const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.slice(0, n) : '')
const intOr = (v: unknown, d: number) => (Number.isFinite(v) ? Math.trunc(v as number) : d)

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

// The rule reference is identical on every request and every mode, so it is the
// cached prompt prefix — repeat calls (analyse / quiz / ask) all reuse it cheaply.
const RULES_REFERENCE = `You are a sharp, practical chess coach for club players (beginner to intermediate). You reason using ${RULE_COUNT} strategic "rules of thumb", numbered 1-${RULE_COUNT}, grouped by theme (opening/development, trades, minor pieces, rooks and files, the center and pawn breaks, weaknesses, king safety and attacking, and endgames).

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
        model: MODEL,
        max_tokens: opts.maxTokens,
        system,
        messages,
        ...(opts.tool ? { tools: [opts.tool], tool_choice: { type: 'tool', name: opts.toolName } } : {}),
      }),
      signal: AbortSignal.timeout(55_000),
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
  }
  if (opts.tool) {
    const toolUse = message.content?.find((b) => b.type === 'tool_use')
    if (!toolUse || typeof toolUse.input !== 'object' || toolUse.input === null) {
      throw new AnalyzeError('Claude did not return structured output.', 502)
    }
    return toolUse.input
  }
  const textBlock = message.content?.find((b) => b.type === 'text')
  return typeof textBlock?.text === 'string' ? textBlock.text : ''
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
  const targetLines = targets
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
      }
      return line
    })
    .join('\n')

  const system = systemWith(`Analyse the requested move(s) and report using the report_relevance tool. ${
    both
      ? 'Both sides are under study: analyse EACH move strictly from the perspective of the side that played it.'
      : `Analyse strictly from ${sideName}'s perspective.`
  }

For each move, decide which rules are genuinely relevant (usually 1-4; do not force irrelevant ones) and pick rules that fit this move and phase of the game (opening/development rules early, endgame rules once queens or most pieces are gone).
Set each rule's status honestly:
- "follows": clearly upholds the rule.
- "partially": partly upholds it, with a trade-off.
- "violates": goes AGAINST the rule — use this whenever the move breaks the principle; do NOT soft-label a violation as "relevant".
- "relevant": the rule is in play but the move is genuinely neutral toward it.
Give one clear sentence per rule, and score each rule's "relevance" 1-5 (5 = the key idea of this move, 1 = passing mention) — the app sorts by it, so the score should reflect how much this rule explains THE move. Also judge the MOVE ITSELF with a heuristic "soundness" (sound / speculative / dubious) — do not pretend a risky sacrifice is simply sound. When the move breaks or only partly follows a key principle, add one "alternative" (a cleaner SAN move + one-line why); omit it when the move is already good. Give one decisive "lesson" (1-2 sentences); the app carries the not-gospel disclaimer, so be direct.

Some moves come with an "Engine check" (Stockfish evaluation). Treat it as ground truth for move QUALITY and calibrate accordingly:
- If the played move is the engine's top choice or within ~0.3 pawns of best, its soundness is "sound" (or "speculative" only if it is a genuine sacrifice) — do NOT call it dubious, and do not scold it for breaking a rule of thumb; instead explain why the concrete move justifies the exception.
- If the engine shows a loss of ~1.5 pawns or more, be honest that the move was an error even if it looks principled, and prefer the engine's best move as your "alternative" when it also fits the principle you cite.
- Rule statuses (follows/violates) still describe the PRINCIPLE, which is fine — a best move can still "violate" a rule of thumb; the lesson should then teach when the exception applies.`)

  const user = `Full game in SAN:
${moveText}

Analyse the following ${sideName} move(s); return exactly one result object per ply listed:
${targetLines}`

  const data = (await callClaude(apiKey, system, user, {
    maxTokens: 8000,
    tool: OUTPUT_TOOL,
    toolName: 'report_relevance',
  })) as AnalyzeResponse
  const validStatuses = new Set(['follows', 'partially', 'violates', 'relevant'])
  const validSoundness = new Set(['sound', 'speculative', 'dubious'])
  const seenPly = new Set<number>()
  const results: MoveResult[] = (data.results || [])
    // only keep results for plies we actually asked about, without duplicates
    .filter((r) => requestedPlies.has(r.ply) && !seenPly.has(r.ply) && (seenPly.add(r.ply), true))
    .map((r) => {
      const out: MoveResult = {
        ply: r.ply,
        lesson: typeof r.lesson === 'string' ? r.lesson : '',
        rules: (r.rules || [])
          .filter(
            (h: RuleHit) =>
              Number.isInteger(h.id) &&
              h.id >= 1 &&
              h.id <= RULE_COUNT &&
              typeof h.why === 'string' &&
              validStatuses.has(h.status),
          )
          .map((h: RuleHit) => ({
            ...h,
            relevance: Math.min(5, Math.max(1, intOr(h.relevance, 3))),
          }))
          // most important first (stable, so the model's order breaks ties)
          .sort((a: RuleHit, b: RuleHit) => (b.relevance ?? 3) - (a.relevance ?? 3)),
      }
      if (typeof r.soundness === 'string' && validSoundness.has(r.soundness)) {
        out.soundness = r.soundness as Soundness
      }
      const alt = r.alternative as MoveAlternative | undefined
      if (alt && typeof alt.move === 'string' && alt.move.trim() && typeof alt.why === 'string') {
        out.alternative = { move: clip(alt.move, 16), why: clip(alt.why, 240) }
      }
      return out
    })
  return { results }
}

// ---- Quiz mode ----

const QUIZ_TOOL = {
  name: 'make_quiz',
  description: 'Return short multiple-choice quiz questions about the rules of thumb.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      questions: {
        type: 'array',
        description: 'The quiz questions.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            prompt: { type: 'string', description: 'The question text.' },
            options: {
              type: 'array',
              description: '3 to 4 answer options; exactly one has correct=true.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  text: { type: 'string', description: 'A short answer option.' },
                  correct: { type: 'boolean', description: 'True for the single correct option.' },
                },
                required: ['text', 'correct'],
              },
            },
            explanation: { type: 'string', description: 'One line explaining the correct answer.' },
            ruleId: { type: 'integer', description: `Main rule number involved (1-${RULE_COUNT}), if any.` },
            ply: { type: 'integer', description: 'The game ply referenced, if any.' },
          },
          required: ['prompt', 'options', 'explanation'],
        },
      },
    },
    required: ['questions'],
  },
}

export async function runQuiz(input: QuizRequest): Promise<QuizResponse> {
  const apiKey = resolveKey(input)
  const focus = input.focus === 'b' ? 'b' : input.focus === 'both' ? 'both' : 'w'
  const sideName = focus === 'w' ? 'White' : focus === 'b' ? 'Black' : 'both sides'
  const game = sanitizeGame(input.game)
  if (game.length === 0) throw new AnalyzeError('A game is required to build a quiz.')
  const count = Math.min(10, Math.max(1, intOr(input.count, 6)))
  const moveText = moveTextOf(game)

  const system = systemWith(`Create a short multiple-choice quiz that teaches a player studying ${sideName} the rules of thumb, based on the game below. Use the make_quiz tool.

Each question must have a clear "prompt", 3-4 "options" with EXACTLY ONE having correct=true, and a one-line "explanation" of the correct answer. Make the wrong options plausible but clearly worse. Vary the questions across these kinds:
- "Which rule does <move> most FOLLOW / BREAK here?" (options are rule titles).
- "Which of these moves best follows rule #NN (<title>)?" (options are moves that appear in the game).
- A concept check about what a specific rule means.
Only reference moves that actually appear in the game, citing them by move number and SAN. Set "ruleId" to the main rule number (1-${RULE_COUNT}) and "ply" to the referenced game ply when applicable. Keep prompts and options concise.`)

  const user = `The player being quizzed is studying ${sideName}. Base the quiz on this game.
Game (SAN):
${moveText}

Create ${count} questions.`

  const data = (await callClaude(apiKey, system, user, {
    maxTokens: 4000,
    tool: QUIZ_TOOL,
    toolName: 'make_quiz',
  })) as { questions?: unknown }

  const rawQuestions = Array.isArray(data.questions) ? data.questions : []
  const questions: QuizQuestion[] = []
  for (const q of rawQuestions) {
    if (!q || typeof q.prompt !== 'string' || !q.prompt.trim()) continue
    const rawOpts = Array.isArray(q.options) ? q.options : []
    const valid: { text: string; correct: boolean }[] = rawOpts
      .filter((o: { text?: unknown }) => o && typeof o.text === 'string' && o.text.trim())
      .map((o: { text: string; correct?: unknown }) => ({ text: clip(o.text, 160), correct: o.correct === true }))
    // Find the answer BEFORE trimming (so an over-long list can't drop it), and
    // enforce exactly one correct option — the schema only "describes" that.
    const correctIdx = valid.findIndex((o) => o.correct)
    if (correctIdx === -1) continue
    valid.forEach((o, i) => (o.correct = i === correctIdx))
    let options = valid
    if (valid.length > 5) {
      options = valid.filter((o, i) => o.correct || i < (correctIdx < 5 ? 5 : 4)).slice(0, 5)
    }
    if (options.length < 2) continue
    const out: QuizQuestion = {
      prompt: clip(q.prompt, 400),
      options,
      explanation: typeof q.explanation === 'string' ? clip(q.explanation, 300) : '',
    }
    if (Number.isInteger(q.ruleId) && q.ruleId >= 1 && q.ruleId <= RULE_COUNT) out.ruleId = q.ruleId
    // Only keep plies that actually exist in the supplied game.
    if (Number.isInteger(q.ply) && q.ply >= 0 && game.some((m) => m.ply === q.ply)) out.ply = q.ply
    questions.push(out)
    if (questions.length >= 10) break
  }
  if (questions.length === 0) throw new AnalyzeError('Could not generate quiz questions. Try again.', 502)
  return { questions }
}

// ---- Game overview ----

const OVERVIEW_TOOL = {
  name: 'report_overview',
  description: 'Report a short overview of the whole game.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: {
        type: 'string',
        description:
          "2-4 decisive sentences on what decided the game from the studied side's perspective: what won it, what lost it.",
      },
      trend: {
        type: 'string',
        description:
          '1-2 sentences on the arc of the game: who stood better in which phase and where the momentum shifted.',
      },
      keyMoments: {
        type: 'array',
        description: '2-4 pivotal moments, in game order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ply: { type: 'integer', description: 'The ply of the pivotal move.' },
            title: { type: 'string', description: 'A 2-5 word label, e.g. "The decisive sacrifice".' },
            why: { type: 'string', description: 'One line on why this moment mattered.' },
          },
          required: ['ply', 'title', 'why'],
        },
      },
    },
    required: ['summary', 'trend', 'keyMoments'],
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

  const system = systemWith(`Write a short OVERVIEW of the whole game from the perspective of ${sideName === 'both sides' ? 'a coach reviewing both sides' : sideName}, using the report_overview tool. Be decisive and concrete — this is the opening summary a coach gives before going move by move.
- "summary": what decided the game — what won it and what lost it (2-4 sentences). Name the concrete cause (e.g. a loose piece, a king left in the centre, a winning attack), citing rule numbers where natural.
- "trend": the arc of the game — who stood better in which phase and where the momentum shifted (1-2 sentences).
- "keyMoments": 2-4 pivotal plies in game order, each with a short title and a one-line why. Use the ply numbers as given (White's first move is ply 0, Black's reply is ply 1, and so on).`)

  const user = `Game: ${white} vs ${black}${result ? ` (result ${result})` : ''}. The side under study: ${sideName}.
Moves (SAN):
${moveTextOf(game)}

Give the overview.`

  const data = (await callClaude(apiKey, system, user, {
    maxTokens: 1200,
    tool: OVERVIEW_TOOL,
    toolName: 'report_overview',
  })) as { summary?: unknown; trend?: unknown; keyMoments?: unknown }

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
    .slice(0, 4)
    .map((m: { ply: number; title: string; why: string }) => ({
      ply: m.ply,
      title: clip(m.title, 60),
      why: clip(m.why, 240),
    }))

  const overview = {
    summary: typeof data.summary === 'string' ? clip(data.summary, 900) : '',
    trend: typeof data.trend === 'string' ? clip(data.trend, 400) : '',
    keyMoments,
  }
  if (!overview.summary) throw new AnalyzeError('Claude did not return an overview.', 502)
  return { overview }
}

// ---- Ask mode (free-form question) ----

export async function runAsk(input: AskRequest): Promise<AskResponse> {
  const apiKey = resolveKey(input)
  const question = clip(input.question, 500).trim()
  if (!question) throw new AnalyzeError('Please enter a question.')

  const contextLines: string[] = []
  if (Array.isArray(input.game) && input.game.length) {
    contextLines.push(`Game so far (SAN): ${moveTextOf(sanitizeGame(input.game))}`)
  }
  const parts: string[] = []
  if (input.san) parts.push(`move ${clip(input.san, 12)}`)
  if (input.fen) parts.push(`position FEN ${clip(input.fen, 100)}`)
  if (parts.length) contextLines.push(`The move/position under discussion: ${parts.join(', ')}.`)
  const rid = input.ruleId
  if (Number.isInteger(rid) && (rid as number) >= 1 && (rid as number) <= RULE_COUNT) {
    const rule = RULES_BY_ID[rid as number]
    if (rule) contextLines.push(`Asked in the context of rule #${rule.id} "${rule.title}" — ${rule.detail}`)
  }
  const context = contextLines.length ? `Context:\n${contextLines.join('\n')}\n\n` : ''

  const system = systemWith(`Answer the user's chess question concisely and decisively (2-4 sentences), grounded in the ${RULE_COUNT} rules of thumb above. The user may ask follow-up questions — treat the conversation as one thread about the same position/rule unless they change the subject. Cite relevant rule numbers/titles when helpful. This is heuristic coaching for club players, not engine analysis — be direct but do not overstate certainty, and do not hedge every sentence. If the question is not about chess, briefly say you only help with chess strategy.`)

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

  const text = (await callClaude(apiKey, system, messages, { maxTokens: 700 })) as string
  const answer = clip(text, 1500).trim()
  return { answer: answer || 'No answer was returned. Please try rephrasing.' }
}
