import { RULES_BY_ID } from '../shared/rules'
import type { RuleHit } from '../shared/types'
import type { MoveAnalysisProps } from './contract'
import { soundnessMeta, statusMeta } from './contract'
import RuleText from './RuleText'

function hasGraphics(h: RuleHit): boolean {
  return !!h.graphics && (h.graphics.squares?.length ?? 0) + (h.graphics.arrows?.length ?? 0) > 0
}

const plainSan = (san: string) => san.replace(/[+#]/g, '')

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
  if (error) {
    return (
      <div className="analysis">
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
        <div className="loading-row">
          <span className="spinner" />
          Asking Claude which rules apply…
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

  // Stockfish's recommendation always accompanies the cleaner-move box, as
  // long as the engine actually preferred a DIFFERENT move to the one played.
  const alt = result.alternative
  const engBest = eng && !eng.isBest && plainSan(eng.bestSan) !== plainSan(move.san) ? eng : null
  const engSameAsAlt = !!alt && !!engBest && plainSan(alt.move) === plainSan(engBest.bestSan)
  const engGain = engBest
    ? engBest.cpLoss >= 10
      ? `saves ≈${(engBest.cpLoss / 100).toFixed(1)} pawns`
      : 'about equal by eval'
    : ''

  return (
    <div className="analysis">
      {loading ? (
        // Re-analysing an already-analysed move: keep the old result visible
        // but SAY that work is happening (the button used to look dead).
        <div className="loading-row">
          <span className="spinner" />
          Re-analysing this move…
        </div>
      ) : null}
      {snd || eng ? (
        <div className="verdicts">
          {snd ? (
            <span className={'soundness ' + snd.cls} title={snd.desc}>
              <span className="snd-badge">
                {snd.icon} {snd.label} move
              </span>
              <span className="snd-hint">heuristic</span>
            </span>
          ) : null}
          {eng ? (
            <span
              className={
                'badge eng-badge ' +
                (eng.isBest || eng.cpLoss < 30
                  ? 'st-follows'
                  : eng.cpLoss >= 150
                    ? 'st-violates'
                    : eng.cpLoss >= 60
                      ? 'st-partial'
                      : 'st-relevant')
              }
              title={`Stockfish, depth ${eng.depth}. Best move: ${eng.bestSan}. Eval after best play: ${(eng.evalBest / 100).toFixed(2)}; after the played move: ${(eng.evalPlayed / 100).toFixed(2)} (from the mover's side).`}
            >
              {/* short labels so the badge row stays one line on phones;
                  the tooltip above carries the full detail */}
              {eng.isBest
                ? '⚙ Engine’s top'
                : eng.cpLoss < 30
                  ? '⚙ Engine-approved'
                  : `⚙ Better: ${eng.bestSan} (−${(eng.cpLoss / 100).toFixed(1)})`}
            </span>
          ) : null}
        </div>
      ) : null}

      {result.lesson ? (
        <div className="lesson">
          <p>
            <RuleText text={result.lesson} onOpenRule={onOpenRule} />
          </p>
        </div>
      ) : null}

      <div className="findings">
        <h3>Relevant rules of thumb</h3>
        {result.rules.length === 0 ? (
          <p className="note">No single rule stood out for this move.</p>
        ) : (
          [...result.rules]
            // most important first (server pre-sorts; this also covers older saved results)
            .sort((a, b) => (b.relevance ?? 3) - (a.relevance ?? 3))
            .map((hit) => {
              const meta = statusMeta(hit.status)
              const shown = ruleShown(hit.id)
              return (
                <div className="finding" key={hit.id}>
                  <div className="finding-top">
                    <span className={'badge ' + meta.cls} title={meta.desc}>
                      {meta.icon} {meta.label}
                    </span>
                    <button className="rule-link" onClick={() => onOpenRule(hit.id)}>
                      <span className="rule-num">#{hit.id}</span>{' '}
                      {RULES_BY_ID[hit.id]?.title ?? 'Rule ' + hit.id}
                    </button>
                    {(hit.relevance ?? 0) >= 5 ? (
                      <span className="key-rule" title="The key idea of this move">
                        ★ key
                      </span>
                    ) : null}
                    {hasGraphics(hit) ? (
                      <button
                        className={'gfx-btn' + (shown ? ' on' : '')}
                        aria-pressed={shown}
                        title={shown ? 'Hide these marks from the board' : 'Show this idea on the board'}
                        onClick={() => onGfx(shown ? { kind: 'off' } : { kind: 'rule', id: hit.id })}
                      >
                        ◈ board
                      </button>
                    ) : null}
                  </div>
                  <p className="why">
                    <RuleText text={hit.why} onOpenRule={onOpenRule} />
                  </p>
                </div>
              )
            })
        )}
      </div>

      {alt || engBest ? (
        <div className="alt">
          <div className="alt-head">
            <span className="alt-label">Cleaner here</span>
          </div>
          {alt ? (
            <div className="alt-line">
              <p>
                <strong>{alt.move}</strong> —{' '}
                <RuleText text={alt.why} onOpenRule={onOpenRule} />
                {engSameAsAlt ? (
                  <span className="eng-note"> ⚙ Also Stockfish’s top move ({engGain}).</span>
                ) : null}
              </p>
              {altArrow ? (
                <button
                  className={'gfx-btn' + (altShown ? ' on' : '')}
                  aria-pressed={altShown}
                  title={altShown ? 'Hide the arrow' : 'Show this move as an arrow on the board'}
                  onClick={() => onGfx(altShown ? { kind: 'off' } : { kind: 'alt' })}
                >
                  ◈ board
                </button>
              ) : null}
            </div>
          ) : null}
          {engBest && !engSameAsAlt ? (
            <div className="alt-line">
              <p>
                <strong>{engBest.bestSan}</strong> —{' '}
                <span className="eng-note">
                  ⚙ Stockfish’s top move here ({engGain}, depth {engBest.depth}).
                </span>
              </p>
              {engineArrow ? (
                <button
                  className={'gfx-btn' + (engShown ? ' on' : '')}
                  aria-pressed={engShown}
                  title={engShown ? 'Hide the arrow' : 'Show Stockfish’s move as an arrow on the board'}
                  onClick={() => onGfx(engShown ? { kind: 'off' } : { kind: 'engine' })}
                >
                  ◈ board
                </button>
              ) : null}
            </div>
          ) : null}
          {alt && eng && !engBest ? (
            <p className="eng-note eng-note-block">
              ⚙ Stockfish’s top choice was the move actually played — read this suggestion as
              style, not a fix.
            </p>
          ) : null}
        </div>
      ) : null}

      <button className="btn ghost reanalyze" onClick={onReanalyze} disabled={loading}>
        {loading ? 'Re-analysing…' : 'Re-analyse'}
      </button>
    </div>
  )
}
