import { useEffect, useRef } from 'react'
import { colorName } from './contract'
import type { MoveReaderProps } from './contract'
import MoveAnalysis from './MoveAnalysis'

// A single-column, annotated move list. Each move is a row; the selected move of
// the studied colour expands inline into its rules-of-thumb explanation, so the
// whole thing reads move by move. Mobile-friendly: pairs with a sticky board.
export default function MoveReader({
  moves,
  focus,
  selectedPly,
  results,
  loading,
  errors,
  onSelect,
  onReanalyze,
  onOpenRule,
}: MoveReaderProps) {
  const activeRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedPly])

  return (
    <div className="reader">
      <div className="reader-head">
        Move by move — studying <strong>{colorName(focus)}</strong>
      </div>
      <div className="reader-body">
        {moves.map((m) => {
          const studied = m.color === focus
          const active = m.ply === selectedPly
          let dotCls = 'dot'
          if (loading.has(m.ply)) dotCls += ' loading'
          else if (results[m.ply]) dotCls += ' analyzed'
          return (
            <div className="rgroup" key={m.ply} ref={active ? activeRef : undefined}>
              <button
                className={'rrow ' + (studied ? 'studied' : 'other') + (active ? ' active' : '')}
                onClick={() => onSelect(m.ply)}
                aria-current={active ? 'true' : undefined}
              >
                <span className="pnum">
                  {m.moveNumber}
                  {m.color === 'w' ? '.' : '…'}
                </span>
                <span className="rsan">{m.san}</span>
                {studied && <span className={dotCls} />}
              </button>
              {active && studied && (
                <div className="rexplain">
                  <MoveAnalysis
                    move={m}
                    focus={focus}
                    result={results[m.ply]}
                    loading={loading.has(m.ply)}
                    error={errors[m.ply]}
                    onReanalyze={() => onReanalyze(m.ply)}
                    onOpenRule={onOpenRule}
                  />
                </div>
              )}
              {active && !studied && (
                <div className="rexplain">
                  <p className="note">
                    {colorName(m.color)}’s move — tap one of your own moves (the bold rows) to see the ideas.
                  </p>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
