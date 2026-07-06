// Server-side analysis: send the game + target moves to Claude Opus and get back,
// for each move, which of the rules of thumb are relevant and how the move
// relates to them. Structured output is obtained via a forced tool call, which
// works across SDK versions and models.
//
// This module is server-only (it imports the Anthropic SDK and reads the API
// key). It must never be imported by browser code.

import { Chess } from 'chess.js'
import { rulesForPrompt, RULE_COUNT, RULES_BY_ID } from '../shared/rules.js'
import { stripToolLeak } from '../shared/types.js'
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
  BestMoveTarget,
  BoardAnnotations,
  Color,
  EngineEval,
  GameMove,
  MetaGameSummary,
  MetaInsight,
  MetaRequest,
  MetaResponse,
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
      : `Analyse strictly from ${sideName}'s perspective — the reader IS the ${sideName} player, so address them as "you".`
  }

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
        lesson: stripToolLeak(r.lesson),
        rules: (r.rules || [])
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
  if (input.kind === 'bestmove') return runBestMoveQuiz(input)
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
      .map((o: { text: string; correct?: unknown }) => ({ text: cleanClip(o.text, 160), correct: o.correct === true }))
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
    // Shuffle: models habitually write the correct option FIRST, so without
    // this the right answer is almost always "A".
    for (let i = options.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[options[i], options[j]] = [options[j], options[i]]
    }
    const out: QuizQuestion = {
      prompt: cleanClip(q.prompt, 400),
      options,
      explanation: cleanClip(q.explanation, 300),
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

// ---- Best-move quiz ----

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

const BESTMOVE_TOOL = {
  name: 'make_bestmove_quiz',
  description: 'Return distractor moves and an explanation for each quiz position.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      items: {
        type: 'array',
        description: 'Exactly one item per listed position, in the given order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ply: { type: 'integer', description: 'The ply of the position, as listed.' },
            distractors: {
              type: 'array',
              description:
                '1-2 plausible but inferior LEGAL moves (SAN) a club player would seriously consider — tempting captures, natural developing moves. NEVER the played or target move.',
              items: { type: 'string' },
            },
            explanation: {
              type: 'string',
              description:
                '2-3 sentences: why the target move is strongest (cite rule numbers where natural), and — when the game move differed — why the game move fell short, naming it.',
            },
          },
          required: ['ply', 'distractors', 'explanation'],
        },
      },
    },
    required: ['items'],
  },
}

