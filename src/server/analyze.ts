// Server-side analysis: send the game + target moves to Claude Opus and get back,
// for each move, which of the 40 rules of thumb are relevant and how the move
// relates to them. Structured output is obtained via a forced tool call, which
// works across SDK versions and models.
//
// This module is server-only (it imports the Anthropic SDK and reads the API
// key). It must never be imported by browser code.

import Anthropic from '@anthropic-ai/sdk'
import { rulesForPrompt } from '../shared/rules'
import type { AnalyzeRequest, AnalyzeResponse, MoveResult, RuleHit } from '../shared/types'

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8'
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
                  id: { type: 'integer', description: 'Rule number, 1 to 40.' },
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
  // de-duplicate targets by ply and cap the count
  const seen = new Set<number>()
  const targets = input.targets.filter((t) => {
    if (!t || typeof t.ply !== 'number' || seen.has(t.ply)) return false
    seen.add(t.ply)
    return true
  })
  if (targets.length === 0) return { results: [] }
  if (targets.length > MAX_TARGETS) {
    throw new AnalyzeError(`Too many moves in one request (max ${MAX_TARGETS}).`)
  }
  const game = input.game.slice(0, MAX_GAME_PLIES)

  const client = new Anthropic({ apiKey })
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

  // The big, invariant part of the prompt (role + the 40 rules) is a stable
  // prefix — mark it for prompt caching so every request reuses it cheaply.
  // The tiny perspective line comes after the cache breakpoint.
  const rulesBlock = `You are a friendly, practical chess coach for club players (beginner to intermediate).

You are given a list of 40 strategic "rules of thumb", numbered 1-40. For a requested move by the side under study, decide which of these rules are genuinely RELEVANT at that moment, and for each relevant rule state whether the move "follows", "partially" follows, "violates" it, or is just "relevant" (matters here but neutral/unclear).

Give one plain-language sentence per relevant rule that a club player can understand, using honest, hedged language ("appears", "may", "likely"). Only list rules that truly apply — usually 1 to 4 per move. Do not force irrelevant rules. Also give one short practical "lesson" sentence for the move. Refer to rules by their NUMBER (1-40) exactly.

The 40 rules:
${rulesForPrompt()}`

  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: rulesBlock, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `Analyse strictly from ${sideName}'s perspective.` },
  ]

  const user = `Full game in SAN:
${moveText}

Analyse the following ${sideName} move(s) and report using the report_relevance tool. Return exactly one result object per ply listed:
${targetLines}`

  let message: Anthropic.Message
  try {
    message = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system,
      tools: [OUTPUT_TOOL as unknown as Anthropic.Tool],
      tool_choice: { type: 'tool', name: 'report_relevance' },
      messages: [{ role: 'user', content: user }],
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Claude request failed.'
    // surface auth/rate errors as 4xx-ish, otherwise 502
    const status = /api key|authentication|401|invalid/i.test(msg) ? 401 : 502
    throw new AnalyzeError(msg, status)
  }

  const toolUse = message.content.find((b) => b.type === 'tool_use') as
    | Anthropic.ToolUseBlock
    | undefined
  if (!toolUse) throw new AnalyzeError('Claude did not return structured output.', 502)

  const data = toolUse.input as AnalyzeResponse
  const results: MoveResult[] = (data.results || []).map((r) => ({
    ply: r.ply,
    lesson: typeof r.lesson === 'string' ? r.lesson : '',
    rules: (r.rules || []).filter(
      (h: RuleHit) => Number.isInteger(h.id) && h.id >= 1 && h.id <= 40 && typeof h.why === 'string',
    ),
  }))
  return { results }
}
