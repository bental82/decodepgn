import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import { parsePgn, toGameMoves, toTargets } from '../game'
import { analyze, meta as fetchMetaApi, overview as fetchOverviewApi, quiz as fetchQuizApi } from '../lib/api'
import { engineAvailable, evalAfterMoveWhite, evaluateMove } from '../lib/engine'
import { cloudDelete, cloudGet, cloudList, cloudSave, type CloudGameMeta } from '../lib/cloud'
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
import { summarizeGame } from '../shared/meta'
import { isStudied } from '../shared/types'
import type {
  BestMoveTarget,
  BoardAnnotations,
  Color,
  EngineEval,
  Focus,
  GameOverview,
  MoveResult,
  ParsedMove,
  QuizKind,
} from '../shared/types'
import { colorName } from './contract'
import type { GfxSelection } from './contract'
import AskBox from './AskBox'
import Board from './Board'
import GameImport from './GameImport'
import GameOverviewCard from './GameOverviewCard'
import GameSummary from './GameSummary'
import MetaCard, { type SavedMetaReport } from './MetaCard'
import MoveAnalysis from './MoveAnalysis'
import PieceSprite from './PieceSprite'
import PlayersModal from './PlayersModal'
import PgnInput from './PgnInput'
import Quiz from './Quiz'
import RelevanceMap from './RelevanceMap'
import RuleModal from './RuleModal'
import RulesReference from './RulesReference'
import Settings from './Settings'