async function runBestMoveQuiz(input: QuizRequest): Promise<QuizResponse> {
  const apiKey = resolveKey(input)
  const game = sanitizeGame(input.game)

  // Verify every target on a real board: the position must parse, the played
  // and correct moves must be legal there. The correct answer is decided HERE
  // (engine best > AI alternative > the played move), never by the quiz model.
  interface Verified {
    ply: number
    fen: string
    played: string
    correct: string
    cpLoss?: number
    mover: 'White' | 'Black'
  }
  const targets: Verified[] = []
  for (const raw of Array.isArray(input.targets) ? input.targets : []) {
    const t = raw as BestMoveTarget
    if (!t || !Number.isInteger(t.ply) || typeof t.fenBefore !== 'string' || typeof t.played !== 'string') continue
    const fen = clip(t.fenBefore, 100)
    const played = legalSan(fen, clip(t.played, 12))
    if (!played) continue
    const correctRaw =
      (typeof t.best === 'string' && t.best.trim()) ||
      (typeof t.alternative === 'string' && t.alternative.trim()) ||
      t.played
    const correct = legalSan(fen, clip(correctRaw, 12))
    if (!correct) continue
    targets.push({
      ply: t.ply,
      fen,
      played,
      correct,
      cpLoss: Number.isFinite(t.cpLoss) ? Math.max(0, Math.trunc(t.cpLoss as number)) : undefined,
      mover: fen.split(' ')[1] === 'b' ? 'Black' : 'White',
    })
    if (targets.length >= 10) break
  }
  if (!targets.length) {
    throw new AnalyzeError('No usable positions for a best-move quiz — analyse some moves first.')
  }

  const lines = targets
    .map((t) => {
      let line = `- ply ${t.ply} — ${t.mover} to move. FEN: ${t.fen}. Played in the game: ${t.played}. Target move: ${t.correct}.`
      if (t.correct === t.played) line += ' (The player FOUND the target move — write the explanation as reinforcement.)'
      else if (t.cpLoss !== undefined)
        line += ` (Stockfish: the played move gave up about ${(t.cpLoss / 100).toFixed(1)} pawns vs the target.)`
      return line
    })
    .join('\n')

  const system = systemWith(`You are building a "find the strongest move" quiz from the player's OWN game, using the make_bestmove_quiz tool. Each listed position gives the move actually PLAYED and the TARGET move — the strongest or clearly cleaner move (sometimes the played move itself, when the player found it).
Return exactly one item per listed ply:
- "distractors": 1-2 plausible but inferior LEGAL moves in that position (SAN) that a club player would seriously consider — tempting captures, checks, natural developing moves. Never include the played or target move, and never a move that is equally strong. The question must not be solvable by elimination: a distractor that is obviously bad (hangs a piece for nothing, retreats for no reason) gives the answer away.
- "explanation": 2-3 sentences that TEACH, not just judge. Name the principle at work and ALWAYS cite at least one rule by number (e.g. "rule 17" — the app turns citations into tappable links), say concretely what the target move achieves, and end with the transferable idea: what the player should look for in positions like this. When the game move differed, say plainly why it fell short, naming it (e.g. "In the game, Nf3 let Black free the bishop"). When the game move IS the target, reinforce what made it right so the player repeats it on purpose. Do not give the answer away in a distractor.`)

  const user = `Full game in SAN (for context):
${moveTextOf(game)}

The positions:
${lines}`

  const data = (await callClaude(apiKey, system, user, {
    maxTokens: 3000,
    tool: BESTMOVE_TOOL,
    toolName: 'make_bestmove_quiz',
  })) as { items?: unknown }

  const rawItems = Array.isArray(data.items) ? data.items : []
  const itemByPly = new Map<number, { distractors?: unknown; explanation?: unknown }>()
  for (const it of rawItems) {
    if (it && Number.isInteger(it.ply) && !itemByPly.has(it.ply)) itemByPly.set(it.ply, it)
  }

  const questions: QuizQuestion[] = []
  for (const t of targets) {
    const item = itemByPly.get(t.ply)
    // Options: the correct move, the game move (when different), then verified
    // distractors — all legality-checked against the position.
    const options: string[] = [t.correct]
    if (t.played !== t.correct) options.push(t.played)
    for (const d of Array.isArray(item?.distractors) ? item.distractors : []) {
      if (options.length >= 4) break
      if (typeof d !== 'string') continue
      const san = legalSan(t.fen, clip(d, 12))
      if (san && !options.includes(san)) options.push(san)
    }
    // Top up from the position's legal moves if the model came up short.
    if (options.length < 4) {
      try {
        const all = new Chess(t.fen).moves()
        for (const i of [0, Math.floor(all.length / 2), all.length - 1, ...all.keys()]) {
          if (options.length >= 4) break
          const san = all[i]
          if (san && !options.includes(san)) options.push(san)
        }
      } catch {
        /* keep what we have */
      }
    }
    if (options.length < 2) continue
    // Fisher-Yates shuffle so the answer isn't always option A.
    for (let i = options.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[options[i], options[j]] = [options[j], options[i]]
    }
    const cleanedExpl = cleanClip(item?.explanation, 600).trim()
    let explanation = cleanedExpl || `${t.correct} was the strongest move here.`
    if (t.played !== t.correct && !explanation.includes(t.played)) {
      explanation += ` In the game, ${t.played} was played.`
    }
    questions.push({
      prompt:
        t.mover +
        ' to move — what is the strongest move here?' +
        (t.played === t.correct ? '' : ' (One of these was played in the game.)'),
      options: options.map((text) => ({ text, correct: text === t.correct })),
      explanation,
      ply: t.ply,
      fen: t.fen,
    })
  }
  if (!questions.length) throw new AnalyzeError('Could not build best-move questions. Try again.', 502)
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

  const system = systemWith(`Write a short OVERVIEW of the whole game ${sideName === 'both sides' ? 'as a coach reviewing both sides' : `for the player who had ${sideName} — address them as "you"`}, using the report_overview tool. Concrete and instructive — this is the opening word a coach gives before going move by move, and it sets the tone for the whole review.
- "summary": what decided the game and the lesson in it (2-4 sentences). Name the concrete cause (e.g. a loose piece, a king left in the centre, a winning attack) and the skill to practise, citing rule numbers where natural. Remember your voice: diagnose decisions, no scolding words.
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
      title: cleanClip(m.title, 60),
      why: cleanClip(m.why, 240),
    }))

  const overview = {
    summary: cleanClip(data.summary, 900),
    trend: cleanClip(data.trend, 400),
    keyMoments,
  }
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
  },
  required: ['title', 'detail'],
}

const META_TOOL = {
  name: 'report_meta',
  description: "Report the cross-game meta-analysis of the player's habits.",
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
    required: ['profile', 'openings', 'recurringMistakes', 'strengths', 'priorities'],
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
      lessons: (Array.isArray(s.lessons) ? s.lessons : [])
        .filter((l) => typeof l === 'string')
        .slice(0, 3)
        .map((l) => cleanClip(l, 220)),
    }
    if (s.me === 'w' || s.me === 'b') sum.me = s.me
    if (typeof s.result === 'string') sum.result = clip(s.result, 8)
    if (typeof s.date === 'string') sum.date = clip(s.date, 12)
    const e = s.engine
    if (e && Number.isFinite(e.avgCpLoss)) {
      sum.engine = {
        avgCpLoss: Math.max(0, intOr(e.avgCpLoss, 0)),
        worst: Math.max(0, intOr(e.worst, 0)),
        blunders: Math.max(0, intOr(e.blunders, 0)),
        checked: Math.max(0, intOr(e.checked, 0)),
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
    line += `\n  Stockfish: average loss ${(s.engine.avgCpLoss / 100).toFixed(2)} pawns/move over ${s.engine.checked} checked moves, worst single loss ${(s.engine.worst / 100).toFixed(1)}, blunders (>=1.5): ${s.engine.blunders}.`
  }
  if (s.lessons.length) {
    line += `\n  Lessons from the costliest moves: ${s.lessons.map((l) => `"${l}"`).join(' | ')}`
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

  const system = systemWith(`You are reviewing this player's WHOLE recent history — ${withAnalysis.length} analysed game(s) — to surface the patterns no single game can show. Use the report_meta tool. Address the player as "you" throughout.

Each game summary below was computed from full per-move analysis: the opening moves, which rules of thumb were followed or broken (with counts), a soundness tally, Stockfish accuracy (average centipawn loss, worst slip, blunder count), and the lessons attached to the costliest moves. "you were White/Black" marks the player's own side — their habits are what you are profiling; ignore the opponent's play except as context.

What to produce:
- "profile": their playing style as the DATA shows it — attacking or positional, fast or slow development, material-grabbing or safety-first, where in the game accuracy drops (opening, middlegame, conversions), and the overall trend across games.
- "openings": what they actually play as White and as Black — NAME the openings from the move sequences (e.g. "Italian Game", "Caro-Kann") — which of their lines score well or badly, and one concrete repertoire suggestion.
- "recurringMistakes": 3-5 patterns that appear in SEVERAL games, not one-offs. Each names the mechanism, cites the rules involved by number (e.g. "rule 61"), and states the evidence ("in 4 of 6 games, always in the late middlegame"). Diagnose decisions, never character.
- "strengths": 2-4 things they consistently do well — rules repeatedly followed, phases with low centipawn loss — so they keep doing them on purpose.
- "priorities": exactly 3 training priorities, most impactful first. Each is a concrete habit or drill ("before every recapture, count the forcing sequence to the end"), tied to the recurring mistakes, with rule numbers.

Ground every claim in the data given — never invent games, moves or numbers. With a small sample (under ~5 games), say so and keep claims proportional. Where the engine data and the rule data disagree, trust the engine for accuracy and the rules for themes.`)

  const user = `The player's analysed games:

${withAnalysis.map(summaryLine).join('\n\n')}

Write the meta-analysis.`

  const data = (await callClaude(apiKey, system, user, {
    maxTokens: 3000,
    tool: META_TOOL,
    toolName: 'report_meta',
  })) as {
    profile?: unknown
    openings?: unknown
    recurringMistakes?: unknown
    strengths?: unknown
    priorities?: unknown
  }

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
        return out
      })

  const report = {
    profile: cleanClip(data.profile, 1200),
    openings: cleanClip(data.openings, 900),
    recurringMistakes: insights(data.recurringMistakes, 5),
    strengths: insights(data.strengths, 4),
    priorities: insights(data.priorities, 3),
  }
  if (!report.profile) throw new AnalyzeError('Claude did not return a meta-analysis.', 502)
  return { report, gamesUsed: withAnalysis.length }
}
