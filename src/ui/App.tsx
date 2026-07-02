import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parsePgn, toGameMoves, toTargets } from '../game'
import { analyze, overview as fetchOverviewApi } from '../lib/api'
import { engineAvailable, evaluateMove } from '../lib/engine'
import {
  gameKey,
  listGames,
  loadGame,
  removeGame,
  saveGame,
  type SavedGame,
  type SavedQuiz,
} from '../lib/store'
import { RULE_COUNT } from '../shared/rules'
import { isStudied } from '../shared/types'
import type { EngineEval, Focus, GameOverview, MoveResult, ParsedMove } from '../shared/types'
import { colorName } from './contract'
import AskBox from './AskBox'
import Board from './Board'
import GameImport from './GameImport'
import GameOverviewCard from './GameOverviewCard'
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
  // Identity of the current game in local storage, for persisting analysis.
  const storeRef = useRef<{ key: string; pgn: string } | null>(null)
  const [history, setHistory] = useState<SavedGame[]>(() => listGames())
  // The current game's generated quiz (persisted alongside the analysis).
  const [quizSaved, setQuizSaved] = useState<SavedQuiz | null>(null)
  // The whole-game overview (auto-generated on load, persisted with the game).
  const [gameOverview, setGameOverview] = useState<GameOverview | null>(null)
  // Where the user was reading before a chip jump, so one tap brings them back.
  const [jumpBack, setJumpBack] = useState<number | null>(null)
  const [overviewLoading, setOverviewLoading] = useState(false)
  const [overviewError, setOverviewError] = useState<string | null>(null)

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
      const targets = plies.filter((ply) => mvs[ply] && isStudied(mvs[ply].color, f))
      if (!targets.length) return
      const gen = genRef.current
      setLoadingPlies((prev) => new Set([...prev, ...targets]))
      setErrorByPly((prev) => {
        const c = { ...prev }
        targets.forEach((p) => delete c[p])
        return c
      })
      try {
        // Best-effort engine check per target (Stockfish in a worker); the AI
        // weighs it so objectively strong moves don't get scolded.
        const targetObjs = toTargets(mvs, targets)
        const engineByPly = new Map<number, EngineEval>()
        if (await engineAvailable()) {
          for (const t of targetObjs) {
            if (genRef.current !== gen) return
            const pm = mvs[t.ply]
            const ev = await evaluateMove(pm)
            if (ev) {
              t.engine = ev
              engineByPly.set(t.ply, ev)
            }
          }
        }
        const resp = await analyze({
          focus: f,
          game: toGameMoves(mvs),
          targets: targetObjs,
          apiKey: apiKey.trim() || undefined,
        })
        if (genRef.current !== gen) return
        const returned = new Set(resp.results.map((r) => r.ply))
        setResults((prev) => {
          const c = { ...prev }
          for (const r of resp.results) c[r.ply] = { ...r, engine: engineByPly.get(r.ply) }
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

  const handleSubmit = (pgn: string, f: Focus): boolean => {
    try {
      const g = parsePgn(pgn)
      genRef.current++
      // Restore any analysis previously saved for this exact game + side.
      const key = gameKey(g.moves, f)
      storeRef.current = { key, pgn }
      const saved = loadGame(key)
      setHeaders(g.headers)
      setMoves(g.moves)
      setFocus(f)
      setResults(saved?.results ?? {})
      setQuizSaved(saved?.quiz ?? null)
      setGameOverview(saved?.overview ?? null)
      setOverviewLoading(false)
      setOverviewError(null)
      setJumpBack(null)
      setErrorByPly({})
      setLoadingPlies(new Set())
      setQueuedPlies(new Set())
      setParseError(null)
      setHighlightRule(undefined)
      const first = g.moves.find((m) => isStudied(m.color, f))?.ply ?? 0
      setSelectedPly(first)
      setTab('move')
      setPhase('game')
      return true
    } catch (e) {
      setParseError(e instanceof Error ? e.message : 'Could not parse that PGN.')
      return false
    }
  }

  // Persist the analysis (PGN + per-move results), the quiz, and the overview,
  // so a reload or revisit of the same game restores everything.
  useEffect(() => {
    if (phase !== 'game' || !storeRef.current) return
    if (Object.keys(results).length === 0 && !quizSaved && !gameOverview) return
    saveGame({
      key: storeRef.current.key,
      pgn: storeRef.current.pgn,
      focus,
      headers,
      savedAt: Date.now(),
      results,
      quiz: quizSaved ?? undefined,
      overview: gameOverview ?? undefined,
    })
  }, [phase, results, focus, headers, quizSaved, gameOverview])

  const fetchOverview = useCallback(async () => {
    if (!moves.length) return
    const gen = genRef.current
    setOverviewLoading(true)
    setOverviewError(null)
    try {
      const resp = await fetchOverviewApi({
        mode: 'overview',
        focus,
        game: toGameMoves(moves),
        headers,
        apiKey: apiKey.trim() || undefined,
      })
      if (genRef.current !== gen) return
      setGameOverview(resp.overview)
    } catch (e) {
      if (genRef.current !== gen) return
      const msg = e instanceof Error ? e.message : 'Could not build the overview.'
      setOverviewError(msg)
      if (/api key|401|authentication/i.test(msg)) setShowSettings(true)
    } finally {
      if (genRef.current === gen) setOverviewLoading(false)
    }
  }, [moves, focus, headers, apiKey])

  // Every analysis starts with the whole-game overview — generate it once per
  // loaded game (restored games already have it and skip the call).
  useEffect(() => {
    if (phase !== 'game' || gameOverview || overviewLoading || overviewError) return
    void fetchOverview()
  }, [phase, gameOverview, overviewLoading, overviewError, fetchOverview])

  // Auto-analyse the selected move when it belongs to the studied colour and
  // hasn't been analysed (or errored) yet.
  useEffect(() => {
    if (phase !== 'game') return
    const m = moves[selectedPly]
    if (!m || !isStudied(m.color, focus)) return
    if (
      results[selectedPly] ||
      loadingPlies.has(selectedPly) ||
      queuedPlies.has(selectedPly) ||
      errorByPly[selectedPly]
    )
      return
    void analyzePlies(moves, focus, [selectedPly])
  }, [phase, selectedPly, focus, moves, results, loadingPlies, errorByPly, analyzePlies])

  const handleAnalyzeAll = async () => {
    const plies = moves.filter((m) => isStudied(m.color, focus) && !results[m.ply]).map((m) => m.ply)
    if (!plies.length) return
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
    }
  }

  // Analyse the WHOLE game automatically after a load: browsing stays instant
  // because every move is already (being) analysed in background batches.
  const autoRanRef = useRef<string | null>(null)
  useEffect(() => {
    if (phase !== 'game' || moves.length === 0) return
    const key = storeRef.current?.key ?? ''
    if (autoRanRef.current === key) return
    autoRanRef.current = key
    void handleAnalyzeAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, moves])

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
    setQuizSaved(null)
    setGameOverview(null)
    setOverviewLoading(false)
    setOverviewError(null)
    setJumpBack(null)
    setHistory(listGames())
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
  const focusMovesRemaining = moves.filter((m) => isStudied(m.color, focus) && !results[m.ply]).length
  const studiedPlies = useMemo(
    () => moves.filter((m) => isStudied(m.color, focus)).map((m) => m.ply),
    [moves, focus],
  )
  const analyzedFocus = studiedPlies.length - focusMovesRemaining

  // Step through EVERY ply (both sides) so the game's sequence is followable;
  // opponent moves show on the board with a note, studied moves get analysis.
  const stepPly = (dir: 1 | -1) => {
    setSelectedPly((p) => Math.min(moves.length - 1, Math.max(0, p + dir)))
  }

  // Chip jumps (overview key moments, by-rule chips) remember where the user
  // was reading; chained jumps keep the ORIGINAL spot until they return.
  const jumpTo = (ply: number) => {
    setJumpBack((prev) => (prev === null && ply !== selectedPly ? selectedPly : prev))
    setSelectedPly(ply)
    setTab('move')
  }
  const returnFromJump = () => {
    if (jumpBack !== null) setSelectedPly(jumpBack)
    setJumpBack(null)
  }
  const atFirst = selectedPly <= 0
  const atLast = moves.length === 0 || selectedPly >= moves.length - 1
  const prevMove = selectedPly > 0 ? moves[selectedPly - 1] : undefined
  const moveLabel = (m: ParsedMove) => `${m.moveNumber}${m.color === 'w' ? '.' : '…'} ${m.san}`

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
                    : `Analyse all ${studiedPlies.length} ${focus === 'both' ? '' : colorName(focus) + ' '}moves`}
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
          {history.length > 0 ? (
            <div className="history card">
              <h2>Your analysed games</h2>
              <ul className="history-list">
                {history.map((g) => (
                  <li key={g.key}>
                    <button className="history-row" onClick={() => handleSubmit(g.pgn, g.focus)}>
                      <span className="history-title">
                        {g.headers.White ?? 'White'} vs {g.headers.Black ?? 'Black'}
                      </span>
                      <span className="history-meta">
                        as {colorName(g.focus)} · {Object.keys(g.results).length} analysed
                        {g.quiz ? ' · quiz' : ''} ·{' '}
                        {new Date(g.savedAt).toLocaleDateString(undefined, {
                          day: 'numeric',
                          month: 'short',
                        })}
                      </span>
                    </button>
                    <button
                      className="history-del"
                      aria-label="Delete this saved analysis"
                      title="Delete this saved analysis"
                      onClick={() => {
                        removeGame(g.key)
                        setHistory(listGames())
                      }}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <PgnInput
            onSubmit={handleSubmit}
            onOpenSettings={() => setShowSettings(true)}
            error={parseError}
            hasServerKey={hasServerKey}
          />
          <IntroCard />
          <GameImport onPick={handleSubmit} />
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
              <GameOverviewCard
                overview={gameOverview}
                loading={overviewLoading}
                error={overviewError}
                moves={moves}
                onJump={jumpTo}
                onRetry={fetchOverview}
              />
              <StatusLegend />
              <div className="study">
              <div className="board-panel">
                {/* Only this wrapper is sticky on mobile — the progress strip
                    below scrolls away so the analysis text keeps real estate. */}
                <div className="board-sticky">
                <Board
                  fen={move.fenAfter}
                  orientation={focus === 'b' ? 'b' : 'w'}
                  lastMove={{ from: move.from, to: move.to }}
                />
                <div className="board-nav">
                  <button
                    className="navbtn"
                    onClick={() => setSelectedPly(0)}
                    disabled={atFirst}
                    aria-label="First move"
                  >
                    ⏮
                  </button>
                  <button
                    className="navbtn"
                    onClick={() => stepPly(-1)}
                    disabled={atFirst}
                    aria-label="Previous move"
                  >
                    ◀
                  </button>
                  <span className="navlabel">
                    {moveLabel(move)}
                    {!isStudied(move.color, focus) && <span className="nav-opp"> · opponent</span>}
                  </span>
                  <button
                    className="navbtn"
                    onClick={() => stepPly(1)}
                    disabled={atLast}
                    aria-label="Next move"
                  >
                    ▶
                  </button>
                  <button
                    className="navbtn"
                    onClick={() => moves.length && setSelectedPly(moves.length - 1)}
                    disabled={atLast}
                    aria-label="Last move"
                  >
                    ⏭
                  </button>
                </div>
                {jumpBack !== null && jumpBack !== selectedPly && moves[jumpBack] ? (
                  <button className="jump-back" onClick={returnFromJump}>
                    ↩ Back to {moveLabel(moves[jumpBack])}
                  </button>
                ) : null}
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
                  <span className="explain-move">{moveLabel(move)}</span>
                  <span className="explain-side">
                    {isStudied(move.color, focus)
                      ? `${colorName(move.color)} — your move`
                      : `${colorName(move.color)} — opponent`}
                  </span>
                </div>
                {isStudied(move.color, focus) && prevMove ? (
                  <p className="reply-to">
                    In reply to {colorName(prevMove.color)}’s <strong>{moveLabel(prevMove)}</strong>
                  </p>
                ) : null}
                {isStudied(move.color, focus) ? (
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
                    {colorName(move.color)} played <strong>{moveLabel(move)}</strong>. Press ▶ to see{' '}
                    {colorName(focus)}’s reply and its analysis.
                  </p>
                )}
                <AskBox
                  key={selectedPly} // remount per move so answers never carry over
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
              key={storeRef.current?.key ?? 'quiz'} // remount per game
              moves={moves}
              focus={focus}
              apiKey={apiKey}
              onNeedKey={() => setShowSettings(true)}
              onOpenRule={openRule}
              saved={quizSaved}
              onSave={setQuizSaved}
            />
          )}

          {tab === 'map' && (
            <div className="map-tab">
              <GameSummary moves={moves} focus={focus} results={results} onPickRule={openRule} />
              <RelevanceMap
                moves={moves}
                focus={focus}
                results={results}
                onJump={jumpTo}
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