const KEY_STORAGE = 'decodepgn.apiKey'
const META_KEY = 'decodepgn.meta.v1'
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
  // A rule opened as a popup (from the move card / by-rule map / quiz).
  const [ruleModalId, setRuleModalId] = useState<number | null>(null)
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem(KEY_STORAGE) || '')
  const [showSettings, setShowSettings] = useState(false)
  // Player-names / "which one is me" editor.
  const [showPlayers, setShowPlayers] = useState(false)
  // Which side the user flagged as themselves (persisted per game).
  const [mySide, setMySide] = useState<Color | undefined>(undefined)
  // Cross-game meta-analysis (persisted locally so the landing shows it).
  const [metaReport, setMetaReport] = useState<SavedMetaReport | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(META_KEY) || 'null')
    } catch {
      return null
    }
  })
  const [metaLoading, setMetaLoading] = useState(false)
  const [metaError, setMetaError] = useState<string | null>(null)
  // Landing history card collapsed state (survives reloads).
  const [histOpen, setHistOpen] = useState<boolean>(
    () => localStorage.getItem('decodepgn.historyOpen') !== '0',
  )
  // Game keys with an analyse-all run still going (survives leaving the game
  // view; the landing list shows a live badge for them).
  const [bgAnalysing, setBgAnalysing] = useState<Set<string>>(new Set())
  const [hasServerKey, setHasServerKey] = useState(false)
  const [allProgress, setAllProgress] = useState<{ done: number; total: number } | null>(null)
  // Plies enqueued by "Analyse all" (for the per-move queued/loading indicator).
  const [queuedPlies, setQueuedPlies] = useState<Set<number>>(new Set())
  // Bumped whenever we load a new game; late responses from an old game are dropped.
  const genRef = useRef(0)
  // Identity of the current game in local storage, for persisting analysis.
  const storeRef = useRef<{ key: string; pgn: string } | null>(null)
  const [history, setHistory] = useState<SavedGame[]>(() => listGames())
  // Games saved in the cloud (Supabase via /api/games); null while loading or
  // when the deployment has no database configured.
  const [cloudGames, setCloudGames] = useState<CloudGameMeta[] | null>(null)
  // The current game's generated quiz (persisted alongside the analysis).
  // Owned here — NOT in the Quiz tab — so generation keeps running and nothing
  // is lost when the user switches tabs mid-way.
  const [quizSaved, setQuizSaved] = useState<SavedQuiz | null>(null)
  const [quizLoading, setQuizLoading] = useState(false)
  const [quizError, setQuizError] = useState<string | null>(null)
  // The whole-game overview (auto-generated on load, persisted with the game).
  const [gameOverview, setGameOverview] = useState<GameOverview | null>(null)
  // Where the user was reading before a chip jump, so one tap brings them back.
  const [jumpBack, setJumpBack] = useState<number | null>(null)
  // What the sticky board is illustrating for the selected move ('auto' = the
  // key rule's graphics). Reset whenever the move changes.
  const [gfx, setGfx] = useState<GfxSelection>({ kind: 'auto' })
  // Compact board (mobile): more room for the analysis text.
  const [boardMini, setBoardMini] = useState<boolean>(
    () => localStorage.getItem('decodepgn.boardMini') === '1',
  )
  // ply -> centipawns after that move, from White's perspective (eval bar).
  const [evals, setEvals] = useState<Record<number, number>>({})
  const explainRef = useRef<HTMLDivElement | null>(null)
  const stickyRef = useRef<HTMLDivElement | null>(null)
  const [showToTop, setShowToTop] = useState(false)
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

  // Pull the cloud game list once — games analysed on other devices (or before
  // this browser's storage was cleared) show up in the history.
  useEffect(() => {
    let cancelled = false
    void cloudList().then((games) => {
      if (!cancelled && games) setCloudGames(games)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Latest results, readable from stable callbacks (analyzePlies reuses saved
  // engine checks on re-analysis without re-creating itself on every result).
  const resultsRef = useRef(results)
  resultsRef.current = results
  // Latest headers, for background writes after the user leaves the game view.
  const headersRef = useRef(headers)
  headersRef.current = headers

  interface AnalysisRun {
    gen: number
    key: string
    pgn: string
    headers: Record<string, string>
  }

  const analyzePlies = useCallback(
    async (mvs: ParsedMove[], f: Focus, plies: number[], run?: AnalysisRun) => {
      const targets = plies.filter((ply) => mvs[ply] && isStudied(mvs[ply].color, f))
      if (!targets.length) return
      // The run context is captured when the RUN starts (game on screen), not
      // when this batch starts: an analyse-all keeps dispatching batches after
      // the user leaves, and by then genRef/storeRef describe a different view.
      // Without this, late batches would write into the wrong place.
      const origin = run ?? {
        gen: genRef.current,
        key: storeRef.current?.key ?? '',
        pgn: storeRef.current?.pgn ?? '',
        headers: headersRef.current,
      }
      const gen = origin.gen
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
        // Re-analysis: the position hasn't changed, so a previously computed
        // engine check is still valid — reuse it instead of re-running
        // Stockfish (which made "Re-analyse" feel unresponsive for ~30s).
        const pending: typeof targetObjs = []
        for (const t of targetObjs) {
          const prior = resultsRef.current[t.ply]?.engine
          if (prior) {
            t.engine = prior
            engineByPly.set(t.ply, prior)
          } else {
            pending.push(t)
          }
        }
        if (pending.length > 0 && (await engineAvailable())) {
          for (const t of pending) {
            const pm = mvs[t.ply]
            const ev = await evaluateMove(pm)
            if (ev) {
              t.engine = ev
              engineByPly.set(t.ply, ev)
            }
          }
        }
        const req = {
          focus: f,
          game: toGameMoves(mvs),
          targets: targetObjs,
          apiKey: apiKey.trim() || undefined,
        }
        // One retry: a transient stall (or a response that never finishes
        // arriving) costs one timeout instead of losing the whole batch.
        const resp = await analyze(req).catch(async () => {
          await new Promise((r) => setTimeout(r, 2000))
          return analyze(req)
        })
        const returned = new Set(resp.results.map((r) => r.ply))
        if (genRef.current === gen) {
          // still looking at this game — update the view (persistence follows
          // via the save effect)
          setResults((prev) => {
            const c = { ...prev }
            for (const r of resp.results) c[r.ply] = { ...r, engine: engineByPly.get(r.ply) }
            // targets Claude skipped: record an empty result so we don't loop forever
            for (const p of targets) if (!returned.has(p) && !c[p]) c[p] = { ply: p, rules: [], lesson: '' }
            return c
          })
        } else if (origin.key) {
          // the user moved on — merge the batch straight into the game's save
          // (unless they deleted it meanwhile) and refresh the landing list
          const saved =
            loadGame(origin.key) ??
            ({
              key: origin.key,
              pgn: origin.pgn,
              focus: f,
              headers: origin.headers,
              savedAt: Date.now(),
              results: {},
            } as SavedGame)
          const merged: SavedGame = { ...saved, savedAt: Date.now(), results: { ...saved.results } }
          for (const r of resp.results) merged.results[r.ply] = { ...r, engine: engineByPly.get(r.ply) }
          saveGame(merged)
          cloudSave(merged)
          setHistory(listGames())
        }
      } catch (e) {
        if (genRef.current !== gen) return // background batch failed — retry next open
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
      // saved headers win: they carry the user's player-name edits
      setHeaders(saved?.headers ?? g.headers)
      setMoves(g.moves)
      setFocus(f)
      setResults(saved?.results ?? {})
      setQuizSaved(saved?.quiz ?? null)
      setQuizLoading(false)
      setQuizError(null)
      setGameOverview(saved?.overview ?? null)
      setEvals(saved?.evals ?? {})
      // The studied side IS the user unless they said otherwise; when both
      // sides are studied we can't guess — ask right away.
      setMySide(saved?.me ?? (f !== 'both' ? f : undefined))
      setOverviewLoading(false)
      setOverviewError(null)
      setJumpBack(null)
      setGfx({ kind: 'auto' })
      setErrorByPly({})
      setLoadingPlies(new Set())
      setQueuedPlies(new Set())
      setParseError(null)
      setHighlightRule(undefined)
      const first = g.moves.find((m) => isStudied(m.color, f))?.ply ?? 0
      setSelectedPly(first)
      setTab('move')
      setPhase('game')
      if (f === 'both' && !saved?.me) setShowPlayers(true)
      return true
    } catch (e) {
      setParseError(e instanceof Error ? e.message : 'Could not parse that PGN.')
      return false
    }
  }

  // Persist the analysis (PGN + per-move results), the quiz, and the overview,
  // so a reload or revisit of the same game restores everything. The same
  // object mirrors to the cloud (debounced, best-effort).
  useEffect(() => {
    if (phase !== 'game' || !storeRef.current) return
    if (Object.keys(results).length === 0 && !quizSaved && !gameOverview) return
    const game: SavedGame = {
      key: storeRef.current.key,
      pgn: storeRef.current.pgn,
      focus,
      headers,
      savedAt: Date.now(),
      results,
      quiz: quizSaved ?? undefined,
      overview: gameOverview ?? undefined,
      evals: Object.keys(evals).length ? evals : undefined,
      me: mySide,
    }
    saveGame(game)
    cloudSave(game)
  }, [phase, results, focus, headers, quizSaved, gameOverview, evals, mySide])

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

  // Positions the best-move quiz can draw on: analysed moves of the studied
  // side that carry an engine check or an AI alternative. Missed better moves
  // come first (that's the point of the quiz); strong moves the player FOUND
  // fill a few remaining slots as reinforcement.
  const bestMoveTargets = useMemo<BestMoveTarget[]>(() => {
    const cands = moves
      .filter((m) => isStudied(m.color, focus))
      .map((m) => ({ m, r: results[m.ply] }))
      .filter((x): x is { m: ParsedMove; r: MoveResult } => !!x.r && (!!x.r.engine || !!x.r.alternative))
    // A position only quizzes something if there was a real choice: skip
    // automatic recaptures and (near-)forced positions — they teach nothing.
    const isObvious = (m: ParsedMove) => {
      const prev = moves[m.ply - 1]
      if (prev && prev.san.includes('x') && m.san.includes('x') && m.to === prev.to) return true
      try {
        return new Chess(m.fenBefore).moves().length <= 2
      } catch {
        return true
      }
    }
    // "Find the better move": every position where one clearly existed — real
    // mistakes AND smaller inaccuracies, plus the AI's cleaner alternatives.
    const missed = cands.filter(
      ({ m, r }) =>
        m.moveNumber >= 3 &&
        !isObvious(m) &&
        ((r.engine && !r.engine.isBest && r.engine.cpLoss >= 30) ||
          (!r.engine && !!r.alternative) ||
          r.soundness === 'dubious'),
    )
    missed.sort((a, b) => (b.r.engine?.cpLoss ?? 0) - (a.r.engine?.cpLoss ?? 0))
    // Reinforcement: only once out of the opening book — "what's the best
    // first move?" is trivia, not training.
    const MAX = 10
    const found = cands.filter(
      (c) =>
        !missed.includes(c) &&
        c.m.moveNumber >= 8 &&
        !isObvious(c.m) &&
        !!c.r.engine &&
        (c.r.engine.isBest || c.r.engine.cpLoss < 30),
    )
    const picked = missed.slice(0, found.length ? MAX - Math.min(3, found.length) : MAX)
    picked.push(...found.slice(0, MAX - picked.length))
    return picked
      .sort((a, b) => a.m.ply - b.m.ply)
      .map(({ m, r }) => ({
        ply: m.ply,
        fenBefore: m.fenBefore,
        played: m.san,
        best: r.engine?.bestSan || undefined,
        cpLoss: r.engine?.cpLoss,
        alternative: r.alternative?.move,
      }))
  }, [moves, focus, results])

  const startQuiz = useCallback(
    async (kind: QuizKind) => {
      if (!moves.length || quizLoading) return
      const gen = genRef.current
      setQuizLoading(true)
      setQuizError(null)
      setQuizSaved(null)
      try {
        const resp = await fetchQuizApi({
          mode: 'quiz',
          kind,
          focus,
          game: toGameMoves(moves),
          targets: kind === 'bestmove' ? bestMoveTargets : undefined,
          apiKey: apiKey.trim() || undefined,
        })
        if (genRef.current !== gen) return
        // setting quizSaved persists it immediately via the save effect
        setQuizSaved({ kind, questions: resp.questions, answers: resp.questions.map(() => null), current: 0 })
      } catch (e) {
        if (genRef.current !== gen) return
        const msg = e instanceof Error ? e.message : 'Could not build the quiz.'
        setQuizError(msg)
        if (/api key|401|authentication/i.test(msg)) setShowSettings(true)
      } finally {
        if (genRef.current === gen) setQuizLoading(false)
      }
    },
    [moves, focus, apiKey, quizLoading, bestMoveTargets],
  )

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

  const handleAnalyzeAll = async (force = false) => {
    const plies = moves
      .filter((m) => isStudied(m.color, focus) && (force || !results[m.ply]))
      .map((m) => m.ply)
    if (!plies.length) return
    const gen = genRef.current
    const runKey = storeRef.current?.key
    const run: AnalysisRun = {
      gen,
      key: runKey ?? '',
      pgn: storeRef.current?.pgn ?? '',
      headers: headersRef.current,
    }
    const BATCH = 6
    const CONCURRENCY = 3
    const batches: number[][] = []
    for (let i = 0; i < plies.length; i += BATCH) batches.push(plies.slice(i, i + BATCH))
    setQueuedPlies(new Set(plies))
    setAllProgress({ done: 0, total: plies.length })
    if (runKey) setBgAnalysing((prev) => new Set(prev).add(runKey))
    let done = 0
    let next = 0
    // The run is NOT tied to the game staying on screen: leaving to the main
    // screen (or opening another game) lets the batches finish in the
    // background — analyzePlies writes them straight to this game's save.
    // Only the on-screen indicators are gen-guarded.
    const worker = async () => {
      while (next < batches.length) {
        const chunk = batches[next++]
        if (genRef.current === gen) {
          setQueuedPlies((prev) => {
            const c = new Set(prev)
            chunk.forEach((p) => c.delete(p)) // no longer queued — now in flight
            return c
          })
        }
        await analyzePlies(moves, focus, chunk, run)
        done += chunk.length
        if (genRef.current === gen) setAllProgress({ done: Math.min(plies.length, done), total: plies.length })
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker))
    if (runKey) {
      setBgAnalysing((prev) => {
        const c = new Set(prev)
        c.delete(runKey)
        return c
      })
    }
    setHistory(listGames())
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

  // Background Stockfish sweep: one eval per position so the eval bar covers
  // the whole game. Shares the engine's FEN cache with the per-move checks.
  const sweepRef = useRef<string | null>(null)
  useEffect(() => {
    if (phase !== 'game' || moves.length === 0) return
    const key = storeRef.current?.key ?? ''
    if (sweepRef.current === key) return
    sweepRef.current = key
    const gen = genRef.current
    const known = new Set(Object.keys(evals).map(Number))
    void (async () => {
      if (!(await engineAvailable())) return
      for (const m of moves) {
        if (genRef.current !== gen) return
        if (known.has(m.ply)) continue
        const cp = await evalAfterMoveWhite(m.fenAfter, m.color)
        if (cp === null || genRef.current !== gen) continue
        setEvals((prev) => (prev[m.ply] !== undefined ? prev : { ...prev, [m.ply]: cp }))
      }
    })()
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
    setQuizLoading(false)
    setQuizError(null)
    setGameOverview(null)
    setEvals({})
    setOverviewLoading(false)
    setOverviewError(null)
    setJumpBack(null)
    setGfx({ kind: 'auto' })
    setHistory(listGames())
  }

  // Cross-game meta-analysis: digest every locally analysed game into compact
  // summaries; the server merges the cloud archive on top and asks Claude for
  // the patterns. The report persists locally until regenerated.
  const generateMeta = async () => {
    if (metaLoading) return
    setMetaLoading(true)
    setMetaError(null)
    try {
      const summaries = listGames()
        .filter((g) => Object.keys(g.results).length > 0)
        .map(summarizeGame)
      const resp = await fetchMetaApi({ mode: 'meta', summaries, apiKey: apiKey.trim() || undefined })
      const rep: SavedMetaReport = { ...resp.report, generatedAt: Date.now(), gamesCount: resp.gamesUsed }
      try {
        localStorage.setItem(META_KEY, JSON.stringify(rep))
      } catch {
        /* best-effort */
      }
      setMetaReport(rep)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not build the meta-analysis.'
      setMetaError(msg)
      if (/api key|401|authentication/i.test(msg)) setShowSettings(true)
    } finally {
      setMetaLoading(false)
    }
  }

  // Opening a rule shows a popup (with an Ask thread) so the user never loses
  // their place; the full list stays reachable from inside the popup.
  const openRule = (id: number) => {
    setRuleModalId(id)
  }

  // The landing history merges this browser's saves with the cloud list:
  // local games as-is, cloud games from other devices marked ☁, and when both
  // exist the newer save wins the metadata.
  interface HistoryItem {
    key: string
    pgn: string
    focus: Focus
    headers: Record<string, string>
    savedAt: number
    /** when the game happened: the PGN's Date header, else when it was added
     * to the app — never when it was (re-)analysed */
    date: number
    analysed: number
    hasQuiz: boolean
    cloudOnly: boolean
  }
  const gameDate = (h: Record<string, string>, addedAt?: number, savedAt?: number): number => {
    const d = h?.Date
    if (d && /^\d{4}\.\d{2}\.\d{2}$/.test(d)) {
      const t = Date.parse(d.replace(/\./g, '-'))
      if (Number.isFinite(t)) return t
    }
    return addedAt ?? savedAt ?? 0
  }
  const historyItems = useMemo<HistoryItem[]>(() => {
    const byKey = new Map<string, HistoryItem>()
    for (const g of history) {
      byKey.set(g.key, {
        key: g.key,
        pgn: g.pgn,
        focus: g.focus,
        headers: g.headers,
        savedAt: g.savedAt,
        date: gameDate(g.headers, g.addedAt, g.savedAt),
        analysed: Object.keys(g.results).length,
        hasQuiz: !!g.quiz,
        cloudOnly: false,
      })
    }
    for (const c of cloudGames ?? []) {
      const local = byKey.get(c.key)
      if (!local) {
        byKey.set(c.key, { ...c, date: gameDate(c.headers, c.addedAt, c.savedAt), cloudOnly: true })
      } else if (c.savedAt > local.savedAt) {
        byKey.set(c.key, {
          ...local,
          savedAt: c.savedAt,
          analysed: Math.max(local.analysed, c.analysed),
          hasQuiz: local.hasQuiz || c.hasQuiz,
        })
      }
    }
    return [...byKey.values()].sort((a, b) => b.date - a.date)
  }, [history, cloudGames])

  // Open a saved game: when the cloud copy is the only one — or clearly newer
  // than this browser's — pull it down first so the analysis comes with it.
  const openSaved = async (item: HistoryItem) => {
    const local = loadGame(item.key)
    const cloud = (cloudGames ?? []).find((c) => c.key === item.key)
    if (!local || (cloud && cloud.savedAt > local.savedAt)) {
      const remote = await cloudGet(item.key)
      if (remote) saveGame(remote)
    }
    handleSubmit(item.pgn, item.focus)
  }

  const deleteSaved = (key: string) => {
    removeGame(key)
    cloudDelete(key)
    setCloudGames((prev) => (prev ? prev.filter((c) => c.key !== key) : prev))
    setHistory(listGames())
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

  // Saved analyses from before the board-graphics feature have no graphics on
  // any rule — that's the cue to offer a one-tap full re-analysis.
  const hasAnyGraphics = useMemo(
    () =>
      Object.values(results).some((r) =>
        r.rules.some(
          (h) => h.graphics && (h.graphics.squares?.length ?? 0) + (h.graphics.arrows?.length ?? 0) > 0,
        ),
      ),
    [results],
  )

  const move = moves[selectedPly]

  // Board graphics: reset the selection whenever the move changes.
  useEffect(() => {
    setGfx({ kind: 'auto' })
  }, [selectedPly])

  // The suggested cleaner move resolved to real squares on the position BEFORE
  // the move — a deterministic arrow, no AI geometry involved.
  const altArrow = useMemo(() => {
    const alt = results[selectedPly]?.alternative
    const m = moves[selectedPly]
    if (!alt || !m) return null
    try {
      const mv = new Chess(m.fenBefore).move(alt.move, { strict: false })
      return mv ? { from: mv.from, to: mv.to } : null
    } catch {
      return null
    }
  }, [results, selectedPly, moves])

  // The rule whose graphics show by default: the most relevant one that has any.
  const autoGfxRule = useMemo(() => {
    const r = results[selectedPly]
    if (!r) return undefined
    return [...r.rules]
      .sort((a, b) => (b.relevance ?? 3) - (a.relevance ?? 3))
      .find((h) => h.graphics && (h.graphics.squares?.length || h.graphics.arrows?.length))
  }, [results, selectedPly])

  const boardAnnotations = useMemo<BoardAnnotations | undefined>(() => {
    if (gfx.kind === 'off') return undefined
    if (gfx.kind === 'alt') {
      return altArrow ? { arrows: [{ from: altArrow.from, to: altArrow.to, color: 'green' }] } : undefined
    }
    const r = results[selectedPly]
    if (!r) return undefined
    if (gfx.kind === 'rule') return r.rules.find((h) => h.id === gfx.id)?.graphics
    return autoGfxRule?.graphics
  }, [gfx, altArrow, results, selectedPly, autoGfxRule])

  // Eval (White's perspective) after the current move: sweep result first,
  // falling back to the per-move engine check when the sweep hasn't reached it.
  const currentEvalCp = useMemo(() => {
    const m = moves[selectedPly]
    if (!m) return undefined
    if (evals[m.ply] !== undefined) return evals[m.ply]
    const e = results[m.ply]?.engine
    if (e) return m.color === 'w' ? e.evalPlayed : -e.evalPlayed
    return undefined
  }, [selectedPly, moves, evals, results])
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

  // Snap the analysis text back to its top when the move changes (only if the
  // user had scrolled down into it), and expose the same jump as a button.
  const scrollToAnalysisTop = useCallback((force = false) => {
    const panel = explainRef.current
    if (!panel) return
    const sticky = stickyRef.current
    const stickyH =
      sticky && getComputedStyle(sticky).position === 'sticky'
        ? sticky.getBoundingClientRect().height
        : 82 // desktop: just below the sticky topbar
    const top = panel.getBoundingClientRect().top
    if (force || top < stickyH - 4) {
      window.scrollTo({ top: Math.max(0, window.scrollY + top - stickyH - 8), behavior: 'smooth' })
    }
  }, [])

  useEffect(() => {
    if (phase !== 'game' || tab !== 'move') return
    scrollToAnalysisTop(false)
  }, [selectedPly, phase, tab, scrollToAnalysisTop])

  // Show the floating "back to top of the analysis" pill as soon as the text
  // starts scrolling under the sticky board (not only when scrolled deep).
  useEffect(() => {
    const onScroll = () => {
      if (tab === 'rules' || tab === 'map') {
        setShowToTop(window.scrollY > 220)
        return
      }
      const panel = explainRef.current
      if (!panel) {
        setShowToTop(false)
        return
      }
      const sticky = stickyRef.current
      const stickyH =
        sticky && getComputedStyle(sticky).position === 'sticky'
          ? sticky.getBoundingClientRect().height
          : 82
      setShowToTop(panel.getBoundingClientRect().top < stickyH - 32)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [tab])
  const atFirst = selectedPly <= 0
  const atLast = moves.length === 0 || selectedPly >= moves.length - 1
  const moveLabel = (m: ParsedMove) => `${m.moveNumber}${m.color === 'w' ? '.' : '…'} ${m.san}`

  return (
    <div className="app">
      <PieceSprite />
      <header className="topbar">
        <button
          className="brand"
          onClick={() => {
            if (phase === 'game') reset()
          }}
          title="Back to the start screen"
          aria-label="DecodePGN — back to the start screen"
        >
          <span className="logo">♟</span>
          <div>
            <h1>DecodePGN</h1>
            <span className="tagline">which rules of thumb apply, move by move</span>
          </div>
        </button>
        {phase === 'game' && (
          <div className="topbar-right">
            <div className="game-meta">
              <strong>
                {headers.White ?? 'White'}
                {mySide === 'w' ? ' (you)' : ''}
              </strong>{' '}
              vs{' '}
              <strong>
                {headers.Black ?? 'Black'}
                {mySide === 'b' ? ' (you)' : ''}
              </strong>
              <span className="studying"> · studying {colorName(focus)}</span>
              <button
                className="edit-names"
                onClick={() => setShowPlayers(true)}
                title="Edit player names / mark which one is you"
                aria-label="Edit player names"
              >
                ✎
              </button>
            </div>
            <button
              className="btn"
              onClick={() => void handleAnalyzeAll()}
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
          <PgnInput
            onSubmit={handleSubmit}
            onOpenSettings={() => setShowSettings(true)}
            error={parseError}
            hasServerKey={hasServerKey}
          />
          <IntroCard />
          <GameImport onPick={handleSubmit} />
          {historyItems.length > 0 ? (
            <div className="history card">
              <button
                className="collapse-head"
                onClick={() =>
                  setHistOpen((v) => {
                    localStorage.setItem('decodepgn.historyOpen', v ? '0' : '1')
                    return !v
                  })
                }
                aria-expanded={histOpen}
              >
                <h2>Your analysed games ({historyItems.length})</h2>
                <span className="collapse-chevron">{histOpen ? '▾' : '▸'}</span>
              </button>
              {histOpen ? (
              <ul className="history-list">
                {historyItems.map((g) => (
                  <li key={g.key}>
                    <button className="history-row" onClick={() => void openSaved(g)}>
                      <span className="history-title">
                        {g.headers.White ?? 'White'} vs {g.headers.Black ?? 'Black'}
                      </span>
                      <span className="history-meta">
                        as {colorName(g.focus)} · {g.analysed} analysed
                        {bgAnalysing.has(g.key) ? ' · analysing…' : ''}
                        {g.hasQuiz ? ' · quiz' : ''}
                        {g.cloudOnly ? ' · ☁' : ''} ·{' '}
                        {new Date(g.date).toLocaleDateString(undefined, {
                          day: 'numeric',
                          month: 'short',
                          ...(new Date(g.date).getFullYear() !== new Date().getFullYear()
                            ? { year: 'numeric' }
                            : {}),
                        })}
                      </span>
                    </button>
                    <button
                      className="history-del"
                      aria-label="Delete this saved analysis"
                      title="Delete this saved analysis (here and in the cloud)"
                      onClick={() => deleteSaved(g.key)}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
              ) : null}
            </div>
          ) : null}
          <MetaCard
            report={metaReport}
            loading={metaLoading}
            error={metaError}
            available={historyItems.filter((g) => g.analysed > 0).length}
            onGenerate={() => void generateMeta()}
            onOpenRule={openRule}
          />
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
                askKey={storeRef.current?.key ?? 'game'}
                askContext={{ focus, game: toGameMoves(moves) }}
                apiKey={apiKey}
                onNeedKey={() => setShowSettings(true)}
                onOpenRule={openRule}
              />
              {analyzedFocus > 0 && !hasAnyGraphics ? (
                <div className="regen-banner">
                  <span>
                    This analysis predates the <strong>board graphics</strong> — re-analyse to get
                    squares and arrows with each rule.
                  </span>
                  <button
                    className="btn"
                    onClick={() => void handleAnalyzeAll(true)}
                    disabled={!!allProgress}
                  >
                    {allProgress
                      ? `Re-analysing… ${allProgress.done}/${allProgress.total}`
                      : 'Re-analyse all moves'}
                  </button>
                </div>
              ) : null}
              <div className="study">
              <div className="board-panel">
                {/* Only this wrapper is sticky on mobile — the progress strip
                    below scrolls away so the analysis text keeps real estate. */}
                <div className={'board-sticky' + (boardMini ? ' mini' : '')} ref={stickyRef}>
                {/* The alternative-move arrow lives in the position BEFORE the
                    played move — show that position while it's toggled on. The
                    green arrow says it all; no caption (it only ate board space). */}
                {gfx.kind === 'alt' && altArrow ? (
                  <Board
                    fen={move.fenBefore}
                    orientation={focus === 'b' ? 'b' : 'w'}
                    annotations={boardAnnotations}
                  />
                ) : (
                  <Board
                    fen={move.fenAfter}
                    orientation={focus === 'b' ? 'b' : 'w'}
                    lastMove={{ from: move.from, to: move.to }}
                    annotations={boardAnnotations}
                  />
                )}
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
                  <button
                    className="navbtn minibtn"
                    onClick={() =>
                      setBoardMini((v) => {
                        localStorage.setItem('decodepgn.boardMini', v ? '0' : '1')
                        return !v
                      })
                    }
                    aria-label={boardMini ? 'Enlarge board' : 'Shrink board'}
                    title={boardMini ? 'Enlarge board' : 'Shrink board'}
                  >
                    {boardMini ? '⤢' : '⤡'}
                  </button>
                </div>
                {currentEvalCp !== undefined ? (
                  <div
                    className="eval-row"
                    title={`Stockfish evaluation after this move, from White's side: ${(currentEvalCp / 100).toFixed(2)}`}
                  >
                    <div className="evalbar">
                      <div
                        className="evalbar-fill"
                        style={{ width: `${50 + 50 * Math.tanh(currentEvalCp / 600)}%` }}
                      />
                    </div>
                    <span className="eval-num">
                      {Math.abs(currentEvalCp) >= 9000
                        ? currentEvalCp > 0
                          ? '+M'
                          : '−M'
                        : (currentEvalCp >= 0 ? '+' : '') + (currentEvalCp / 100).toFixed(1)}
                    </span>
                  </div>
                ) : null}
                {jumpBack !== null && jumpBack !== selectedPly && moves[jumpBack] ? (
                  <button className="jump-back" onClick={returnFromJump}>
                    ↩ Back to {moveLabel(moves[jumpBack])}
                  </button>
                ) : null}
                </div>
              </div>
              <div className="explain-panel" ref={explainRef}>
                {isStudied(move.color, focus) ? (
                  <MoveAnalysis
                    move={move}
                    focus={focus}
                    result={results[selectedPly]}
                    loading={loadingPlies.has(selectedPly)}
                    error={errorByPly[selectedPly]}
                    onReanalyze={() => analyzePlies(moves, focus, [selectedPly])}
                    onOpenRule={openRule}
                    gfx={gfx}
                    onGfx={setGfx}
                    autoGfxRuleId={autoGfxRule?.id}
                    altArrow={!!altArrow}
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
                  onOpenRule={openRule}
                />
              </div>
              </div>
            </>
          )}

          {tab === 'quiz' && (
            <Quiz
              moves={moves}
              focus={focus}
              saved={quizSaved}
              loading={quizLoading}
              error={quizError}
              onStart={(kind) => void startQuiz(kind)}
              onChange={setQuizSaved}
              onOpenRule={openRule}
              bestMoveReady={bestMoveTargets.length}
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
                onReanalyzeAll={() => void handleAnalyzeAll(true)}
                reanalyzing={!!allProgress}
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

      {phase === 'game' && showToTop && tab !== 'quiz' ? (
        <button
          className="to-top"
          onClick={() =>
            tab === 'move'
              ? scrollToAnalysisTop(true)
              : window.scrollTo({ top: 0, behavior: 'smooth' })
          }
          aria-label="Back to the top"
        >
          ↑ Top
        </button>
      ) : null}

      {ruleModalId !== null && (
        <RuleModal
          ruleId={ruleModalId}
          apiKey={apiKey}
          onNeedKey={() => setShowSettings(true)}
          onOpenList={(id) => {
            setHighlightRule(id)
            setRuleModalId(null)
            setTab('rules')
          }}
          onOpenRule={openRule}
          onClose={() => setRuleModalId(null)}
        />
      )}

      {showPlayers && phase === 'game' && (
        <PlayersModal
          white={headers.White ?? ''}
          black={headers.Black ?? ''}
          me={mySide ?? (focus !== 'both' ? focus : undefined)}
          onSave={(w, b, me) => {
            setHeaders((h) => ({ ...h, White: w, Black: b }))
            setMySide(me)
            setShowPlayers(false)
          }}
          onClose={() => setShowPlayers(false)}
        />
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
