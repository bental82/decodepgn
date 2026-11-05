import { RULES_BY_ID } from '../shared/rules'
import type { RuleHit } from '../shared/types'
import type { MoveAnalysisProps } from './contract'
import { ENGINE_APPROVED_CP, soundnessMeta, statusMeta } from './contract'
import Icon from './Icon'
import RuleText from './RuleText'

function hasGraphics(h: RuleHit): boolean {
  return !!h.graphics && (h.graphics.squares?.length ?? 0) + (h.graphics.arrows?.length ?? 0) > 0
}

const plainSan = (san: string) => san.replace(/[+#]/g, '')

/** Stockfish's verdict in a few characters — the badge row stays one line. */
function engineLabel(isBest: boolean, cpLoss: number): string {
  if (isBest) return 'Engine’s top'
  if (cpLoss < ENGINE_APPROVED_CP) return 'Engine-approved'
  // mate-scale losses read as "−M", like the eval bar
  return cpLoss >= 5000 ? 'Engine −M' : `Engine −${(cpLoss / 100).toFixed(1)}`
}

// One move's coaching, kept short on purpose: a single paragraph, the habit
// to take away (only when there is one), the rules as chips, and the better
// move. Analyses made before the concise format still render — their one-line
// lesson becomes the paragraph and the old per-rule sentences fold away under
// "Rule notes", so older games read short without re-analysing.
export default function MoveAnalysis({
  move,
  result,
  loading,
  error,
  onReanalyze,
  onOpenRule,
  gfx,
  onGfx,
  autoGfxRuleId,
  altArrow,
  engineArrow,
}: MoveAnalysisProps) {
  // The move this card is about, always on top: the nav row is under the
  // board, and on a phone it scrolls away — the analysis must name itself.
  const head = (
    <div className="analysis-head">
      {move.moveNumber}
      {move.color === 'w' ? '.' : '…'} {move.san}
    </div>
  )

  if (error) {
    return (
      <div className="analysis">
        {head}
        <div className="error">{error}</div>
        <button className="btn reanalyze" onClick={onReanalyze}>
          Try again
        </button>
      </div>
    )
  }

  if (loading && !result) {
    return (
      <div className="analysis">
        {head}
        <div className="loading-row">
          <span className="spinner" />
          Coaching this move…
        </div>
      </div>
    )
  }

  if (!result) return null

  const snd = result.soundness ? soundnessMeta(result.soundness) : null
  const eng = result.engine
  const ruleShown = (id: number) =>
    (gfx.kind === 'rule' && gfx.id === id) || (gfx.kind === 'auto' && autoGfxRuleId === id)
  const altShown = gfx.kind === 'alt'
  const engShown = gfx.kind === 'engine'

  // The paragraph: the concise format's comment, else an older analysis's lesson.
  const paragraph = result.comment || result.lesson
  const keyLesson = result.comment ? result.lesson : ''
  const rules = [...result.rules].sort((a, b) => (b.relevance ?? 3) - (a.relevance ?? 3))
  const legacyNotes = result.comment ? [] : rules.filter((h) => h.why)
  const legacyAltWhy = result.comment ? undefined : result.alternative?.why

  // The better move: the coach's alternative and/or Stockfish's best, shown
  // once — Stockfish's only when the played move actually cost something
  // (an "about equal" engine pick on an approved move is noise, not a fix).
  const alt = result.alternative
  const engBest =
    eng &&
    !eng.isBest &&
    eng.cpLoss >= ENGINE_APPROVED_CP &&
    plainSan(eng.bestSan) !== plainSan(move.san)
      ? eng
      : null
  const engSameAsAlt = !!alt && !!engBest && plainSan(alt.move) === plainSan(engBest.bestSan)
  const engGain = engBest
    ? engBest.cpLoss >= 5000
      ? 'a mating line'
      : engBest.cpLoss >= 10
        ? `+${(engBest.cpLoss / 100).toFixed(1)}`
        : 'about equal'
    : ''
  const gfxToggle = (on: boolean, show: () => void, what: string) => (
    <button
      className={'gfx-btn icon-only' + (on ? ' on' : '')}
      aria-pressed={on}
      aria-label={on ? `Hide ${what} from the board` : `Show ${what} on the board`}
      title={on ? `Hide ${what} from the board` : `Show ${what} on the board`}
      onClick={() => (on ? onGfx({ kind: 'off' }) : show())}
    >
      <Icon name="board" size={13} />
    </button>
  )

  return (
    <div className="analysis">
      <div className="analysis-top">
        {head}
        {snd || eng ? (
          <div className="verdicts">
            {snd ? (
              <span
                className={'soundness ' + snd.cls}
                title={`${snd.desc} (A heuristic judgment, not an engine score.)`}
              >
                <span className="snd-badge">
                  {snd.icon} {snd.label}
                </span>
              </span>
            ) : null}
            {eng ? (
              <span
                className={
                  'badge eng-badge ' +
                  (eng.isBest || eng.cpLoss < ENGINE_APPROVED_CP
                    ? 'st-follows'
                    : eng.cpLoss >= 150
                      ? 'st-violates'
                      : eng.cpLoss >= 60
                        ? 'st-partial'
                        : 'st-relevant')
                }
                title={`Stockfish, depth ${eng.depth}. Best move: ${eng.bestSan}. Eval after best play: ${(eng.evalBest / 100).toFixed(2)}; after the played move: ${(eng.evalPlayed / 100).toFixed(2)} (from the mover's side).`}
              >
                <Icon name="cpu" size={13} />
                {engineLabel(eng.isBest, eng.cpLoss)}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {loading ? (
        // Re-analysing an already-analysed move: keep the old result visible
        // but SAY that work is happening (the button used to look dead).
        <div className="loading-row">
          <span className="spinner" />
          Re-analysing this move…
        </div>
      ) : null}

      {paragraph ? (
        <p className="comment">
          <RuleText text={paragraph} onOpenRule={onOpenRule} />
        </p>
      ) : rules.length === 0 ? (
        // an empty shell (the model skipped this ply and no retry recovered
        // it) — offer the repair instead of pretending it was analysed
        <p className="note">
          The analysis for this move came back empty.{' '}
          <button className="linkbtn" onClick={onReanalyze} disabled={loading}>
            <Icon name="refresh" size={12} /> Re-analyse this move
          </button>
        </p>
      ) : null}

      {keyLesson ? (
        <p className="key-lesson">
          <Icon name="bulb" size={15} />
          <span>
            <RuleText text={keyLesson} onOpenRule={onOpenRule} />
          </span>
        </p>
      ) : null}

      {rules.length > 0 ? (
        <ul className="rule-chips" aria-label="Rules of thumb in play">
          {rules.map((hit) => {
            const meta = statusMeta(hit.status)
            const shown = ruleShown(hit.id)
            const title = RULES_BY_ID[hit.id]?.title ?? 'Rule ' + hit.id
            return (
              <li className={'rule-chip ' + meta.cls + (shown ? ' on' : '')} key={hit.id}>
                <button
                  className="rule-chip-main"
                  onClick={() => onOpenRule(hit.id)}
                  title={`${meta.label}: rule ${hit.id} — ${title}`}
                >
                  <span className="rule-chip-icon" aria-label={meta.label}>
                    {meta.icon}
                  </span>
                  <span className="rule-chip-num">#{hit.id}</span>
                  <span className="rule-chip-title">{title}</span>
                </button>
                {hasGraphics(hit)
                  ? gfxToggle(shown, () => onGfx({ kind: 'rule', id: hit.id }), 'this idea')
                  : null}
              </li>
            )
          })}
        </ul>
      ) : null}

      {alt || engBest ? (
        <div className="better">
          <span className="better-label">{alt && !engBest && eng ? 'Also playable' : 'Better'}</span>
          {alt ? (
            <span className="better-move">
              <strong>{alt.move}</strong>
              {engSameAsAlt ? (
                <span className="eng-note" title="Stockfish's top move too">
                  <Icon name="cpu" size={12} /> {engGain}
                </span>
              ) : null}
              {altArrow ? gfxToggle(altShown, () => onGfx({ kind: 'alt' }), 'this move') : null}
            </span>
          ) : null}
          {engBest && !engSameAsAlt ? (
            <span className="better-move" title={`Stockfish's top move (depth ${engBest.depth})`}>
              <Icon name="cpu" size={12} />
              <strong>{engBest.bestSan}</strong>
              <span className="eng-note">{engGain}</span>
              {engineArrow
                ? gfxToggle(engShown, () => onGfx({ kind: 'engine' }), 'Stockfish’s move')
                : null}
            </span>
          ) : null}
        </div>
      ) : null}

      {legacyNotes.length > 0 || legacyAltWhy ? (
        // Older analyses explained every rule in its own sentence — kept,
        // but folded away: they mostly restate the paragraph above.
        <details className="rule-notes" open={!paragraph}>
          <summary>Rule notes</summary>
          <ul>
            {legacyNotes.map((h) => (
              <li key={h.id}>
                <span className={'rn-num ' + statusMeta(h.status).cls}>#{h.id}</span>{' '}
                <RuleText text={h.why ?? ''} onOpenRule={onOpenRule} />
              </li>
            ))}
            {legacyAltWhy && alt ? (
              <li>
                <strong className="rn-move">{alt.move}</strong> —{' '}
                <RuleText text={legacyAltWhy} onOpenRule={onOpenRule} />
              </li>
            ) : null}
          </ul>
        </details>
      ) : null}

      <div className="analysis-foot">
        <button className="linkbtn" onClick={onReanalyze} disabled={loading}>
          <Icon name="refresh" size={12} /> {loading ? 'Re-analysing…' : 'Re-analyse'}
        </button>
      </div>
    </div>
  )
}
