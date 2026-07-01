import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parsePgn, toGameMoves, toTargets } from '../game'
import { analyze } from '../lib/api'
import { RULE_COUNT } from '../shared/rules'
import type { Focus, MoveResult, ParsedMove } from '../shared/types'
import { colorName } from './contract'
import AskBox from './AskBox'
import Board from './Board'
import GameSummary from './GameSummary'
import MoveAnalysis from './MoveAnalysis'
import PieceSprite from './PieceSprite'
import PgnInput from './PgnInput'
import Quiz from './Quiz'
import RelevanceMap from './RelevanceMap'
import RulesReference from './RulesReference'
import Settings from './Settings'
import StatusLegend from './StatusLegend'

const KEY_STORAGE = 'decodepgn.apiKey'
type Tab = 'move' | 'quiz' | 'map' | 'rules'

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
  const [hasServerKey, setHasServerKey] = useState(false)
  const [allProgress, setAllProgress] = useState<{ done: number; total: number } | null>(null)
  // Plies enqueued by "Analyse all" (for the per-move queued/loading indicator).
  const [queuedPlies, setQueuedPlies] = useState<Set<number>>(new Set())
  // Bumped whenever we load a new game; late responses from an old game are dropped.
  const genRef = useRef(0)

  // Learn whether the deployment has its own key, so we can be honest about
  // whether the user needs to bring one.
  useEffect(() => {
    let cancelled = false
    fetch('/api/analyze', { method: 'GET' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d && typeof d.hasServerKey === 'boolean') setHasServerKey(d.hasServerKey)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

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
      setQueuedPlies(new Set())
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
    setQueuedPlies(new Set(plies))
    setAllProgress({ done: 0, total: plies.length })
    let done = 0
    let next = 0
    const worker = async () => {
      while (next < batches.length && genRef.current === gen) {
        const chunk = batches[next++]
        setQueuedPlies((prev) => {
          const c = new Set(prev)
          chunk.forEach((p) => c.delete(p)) // no longer queued — now in flight
          return c
        })
        await analyzePlies(moves, focus, chunk)
        done += chunk.length
        if (genRef.current === gen) setAllProgress({ done: Math.min(plies.length, done), total: plies.length })
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker))
    if (genRef.current === gen) {
      setAllProgress(null)
      setQueuedPlies(new Set())
      setTab('map')
    }
  }

  const saveKey = (k: string) => {
    setApiKey(k)
    if (k.trim()) localStorage.setItem(KEY_STORAGE, k.trim())
    else localStorage.removeItem(KEY_STORAGE)
    // clear stuck errors so the auto-analyse effect retries with the new key
    setErrorByPly({})
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
    setQueuedPlies(new Set())
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

  const move = moves[selectedPly]
  const focusMovesRemaining = moves.filter((m) => m.color === focus && !results[m.ply]).length
  const studiedPlies = useMemo(
    () => moves.filter((m) => m.color === focus).map((m) => m.ply),
    [moves, focus],
  )
  const analyzedFocus = studiedPlies.length - focusMovesRemaining

  const stepStudied = (dir: 1 | -1) => {
    if (!studiedPlies.length) return
    const idx = studiedPlies.indexOf(selectedPly)
    if (idx === -1) {
      // currently on an opponent move — jump to the nearest studied move in that direction
      const target =
        dir > 0
          ? studiedPlies.find((p) => p > selectedPly)
          : [...studiedPlies].reverse().find((p) => p < selectedPly)
      setSelectedPly(target ?? studiedPlies[dir > 0 ? 0 : studiedPlies.length - 1])
      return
    }
    const ni = Math.min(studiedPlies.length - 1, Math.max(0, idx + dir))
    setSelectedPly(studiedPlies[ni])
  }
  const atFirstStudied = studiedPlies.length > 0 && selectedPly <= studiedPlies[0]
  const atLastStudied =
    studiedPlies.length > 0 && selectedPly >= studiedPlies[studiedPlies.length - 1]

  return (
    <div className="app">
      <PieceSprite />
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
            <button
              className="btn"
              onClick={handleAnalyzeAll}
              disabled={!!allProgress || focusMovesRemaining === 0}
            >
              {allProgress
                ? `Analysing… ${allProgress.done}/${allProgress.total}`
                : focusMovesRemaining === 0
                  ? 'All analysed ✓'
                  : analyzedFocus > 0
                    ? `Analyse remaining (${focusMovesRemaining})`
                    : `Analyse all ${studiedPlies.length} ${colorName(focus)} moves`}
            </button>
            <button
              className="btn ghost"
              onClick={() => setShowSettings(true)}
              title="API key"
              aria-label="API key settings"
            >
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
            hasServerKey={hasServerKey}
          />
          <IntroCard />
        </div>
      ) : (
        <div className="workspace">
          <div className="tabs">
            <button className={tab === 'move' ? 'active' : ''} onClick={() => setTab('move')}>
              Study
            </button>
            <button className={tab === 'quiz' ? 'active' : ''} onClick={() => setTab('quiz')}>
              Quiz
            </button>
            <button className={tab === 'map' ? 'active' : ''} onClick={() => setTab('map')}>
              By rule
            </button>
            <button className={tab === 'rules' ? 'active' : ''} onClick={() => setTab('rules')}>
              <span className="tab-long">The {RULE_COUNT} rules</span>
              <span className="tab-short">Rules</span>
            </button>
          </div>

          {tab === 'move' && move && (
            <>
              <StatusLegend />
              <div className="study">
              <div className="board-panel">
                <Board
                  fen={move.fenAfter}
                  orientation={focus}
                  lastMove={{ from: move.from, to: move.to }}
                />
                <div className="board-nav">
                  <button
                    className="navbtn"
                    onClick={() => studiedPlies.length && setSelectedPly(studiedPlies[0])}
                    disabled={atFirstStudied}
                    aria-label="First of your moves"
                  >
                    ⏮
                  </button>
                  <button
                    className="navbtn"
                    onClick={() => stepStudied(-1)}
                    disabled={atFirstStudied}
                    aria-label="Previous of your moves"
                  >
                    ◀
                  </button>
                  <span className="navlabel">
                    {move.moveNumber}
                    {move.color === 'w' ? '.' : '…'} {move.san}
                  </span>
                  <button
                    className="navbtn"
                    onClick={() => stepStudied(1)}
                    disabled={atLastStudied}
                    aria-label="Next of your moves"
                  >
                    ▶
                  </button>
                  <button
                    className="navbtn"
                    onClick={() =>
                      studiedPlies.length && setSelectedPly(studiedPlies[studiedPlies.length - 1])
                    }
                    disabled={atLastStudied}
                    aria-label="Last of your moves"
                  >
                    ⏭
                  </button>
                </div>
                {studiedPlies.length > 0 && (
                  <div className="analysis-progress">
                    <div className="movedots" aria-label="Your moves — analysis progress">
                      {studiedPlies.map((p) => {
                        const st = results[p]
                          ? 'done'
                          : loadingPlies.has(p)
                            ? 'loading'
                            : queuedPlies.has(p)
                              ? 'queued'
                              : 'pending'
                        const mm = moves[p]
                        const stLabel =
                          st === 'done'
                            ? 'analysed'
                            : st === 'loading'
                              ? 'analysing…'
                              : st === 'queued'
                                ? 'queued'
                                : 'not analysed'
                        return (
                          <button
                            key={p}
                            className={'movedot ' + st + (p === selectedPly ? ' active' : '')}
                            title={`${mm.moveNumber}${mm.color === 'w' ? '.' : '…'} ${mm.san} — ${stLabel}`}
                            aria-label={`Move ${mm.moveNumber} ${mm.san}, ${stLabel}`}
                            onClick={() => setSelectedPly(p)}
                          />
                        )
                      })}
                    </div>
                    <div className="progress-caption">
                      {analyzedFocus} of {studiedPlies.length} of your moves analysed
                      {focusMovesRemaining > 0 && !allProgress ? (
                        <button className="linkbtn" onClick={handleAnalyzeAll}>
                          Analyse remaining
                        </button>
                      ) : null}
                    </div>
                  </div>
                )}
              </div>
              <div className="explain-panel">
                <div className="explain-head">
                  <span className="explain-move">
                    {move.moveNumber}
                    {move.color === 'w' ? '.' : '…'} {move.san}
                  </span>
                  <span className="explain-side">
                    {move.color === focus
                      ? `${colorName(focus)} — your move`
                      : `${colorName(move.color)} to move`}
                  </span>
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
                    This is {colorName(move.color)}’s move. Use ◀ ▶ to step to one of your
                    moves and see which rules of thumb apply.
                  </p>
                )}
                <AskBox
                  context={{
                    focus,
                    game: toGameMoves(moves),
                    ply: selectedPly,
                    san: move.san,
                    fen: move.fenAfter,
                  }}
                  apiKey={apiKey}
                  onNeedKey={() => setShowSettings(true)}
                  label="Ask about this move"
                  placeholder="e.g. why is this move risky here?"
                />
              </div>
              </div>
            </>
          )}

          {tab === 'quiz' && (
            <Quiz
              moves={moves}
              focus={focus}
              apiKey={apiKey}
              onNeedKey={() => setShowSettings(true)}
              onOpenRule={openRule}
            />
          )}

          {tab === 'map' && (
            <div className="map-tab">
              <GameSummary moves={moves} focus={focus} results={results} onPickRule={openRule} />
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
            </div>
          )}

          {tab === 'rules' && (
            <RulesReference
              highlightId={highlightRule}
              usage={usage}
              onPickRule={setHighlightRule}
              apiKey={apiKey}
              onNeedKey={() => setShowSettings(true)}
            />
          )}
        </div>
      )}

      {showSettings && (
        <Settings
          apiKey={apiKey}
          hasServerKey={hasServerKey}
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
        <strong>{RULE_COUNT} classic strategic “rules of thumb”</strong> are relevant right then —
        development, trades, pawn breaks, tension, king safety, sacrifices, endgames and more — and
        whether the move follows, partly follows, or goes against each one, with a one-line reason and a
        short lesson.
      </p>
      <ul>
        <li>Click any of your moves to see the rules that apply there.</li>
        <li>“By rule” shows where in the game each rule came up.</li>
        <li>“The {RULE_COUNT} rules” is the full reference, always readable.</li>
      </ul>
      <p className="muted small">
        The analysis runs through Claude. On a deployment with a server key it just works; otherwise add
        your own Anthropic key in Settings (it stays in your browser).
      </p>
    </div>
  )
}
