import { useState } from 'react'
import type { Color, MoveAnalysis } from '../engine/types'
import type { EngineEval } from '../engine/stockfish'
import { CATEGORY_LABELS } from '../rules'
import Board from './Board'
import { confidenceLabel, materialText, statusMeta } from './format'

export interface EngineState {
  enabled: boolean
  supported: boolean
  loading: boolean
  error?: string
  before?: EngineEval
  after?: EngineEval
}

interface Props {
  analysis: MoveAnalysis
  selectedColor: Color
  filterText: string
  filterCategory: string
  engine: EngineState
}

const CHECKLIST = [
  'Is my king safe?',
  'Is there a tactic for either side?',
  'What does my opponent want?',
  'What is my worst piece?',
  'Should I trade or keep tension?',
  'What are my pawn breaks — are my pieces ready for them?',
  'Am I improving my position or just making a move?',
  'If sacrificing, do I have forcing moves and enough attackers?',
  'If simplifying, is the resulting endgame good for me?',
]

function EngineLine({ engine, selectedColor }: { engine: EngineState; selectedColor: Color }) {
  if (!engine.enabled) return null
  if (!engine.supported) {
    return <div className="engine-line muted">Engine not available in this browser.</div>
  }
  if (engine.loading) return <div className="engine-line muted">Engine thinking…</div>
  if (engine.error) return <div className="engine-line muted">Engine unavailable: {engine.error}</div>
  const fmt = (e?: EngineEval) => {
    if (!e) return '—'
    if (e.mateIn !== undefined) return `#${e.mateIn}`
    if (e.scorePawns === undefined) return '—'
    const fromSel = selectedColor === 'w' ? e.scorePawns : -e.scorePawns
    return (fromSel >= 0 ? '+' : '') + fromSel.toFixed(2)
  }
  let swing = ''
  if (
    engine.before?.scorePawns !== undefined &&
    engine.after?.scorePawns !== undefined &&
    engine.before.mateIn === undefined &&
    engine.after.mateIn === undefined
  ) {
    const b = selectedColor === 'w' ? engine.before.scorePawns : -engine.before.scorePawns
    const a = selectedColor === 'w' ? engine.after.scorePawns : -engine.after.scorePawns
    const d = a - b
    if (d <= -1.5) swing = ` — the engine sees this dropping about ${Math.abs(d).toFixed(1)} pawns for you`
    else if (d >= 1.5) swing = ` — the engine sees this gaining about ${d.toFixed(1)} pawns for you`
  }
  return (
    <div className="engine-line">
      <strong>Engine (support only):</strong> before {fmt(engine.before)}, after {fmt(engine.after)}
      {swing}. This is a cross-check on tactics, not the strategic verdict.
    </div>
  )
}

export default function AnalysisPanel({ analysis, selectedColor, filterText, filterCategory, engine }: Props) {
  const [showChecklist, setShowChecklist] = useState(false)
  const colorName = analysis.color === 'w' ? 'White' : 'Black'
  const highlight = { from: analysis.from, to: analysis.to }

  const findings = analysis.findings.filter((f) => {
    if (filterCategory !== 'all' && f.category !== filterCategory) return false
    if (filterText.trim()) {
      const q = filterText.toLowerCase()
      if (!f.title.toLowerCase().includes(q) && !f.explanation.toLowerCase().includes(q)) return false
    }
    return true
  })

  return (
    <div className="analysis">
      <div className="analysis-head">
        <h2>
          {analysis.moveNumber}
          {analysis.color === 'w' ? '.' : '…'} {analysis.san}{' '}
          <span className="by">{colorName}</span>
        </h2>
        <div className="material">
          {materialText(analysis.materialBefore)} → {materialText(analysis.materialAfter)}
        </div>
      </div>

      <div className="boards">
        <Board fen={analysis.fenBefore} orientation={selectedColor} highlight={{ from: highlight.from }} caption="Before" />
        <Board fen={analysis.fenAfter} orientation={selectedColor} highlight={highlight} caption="After" />
      </div>

      <EngineLine engine={engine} selectedColor={selectedColor} />

      {!analysis.bySelected ? (
        <p className="note">{analysis.humanLesson}</p>
      ) : (
        <>
          <div className="lesson">
            <span className="lesson-label">Human lesson</span>
            <p>{analysis.humanLesson}</p>
          </div>

          {analysis.tacticalWarnings.length > 0 && (
            <div className="warnings">
              {analysis.tacticalWarnings.map((w, i) => (
                <div key={i} className={`warning ${w.severity}`}>
                  <span className="warn-tag">{w.severity === 'danger' ? 'Tactical danger' : w.severity === 'warning' ? 'Tactical warning' : 'Tactical note'}</span>
                  <span>{w.text}</span>
                </div>
              ))}
            </div>
          )}

          <div className="findings">
            <h3>
              Relevant rules of thumb{' '}
              <span className="count">
                ({findings.length}
                {findings.length !== analysis.findings.length ? ` of ${analysis.findings.length}` : ''})
              </span>
            </h3>
            {findings.length === 0 && <p className="muted">No rules match the current filter for this move.</p>}
            {findings.map((f) => {
              const meta = statusMeta(f.status)
              return (
                <div className="finding" key={f.ruleId}>
                  <div className="finding-top">
                    <span className={`badge ${meta.cls}`}>
                      {meta.icon} {meta.label}
                    </span>
                    <span className="finding-title">{f.title}</span>
                    <span className={`conf conf-${f.confidence}`}>{confidenceLabel(f.confidence)}</span>
                  </div>
                  <div className="finding-cat">{CATEGORY_LABELS[f.category]}</div>
                  <p className="finding-exp">{f.explanation}</p>
                  {f.alternatives && f.alternatives.length > 0 && (
                    <ul className="alts">
                      {f.alternatives.map((a, i) => (
                        <li key={i}>
                          <span className="alt-kind">{a.kind.replace(/-/g, ' ')}</span> — {a.text}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )
            })}
          </div>

          {analysis.alternatives.length > 0 && (
            <div className="candidates">
              <h3>Candidate ideas</h3>
              <ul>
                {analysis.alternatives.map((a, i) => (
                  <li key={i}>
                    <span className="alt-kind">{a.kind.replace(/-/g, ' ')}</span> — {a.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <div className="fen-block">
        <button className="link-btn" onClick={() => setShowChecklist((s) => !s)}>
          {showChecklist ? 'Hide' : 'Show'} thinking checklist
        </button>
        {showChecklist && (
          <ol className="checklist">
            {CHECKLIST.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ol>
        )}
        <div className="fens">
          <code title="FEN before">{analysis.fenBefore}</code>
          <code title="FEN after">{analysis.fenAfter}</code>
        </div>
      </div>
    </div>
  )
}
