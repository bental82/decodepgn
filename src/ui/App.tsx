import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parsePgn, toGameMoves, toTargets } from '../game'
import { analyze } from '../lib/api'
import type { Focus, MoveResult, ParsedMove } from '../shared/types'
import { colorName } from './contract'
import Board from './Board'
import MoveList from './MoveList'
import MoveAnalysis from './MoveAnalysis'
import PgnInput from './PgnInput'
import RelevanceMap from './RelevanceMap'
import RulesReference from './RulesReference'
import Settings from './Settings'

const KEY_STORAGE = 'decodepgn.apiKey'
type Tab = 'move' | 'map' | 'rules'

export default function App() {
  const [phase, setPhase] = useState<'input' | 'game'>('input')
  const [headers, setHeaders] = useState<Record<string, string>>({})
  const [moves, setMoves] = useState<ParsedMove[]>([])
  const [focus, setFocus] = useState<Focus>('w')
  const [selectedPly, setSelectedPly] = useState(0)
  const [results, setResults] = useState<Record<number, MoveResult>>({})
  const [loadingPlies, setLoadingPlies] = useState<Set<number>>(new Set())
  const [errorByPly, setErrorByPly] = useState<Record<number, string>>({})
  const [parseError, setParseError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('move')
  const [highlightRule, setHighlightRule] = useState<number | undefined>()
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem(KEY_STORAGE) || '')
  const [showSettings, setShowSettings] = useState(false)
  const [allProgress, setAllProgress] = useState<{ done: number; total: number } | null>(null)
  // Bumped whenever we load a new game; late responses from an old game are dropped.
  const genRef = useRef(0)

  const analyzePlies = useCallback(
    async (mvs: ParsedMove[], f: Focus, plies: number[]) => {
      const targets = plies.filter((ply) => mvs[ply] && mvs[ply].color === f)
      if (!targets.length) return
      const gen = genRef.current
      setLoadingPlies((prev) => new Set([...prev, ...targets]))
      setErrorByPly((prev) => {
        const c = { ...prev }
        targets.forEach((p) => delete c[p])
        return c
      })
      try {
        const resp = await analyze({
          focus: f,
          game: toGameMoves(mvs),
          targets: toTargets(mvs, targets),
          apiKey: apiKey.trim() || undefined,
        })
        if (genRef.current !== gen) return
        const returned = new Set(resp.results.map((r) => r.ply))
        setResults((prev) => {
          const c = { ...prev }
          for (const r of resp.results) c[r.ply] = r
          // targets Claude skipped: record an empty result so we don't loop forever
          for (const p of targets) if (!returned.has(p) && !c[p]) c[p] = { ply: p, rules: [], lesson: '' }
          return c
        })
      } catch (e) {
        if (genRef.current !== gen) return
        const msg = e instanceof Error ? e.message : 'Analysis failed.'
        setErrorByPly((prev) => {
          const c = { ...prev }
          targets.forEach((p) => (c[p] = msg))
          return c
        })
        if (/api key|401|authentication/i.test(msg)) setShowSettings(true)
      } finally {
        if (genRef.current === gen) {
          setLoadingPlies((prev) => {
            const c = new Set(prev)
            targets.forEach((p) => c.delete(p))
            return c
          })
        }
      }
    },
    [apiKey],
  )

  const handleSubmit = (pgn: string, f: Focus) => {
    try {
      const g = parsePgn(pgn)
      genRef.current++
      setHeaders(g.headers)
      setMoves(g.moves)
      setFocus(f)
      setResults({})
      setErrorByPly({})
      setLoadingPlies(new Set())
      setParseError(null)
      setHighlightRule(undefined)
      const first = g.moves.find((m) => m.color === f)?.ply ?? 0
      setSelectedPly(first)
      setTab('move')
      setPhase('game')
    } catch (e) {
      setParseError(e instanceof Error ? e.message : 'Could not parse that PGN.')
    }
  }

  // Auto-analyse the selected move when it belongs to the studied colour and
  // hasn't been analysed (or errored) yet.
  useEffect(() => {
    if (phase !== 'game') return
    const m = moves[selectedPly]
    if (!m || m.color !== focus) return
    if (results[selectedPly] || loadingPlies.has(selectedPly) || errorByPly[selectedPly]) return
    void analyzePlies(moves, focus, [selectedPly])
  }, [phase, selectedPly, focus, moves, results, loadingPlies, errorByPly, analyzePlies])

  const handleAnalyzeAll = async () => {
    const plies = moves.filter((m) => m.color === focus && !results[m.ply]).map((m) => m.ply)
    if (!plies.length) {
      setTab('map')
      return
    }
    const gen = genRef.current
    const BATCH = 6
    const CONCURRENCY = 3
    const batches: number[][] = []
    for (let i = 0; i < plies.length; i += BATCH) batches.push(plies.slice(i, i + BATCH))
    setAllProgress({ done: 0, total: plies.length })
    let done = 0
    let next = 0
    const worker = async () => {
      while (next < batches.length && genRef.current === gen) {
        const chunk = batches[next++]
        await analyzePlies(moves, focus, chunk)
        done += chunk.length
        if (genRef.current === gen) setAllProgress({ done: Math.min(plies.length, done), total: plies.length })
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker))
    if (genRef.current === gen) {
      setAllProgress(null)
      setTab('map')
    }
  }

  const saveKey = (k: string) => {
    setApiKey(k)
    if (k.trim()) localStorage.setItem(KEY_STORAGE, k.trim())
    else localStorage.removeItem(KEY_STORAGE)
    setShowSettings(false)
  }

  const reset = () => {
    genRef.current++ // drop any in-flight analysis from the previous game
    setPhase('input')
    setMoves([])
    setResults({})
    setErrorByPly({})
    setLoadingPlies(new Set())
    setAllProgress(null)
    setParseError(null)
  }

  const openRule = (id: number) => {
    setHighlightRule(id)
    setTab('rules')
  }

  // keyboard navigation through the move list
  useEffect(() => {
    if (phase !== 'game') return
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return
      if (e.key === 'ArrowRight') setSelectedPly((p) => Math.min(moves.length - 1, p + 1))
      if (e.key === 'ArrowLeft') setSelectedPly((p) => Math.max(0, p - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, moves.length])

  const usage = useMemo(() => {
    const u: Record<number, number> = {}
    for (const r of Object.values(results)) for (const h of r.rules) u[h.id] = (u[h.id] || 0) + 1
    return u
  }, [results])

  const analyzed = useMemo(() => new Set(Object.keys(results).map(Number)), [results])
  const move = moves[selectedPly]
  const focusMovesRemaining = moves.filter((m) => m.color === focus && !results[m.ply]).length

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">♟</span>
          <div>
            <h1>DecodePGN</h1>
            <span className="tagline">which rules of thumb apply, move by move</span>
          </div>
        </div>
        {phase === 'game' && (
          <div className="topbar-right">
            <div className="game-meta">
              <strong>{headers.White ?? 'White'}</strong> vs <strong>{headers.Black ?? 'Black'}</strong>
              <span className="studying"> · studying {colorName(focus)}</span>
            </div>
            <button className="btn" onClick={handleAnalyzeAll} disabled={!!allProgress}>
              {allProgress
                ? `Analysing… ${allProgress.done}/${allProgress.total}`
                : focusMovesRemaining
                  ? `Analyse all ${colorName(focus)} moves`
                  : 'All moves analysed'}
            </button>
            <button className="btn ghost" onClick={() => setShowSettings(true)} title="API key">
              ⚙
            </button>
            <button className="btn ghost" onClick={reset}>
              New game
            </button>
          </div>
        )}
      </header>

      {phase === 'input' ? (
        <div className="landing">
          <PgnInput
            onSubmit={handleSubmit}
            onOpenSettings={() => setShowSettings(true)}
            error={parseError}
            hasServerKey={true}
          />
          <IntroCard />
        </div>
      ) : (
        <div className="workspace">
          <aside className="left">
            <MoveList
              moves={moves}
              focus={focus}
              selectedPly={selectedPly}
              analyzed={analyzed}
              loading={loadingPlies}
              onSelect={setSelectedPly}
            />
          </aside>

          <main className="right">
            <div className="tabs">
              <button className={tab === 'move' ? 'active' : ''} onClick={() => setTab('move')}>
                This move
              </button>
              <button className={tab === 'map' ? 'active' : ''} onClick={() => setTab('map')}>
                By rule
              </button>
              <button className={tab === 'rules' ? 'active' : ''} onClick={() => setTab('rules')}>
                The 40 rules
              </button>
            </div>

            {tab === 'move' && move && (
              <div className="move-pane">
                <div className="move-head">
                  <h2>
                    {move.moveNumber}
                    {move.color === 'w' ? '.' : '…'} {move.san}{' '}
                    <span className="by">{colorName(move.color)}</span>
                  </h2>
                </div>
                <div className="boards">
                  <Board
                    fen={move.fenBefore}
                    orientation={focus}
                    lastMove={{ from: move.from, to: move.to }}
                    caption="Before"
                  />
                  <Board
                    fen={move.fenAfter}
                    orientation={focus}
                    lastMove={{ from: move.from, to: move.to }}
                    caption="After"
                  />
                </div>
                {move.color === focus ? (
                  <MoveAnalysis
                    move={move}
                    focus={focus}
                    result={results[selectedPly]}
                    loading={loadingPlies.has(selectedPly)}
                    error={errorByPly[selectedPly]}
                    onReanalyze={() => analyzePlies(moves, focus, [selectedPly])}
                    onOpenRule={openRule}
                  />
                ) : (
                  <p className="note">
                    This is {colorName(move.color)}’s move. You’re studying {colorName(focus)}, so pick one of
                    your own moves (highlighted in the list) to see which rules apply.
                  </p>
                )}
              </div>
            )}

            {tab === 'map' && (
              <RelevanceMap
                moves={moves}
                focus={focus}
                results={results}
                onJump={(ply) => {
                  setSelectedPly(ply)
                  setTab('move')
                }}
                onPickRule={openRule}
              />
            )}

            {tab === 'rules' && (
              <RulesReference highlightId={highlightRule} usage={usage} onPickRule={setHighlightRule} />
            )}
          </main>
        </div>
      )}

      {showSettings && (
        <Settings
          apiKey={apiKey}
          hasServerKey={true}
          onSave={saveKey}
          onClose={() => setShowSettings(false)}
        />
      )}

      <footer className="foot">
        Explanations are AI-generated coaching for club players — they use “may”, “appears”, “likely” on
        purpose. Treat them as prompts for your own thinking, not gospel.
      </footer>
    </div>
  )
}

function IntroCard() {
  return (
    <div className="intro card">
      <h2>What this does</h2>
      <p>
        Paste a game and pick a side. For each of your moves, Claude points out which of{' '}
        <strong>40 classic strategic “rules of thumb”</strong> are relevant right then — trades, pawn
        breaks, tension, king safety, sacrifices and more — and whether the move follows, partly follows,
        or goes against each one, with a one-line reason and a short lesson.
      </p>
      <ul>
        <li>Click any of your moves to see the rules that apply there.</li>
        <li>“By rule” shows where in the game each rule came up.</li>
        <li>“The 40 rules” is the full reference, always readable.</li>
      </ul>
      <p className="muted small">
        The analysis runs through Claude. On a deployment with a server key it just works; otherwise add
        your own Anthropic key in Settings (it stays in your browser).
      </p>
    </div>
  )
}
