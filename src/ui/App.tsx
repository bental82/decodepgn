import { useEffect, useReducer, useRef, useState } from 'react'
import { analyzeGame } from '../engine/analyzer'
import type { EngineEval } from '../engine/stockfish'
import { Stockfish, getStockfish } from '../engine/stockfish'
import type { Color, GameAnalysis } from '../engine/types'
import { CATEGORY_LABELS } from '../rules'
import AnalysisPanel, { type EngineState } from './AnalysisPanel'
import MoveList from './MoveList'
import PgnInput from './PgnInput'
import SummaryTab from './SummaryTab'

export default function App() {
  const [analysis, setAnalysis] = useState<GameAnalysis | null>(null)
  const [selectedPly, setSelectedPly] = useState(0)
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'moves' | 'summary'>('moves')
  const [filterText, setFilterText] = useState('')
  const [filterCategory, setFilterCategory] = useState('all')

  const [engineEnabled, setEngineEnabled] = useState(false)
  const engineSupported = Stockfish.isSupported()
  const [engineErr, setEngineErr] = useState<string | undefined>()
  const [engineLoading, setEngineLoading] = useState(false)
  const evalCache = useRef(new Map<string, EngineEval>())
  const [, force] = useReducer((x) => x + 1, 0)

  const handleAnalyze = (pgn: string, color: Color) => {
    setBusy(true)
    setError(undefined)
    // let the "Analysing…" state paint before the synchronous crunch
    setTimeout(() => {
      try {
        const result = analyzeGame(pgn, color)
        evalCache.current.clear()
        setAnalysis(result)
        setSelectedPly(result.moves.find((m) => m.bySelected)?.ply ?? 0)
        setTab('moves')
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Something went wrong parsing that game.')
      } finally {
        setBusy(false)
      }
    }, 30)
  }

  const reset = () => {
    setAnalysis(null)
    setError(undefined)
    setFilterText('')
    setFilterCategory('all')
  }

  // keyboard navigation through moves
  useEffect(() => {
    if (!analysis) return
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return
      if (e.key === 'ArrowRight') setSelectedPly((p) => Math.min(analysis.moves.length - 1, p + 1))
      if (e.key === 'ArrowLeft') setSelectedPly((p) => Math.max(0, p - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [analysis])

  // optional engine evaluation of the selected move
  useEffect(() => {
    if (!engineEnabled || !analysis) return
    const move = analysis.moves[selectedPly]
    if (!move) return
    let cancelled = false
    const run = async () => {
      const sf = getStockfish()
      setEngineLoading(true)
      setEngineErr(undefined)
      try {
        for (const fen of [move.fenBefore, move.fenAfter]) {
          if (!evalCache.current.has(fen)) {
            const ev = await sf.evaluate(fen, 12)
            if (cancelled) return
            evalCache.current.set(fen, ev)
            force()
          }
        }
      } catch (e) {
        if (!cancelled) setEngineErr(e instanceof Error ? e.message : 'engine error')
      } finally {
        if (!cancelled) setEngineLoading(false)
      }
    }
    run()
    return () => {
      cancelled = true
    }
  }, [engineEnabled, selectedPly, analysis])

  const move = analysis?.moves[selectedPly]
  const engineState: EngineState = {
    enabled: engineEnabled,
    supported: engineSupported,
    loading: engineLoading,
    error: engineErr,
    before: move ? evalCache.current.get(move.fenBefore) : undefined,
    after: move ? evalCache.current.get(move.fenAfter) : undefined,
  }

  const jumpTo = (ply: number) => {
    setSelectedPly(ply)
    setTab('moves')
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">♞</span>
          <div>
            <h1>DecodePGN</h1>
            <span className="tagline">Learn the “why” behind every move</span>
          </div>
        </div>
        {analysis && (
          <div className="topbar-right">
            <div className="game-meta">
              <strong>{analysis.headers.White ?? 'White'}</strong> vs{' '}
              <strong>{analysis.headers.Black ?? 'Black'}</strong>
              {analysis.headers.Result ? <span className="result"> · {analysis.headers.Result}</span> : null}
            </div>
            <label className="engine-toggle" title={engineSupported ? '' : 'Not supported in this browser'}>
              <input
                type="checkbox"
                checked={engineEnabled}
                disabled={!engineSupported}
                onChange={(e) => setEngineEnabled(e.target.checked)}
              />
              Engine cross-check
            </label>
            <button className="btn ghost" onClick={reset}>
              New game
            </button>
          </div>
        )}
      </header>

      {!analysis ? (
        <div className="landing">
          <PgnInput onAnalyze={handleAnalyze} error={error} busy={busy} />
          <IntroCard />
        </div>
      ) : (
        <div className="workspace">
          <aside className="left">
            <div className="tabs">
              <button className={tab === 'moves' ? 'active' : ''} onClick={() => setTab('moves')}>
                Move analysis
              </button>
              <button className={tab === 'summary' ? 'active' : ''} onClick={() => setTab('summary')}>
                Summary
              </button>
            </div>
            <MoveList
              moves={analysis.moves}
              selectedPly={selectedPly}
              selectedColor={analysis.selectedColor}
              onSelect={setSelectedPly}
            />
          </aside>

          <main className="right">
            {tab === 'summary' ? (
              <SummaryTab summary={analysis.summary} onJumpTo={jumpTo} />
            ) : (
              <>
                <div className="filterbar">
                  <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
                    <option value="all">All rule categories</option>
                    {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                  <input
                    type="search"
                    placeholder="Filter rules by keyword…"
                    value={filterText}
                    onChange={(e) => setFilterText(e.target.value)}
                  />
                </div>
                {move && (
                  <AnalysisPanel
                    analysis={move}
                    selectedColor={analysis.selectedColor}
                    filterText={filterText}
                    filterCategory={filterCategory}
                    engine={engineState}
                  />
                )}
              </>
            )}
          </main>
        </div>
      )}

      <footer className="foot">
        Educational heuristics for club players — explanations use “may”, “appears”, “likely” on purpose.
        Not a substitute for your own calculation.
      </footer>
    </div>
  )
}

function IntroCard() {
  return (
    <div className="intro card">
      <h2>What this does</h2>
      <p>
        Paste a game, pick a side, and step through the moves. For each move by your chosen colour, DecodePGN
        names the strategic <em>rules of thumb</em> that apply, explains why, and says whether the move follows,
        partly follows, or goes against each one — plus a plain-English lesson and a tactical safety check.
      </p>
      <ul>
        <li>Trading, minor-piece, rook and endgame principles</li>
        <li>Pawn breaks, tension, the centre and flank attacks</li>
        <li>Weaknesses, plans and king-side sacrifices</li>
      </ul>
      <p className="muted small">
        It teaches decision-making, so it leans on transparent heuristics rather than a raw engine score. Turn
        the engine on any time as a tactical cross-check.
      </p>
    </div>
  )
}
