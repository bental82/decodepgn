import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import { parsePgn, toGameMoves, toTargets } from '../game'
import { analyze, meta as fetchMetaApi, overview as fetchOverviewApi, quiz as fetchQuizApi } from '../lib/api'
import {
  clearEngineCache,
  engineAvailable,
  evalAfterMoveWhite,
  evalCandidateMove,
  evaluateMove,
} from '../lib/engine'
import {
  cloudDelete,
  cloudGet,
  cloudGetMeta,
  cloudList,
  cloudListSummaries,
  cloudSave,
  cloudSaveMeta,
  serverEnqueue,
  serverJobStatus,
  type CloudGameMeta,
  type ServerJob,
} from '../lib/cloud'
import {
  gameKey,
  listGames,
  loadGame,
  removeGame,
  sanitizeQuiz,
  saveGame,
  type QuizPosition,
  type SavedGame,
  type SavedQuiz,
} from '../lib/store'
import { RULE_COUNT } from '../shared/rules'
import { gameAccuracy } from '../shared/accuracy'
import { summarizeGame } from '../shared/meta'
import { isStudied } from '../shared/types'
import type {
  BoardAnnotations,
  Color,
  EngineEval,
  Focus,
  GameOverview,
  MetaGameSummary,
  MoveResult,
  ParsedMove,
  QuizExplanation,
} from '../shared/types'
import { colorName } from './contract'
import type { GfxSelection } from './contract'
import AskBox from './AskBox'
import Board from './Board'
import GameImport from './GameImport'
import GameOverviewCard from './GameOverviewCard'
import GameSummary from './GameSummary'
import Drill, { type DrillItem } from './Drill'
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

/** An empty placeholder recorded when a model skipped a ply — it renders as a
    blank card, so the repair paths treat it as "not analysed yet". */
const isEmptyResult = (r?: MoveResult) => !!r && r.rules.length === 0 && !r.lesson
type Tab = 'move' | 'quiz' | 'map' | 'rules'
type Phase = 'input' | 'game' | 'drill'

export default function App() {
  const [phase, setPhase] = useState<Phase>('input')
  const [headers, setHeaders] = useState<Record<string, string>>({})
  const [moves, setMoves] = useState<ParsedMove[]>([])
  const [focus, setFocus] = useState<Focus>('w')
  const [selectedPly, setSelectedPly] = useState(0)
  // Step only between flagged moves (soundness "dubious" or an engine loss
  // of 1.5+ pawns) — arrows, swipes and keyboard all honour it.
  const [dubiousOnly, setDubiousOnly] = useState(false)
  // Set when a game was opened via a "Your play" summary link, so the game
  // view can offer the way back to the report.
  const [fromMeta, setFromMeta] = useState(false)
  // Drill session: bumping the run remounts a fresh round; the session stays
  // mounted (hidden) while peeking at a game so "back" resumes mid-round.
  const [drillRun, setDrillRun] = useState(0)
  const [fromDrill, setFromDrill] = useState(false)
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
  // Game keys whose analyse-all run FINISHED this session. The overview
  // auto-generates the moment a game's run completes — keyed on the run, not
  // per-ply results, so a ply that errored can't hold the overview hostage.
  const [analysisRunDone, setAnalysisRunDone] = useState<Set<string>>(new Set())
  // While set, we're checking the cloud for this game's saved analysis —
  // auto-analysis waits so a stored game is never re-analysed from scratch.
  const [restoringKey, setRestoringKey] = useState<string | null>(null)
  // Keys with a CONFIRMED cloud upload this session (drives the ☁ marker).
  const [syncedKeys, setSyncedKeys] = useState<Set<string>>(new Set())
  const markSynced = useCallback((key: string) => {
    setSyncedKeys((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
  }, [])
  const [hasServerKey, setHasServerKey] = useState(false)
  const [serverBuild, setServerBuild] = useState<string | undefined>(undefined)
  // Server has an OpenRouter key -> the NON-studied side's moves get analysed
  // too, on the bargain lite model. Kept in a ref for the analysis callbacks.
  const [hasLiteKey, setHasLiteKey] = useState(false)
  const [liteModel, setLiteModel] = useState<string | undefined>(undefined)
  // Whether the server capabilities have been LEARNED (either way). The auto
  // run waits for this: starting before the lite flag lands would cover only
  // the studied side, and leaving the game then strands the opponent moves.
  const [liteKnown, setLiteKnown] = useState(false)
  const liteKeyRef = useRef(false)
  liteKeyRef.current = hasLiteKey
  // Server-side analysis: when the deployment has the games database, analyse
  // runs happen in the cloud (they survive the phone locking / tab closing)
  // and this client is just a viewer that polls. Without it, the local
  // machinery below does everything, exactly as before.
  const [serverRuns, setServerRuns] = useState(false)
  const serverRunsRef = useRef(false)
  serverRunsRef.current = serverRuns
  // The current game's server job, kept fresh by the poll effect.
  const [serverJob, setServerJob] = useState<{ key: string; job: ServerJob } | null>(null)
  const serverJobRef = useRef<typeof serverJob>(null)
  serverJobRef.current = serverJob
  // Light/dark theme — applied to <html data-theme> (index.html sets it before
  // first paint) and remembered across sessions.
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    localStorage.getItem('decodepgn.theme') === 'light' ? 'light' : 'dark',
  )
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('decodepgn.theme', theme)
  }, [theme])
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
  // Digests of the cloud archive (server-computed) so cross-game stats and
  // history rows cover games this browser doesn't hold locally.
  const [cloudSummaries, setCloudSummaries] = useState<MetaGameSummary[] | null>(null)
  // The current game's guess-the-move quiz (persisted alongside the analysis).
  // Owned here — NOT in the Quiz tab — so progress and in-flight explanations
  // survive tab switches.
  const [quizSaved, setQuizSaved] = useState<SavedQuiz | null>(null)
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
  // Share of moves whose eval shipped INSIDE the PGN ([%eval] comments, as in
  // lichess exports) — near-full coverage lets the overview fire immediately
  // instead of waiting for our own move-by-move analysis.
  const [pgnEvalCoverage, setPgnEvalCoverage] = useState(0)
  const explainRef = useRef<HTMLDivElement | null>(null)
  const stickyRef = useRef<HTMLDivElement | null>(null)
  const [showToTop, setShowToTop] = useState(false)
  const [overviewLoading, setOverviewLoading] = useState(false)
  const [overviewError, setOverviewError] = useState<string | null>(null)

  // Learn whether the deployment has its own key, so we can be honest about
  // whether the user needs to bring one. Also remember the API's build marker
  // (shown in Settings) so "what's actually live?" is answerable at a glance.
  useEffect(() => {
    let cancelled = false
    fetch('/api/analyze', { method: 'GET' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return
        if (typeof d.hasServerKey === 'boolean') setHasServerKey(d.hasServerKey)
        if (typeof d.serverRuns === 'boolean') setServerRuns(d.serverRuns)
        if (typeof d.hasLiteKey === 'boolean') setHasLiteKey(d.hasLiteKey)
        if (d.hasLiteKey === true && typeof d.modelLite === 'string') setLiteModel(d.modelLite)
        if (typeof d.build === 'string') setServerBuild(d.build)
      })
      .catch(() => {})
      // known (or unknowable) either way — analysis must not wait forever
      .finally(() => {
        if (!cancelled) setLiteKnown(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Pull the cloud game list once — games analysed on other devices (or before
  // this browser's storage was cleared) show up in the history. Then BACKFILL:
  // any game this device has locally that the cloud is missing (analysed
  // before the database existed, or on a device that was offline) is uploaded,
  // lightly staggered so a big history doesn't burst the connection.
  useEffect(() => {
    let cancelled = false
    void cloudListSummaries().then((sums) => {
      if (!cancelled && sums) setCloudSummaries(sums)
    })
    void cloudList().then((games) => {
      if (cancelled || !games) return
      setCloudGames(games)
      const cloudSavedAt = new Map(games.map((c) => [c.key, c.savedAt]))
      let wave = 0
      for (const g of listGames()) {
        const remote = cloudSavedAt.get(g.key)
        if (remote !== undefined && remote >= g.savedAt) continue // already up to date
        setTimeout(() => {
          if (!cancelled) cloudSave(g, markSynced)
        }, wave++ * 1000)
      }
      // The meta report syncs the same way (a non-null list means the cloud is
      // on): adopt the cloud copy when it's newer than this browser's, and
      // backfill a local report generated before cloud sync existed.
      void cloudGetMeta().then((remoteMeta) => {
        if (cancelled) return
        let localMeta: SavedMetaReport | null = null
        try {
          localMeta = JSON.parse(localStorage.getItem(META_KEY) || 'null')
        } catch {
          /* unreadable — treat as absent */
        }
        if (remoteMeta && (!localMeta || remoteMeta.generatedAt > localMeta.generatedAt)) {
          try {
            localStorage.setItem(META_KEY, JSON.stringify(remoteMeta))
          } catch {
            /* best-effort */
          }
          setMetaReport(remoteMeta)
        } else if (localMeta && (!remoteMeta || localMeta.generatedAt > remoteMeta.generatedAt)) {
          cloudSaveMeta(localMeta)
        }
      })
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
  // Latest phase, so a background batch can tell whether its game is the one
  // currently on screen (re-entering a game mid-run must go live again).
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  interface AnalysisRun {
    gen: number
    key: string
    pgn: string
    headers: Record<string, string>
    /** no save existed when the run started — background batches may CREATE
        one (there is nothing anywhere to clobber). When a save DID exist and
        is gone mid-run (deleted / quota-evicted), batches are dropped instead:
        recreating a shell would overwrite the full cloud copy. */
    freshGame?: boolean
    /** an explicit user click took the engine over — this run stops at the
        next batch boundary and skips its end-of-run bookkeeping (the takeover
        already released the lock and stamped pendingRun for the resume). */
    cancelled?: boolean
  }

  // The run currently holding the one-at-a-time lock, so an explicit click
  // can cancel it instead of being silently ignored.
  const activeRunRef = useRef<AnalysisRun | null>(null)

  // Manual analyse taps made while another game's run holds the lock: games
  // still run ONE at a time, but in tap order, chaining automatically — tap
  // "analyse" on a few games and walk away. A snapshot of everything the run
  // needs travels with the entry, because by the time it starts the user may
  // be reading a different game (or the landing page).
  interface QueuedAnalysis {
    key: string
    pgn: string
    headers: Record<string, string>
    moves: ParsedMove[]
    focus: Focus
    force: boolean
    repairEmpty: boolean
    includeLite: boolean
  }
  const queueRef = useRef<QueuedAnalysis[]>([])
  // mirror of the queued KEYS, for rendering (the button's queued state)
  const [analysisQueue, setAnalysisQueue] = useState<string[]>([])

  const analyzePlies = useCallback(
    async (
      mvs: ParsedMove[],
      f: Focus,
      plies: number[],
      run?: AnalysisRun,
      opts?: { freshEngine?: boolean },
    ) => {
      const targets = plies.filter(
        (ply) => mvs[ply] && (isStudied(mvs[ply].color, f) || liteKeyRef.current),
      )
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
      // Whether the run's game is on screen RIGHT NOW. Covers re-entry too:
      // leaving a game and reopening it bumps the gen, but the run's writes
      // still belong on the live view — the key match says so. A batch whose
      // game is NOT on screen (queued run, or the user moved on) must keep
      // its spinners, errors and results out of the visible game's view.
      const onScreenNow = () =>
        genRef.current === gen ||
        (phaseRef.current === 'game' && !!origin.key && storeRef.current?.key === origin.key)
      if (onScreenNow()) {
        setLoadingPlies((prev) => new Set([...prev, ...targets]))
        setErrorByPly((prev) => {
          const c = { ...prev }
          targets.forEach((p) => delete c[p])
          return c
        })
      }
      try {
        // Best-effort engine check per target (Stockfish in a worker); the AI
        // weighs it so objectively strong moves don't get scolded.
        const targetObjs = toTargets(mvs, targets)
        const engineByPly = new Map<number, EngineEval>()
        // Auto-analysis reuses a previously computed engine check (the
        // position hasn't changed, and re-running Stockfish made "Re-analyse"
        // feel unresponsive). EXPLICIT re-analysis recomputes it instead —
        // it's the repair path when a saved check looks wrong.
        // Saved engine checks must come from THIS run's game: the on-screen
        // results belong to whatever the user is looking at, which for a
        // background batch can be a different game entirely.
        const knownResults = onScreenNow()
          ? resultsRef.current
          : ((origin.key ? loadGame(origin.key)?.results : undefined) ?? {})
        const pending: typeof targetObjs = []
        for (const t of targetObjs) {
          const prior = opts?.freshEngine ? undefined : knownResults[t.ply]?.engine
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
            // fresh recompute failed → keep the saved check over losing it.
            // Opponent moves take the quick budget: their check is context,
            // and the sweep has usually cached both positions already.
            const ev =
              (await evaluateMove(pm, {
                fresh: opts?.freshEngine,
                quick: !isStudied(pm.color, f),
              })) ?? knownResults[t.ply]?.engine
            if (ev) {
              t.engine = ev
              engineByPly.set(t.ply, ev)
            }
          }
        } else if (opts?.freshEngine) {
          // engine unavailable on this device: keep the saved checks
          for (const t of pending) {
            const prior = knownResults[t.ply]?.engine
            if (prior) {
              t.engine = prior
              engineByPly.set(t.ply, prior)
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
        let resp = await analyze(req).catch(async () => {
          await new Promise((r) => setTimeout(r, 2000))
          return analyze(req)
        })
        let returned = new Set(resp.results.map((r) => r.ply))
        // Models sometimes SKIP plies inside a batch, which used to surface as
        // blank "no rule stood out" cards. One targeted follow-up for just the
        // missing plies recovers them before any placeholder is recorded.
        const missing = targetObjs.filter((t) => !returned.has(t.ply))
        if (missing.length > 0) {
          const extra = await analyze({ ...req, targets: missing }).catch(() => null)
          if (extra?.results?.length) {
            resp = { results: [...resp.results, ...extra.results] }
            returned = new Set(resp.results.map((r) => r.ply))
          }
        }
        const onScreen = onScreenNow()
        if (onScreen) {
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
          // The user moved on — merge the batch straight into the game's save
          // and refresh the landing list. If the local save is GONE (deleted,
          // or quota-evicted mid-run), DROP the batch: fabricating a shell
          // save here and cloud-saving it would overwrite the game's full
          // cloud copy with a nearly-empty one — analysis loss, not repair.
          // Exception: a FRESH game left before its first save existed gets
          // its save created here — there is nothing to clobber.
          const saved =
            loadGame(origin.key) ??
            (origin.freshGame
              ? ({
                  key: origin.key,
                  pgn: origin.pgn,
                  focus: f,
                  headers: origin.headers,
                  savedAt: Date.now(),
                  results: {},
                  pendingRun: true, // created mid-run by definition
                } as SavedGame)
              : null)
          if (saved) {
            const merged: SavedGame = { ...saved, savedAt: Date.now(), results: { ...saved.results } }
            for (const r of resp.results) merged.results[r.ply] = { ...r, engine: engineByPly.get(r.ply) }
            cloudSave(saveGame(merged), markSynced)
            setHistory(listGames())
          }
        }
      } catch (e) {
        if (!onScreenNow()) return // background batch failed — retry next open
        const msg = e instanceof Error ? e.message : 'Analysis failed.'
        setErrorByPly((prev) => {
          const c = { ...prev }
          targets.forEach((p) => (c[p] = msg))
          return c
        })
        if (/api key|401|authentication/i.test(msg)) setShowSettings(true)
      } finally {
        if (onScreenNow()) {
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

  const handleSubmit = (pgn: string, f: Focus, atPly?: number): boolean => {
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
      setQuizSaved(sanitizeQuiz(saved?.quiz))
      setQuizEngineBusy(null)
      autoRanRef.current = null // each open re-evaluates what's missing
      setServerJob(null) // the poll effect re-discovers this game's job
      setGameOverview(saved?.overview ?? null)
      // PGN-shipped evals (lichess analysis) give instant full coverage; our
      // own engine's numbers (saved sweep) win where both exist.
      setEvals({ ...(g.evals ?? {}), ...(saved?.evals ?? {}) })
      setPgnEvalCoverage(Object.keys(g.evals ?? {}).length / g.moves.length)
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
      // a counter from a previous view's run would freeze here (its updates
      // are gen-guarded) — never show a stale one on a fresh view
      setAllProgress(null)
      setParseError(null)
      setHighlightRule(undefined)
      const first = g.moves.find((m) => isStudied(m.color, f))?.ply ?? 0
      const startPly = atPly !== undefined ? Math.min(Math.max(0, atPly), g.moves.length - 1) : first
      setSelectedPly(startPly)
      // the new game's first paint must not glide — but its first STEP must
      prevPlyRef.current = startPly
      setDubiousOnly(false)
      setFromMeta(false)
      setFromDrill(false)
      setTab('move')
      setPhase('game')
      if (f === 'both' && !saved?.me) setShowPlayers(true)
      const cloudRow = cloudGames?.find((c) => c.key === key)
      // The cloud copy is AHEAD of this device's save when a server-side run
      // (or another device) analysed more, or wrote more recently — without
      // this, server results never reach a device that has an older local
      // save, and its repaired blanks stay blank forever.
      const cloudAhead =
        !!saved &&
        !!cloudRow &&
        (cloudRow.analysed > Object.keys(saved.results).length ||
          cloudRow.savedAt > saved.savedAt)
      if (!saved && (cloudGames === null || cloudRow)) {
        setRestoringKey(key)
        const gen = genRef.current
        void cloudGet(key)
          .then((remote) => {
            if (genRef.current !== gen) return
            if (remote && remote.key === key) {
              const rj = (remote as { job?: ServerJob }).job
              if (rj && typeof rj.status === 'string') setServerJob({ key, job: rj })
              saveGame(remote)
              setResults(remote.results ?? {})
              setQuizSaved(sanitizeQuiz(remote.quiz))
              setGameOverview(remote.overview ?? null)
              setEvals(remote.evals ?? {})
              setMySide(remote.me ?? (f !== 'both' ? f : undefined))
              setHeaders(remote.headers ?? g.headers)
              setHistory(listGames())
            }
          })
          .finally(() => setRestoringKey((k) => (k === key ? null : k)))
      } else if (saved && cloudAhead) {
        setRestoringKey(key)
        const gen = genRef.current
        void cloudGet(key)
          .then((remote) => {
            if (genRef.current !== gen) return
            if (!remote || remote.key !== key) return
            const rj = (remote as { job?: ServerJob }).job
            if (rj && typeof rj.status === 'string') setServerJob({ key, job: rj })
            // Per-ply merge: the cloud wins wherever this device has nothing
            // or a BLANK card (repairs must land); a real local result wins
            // (it may be a fresh re-analysis that hasn't synced yet).
            const merged: SavedGame['results'] = { ...(remote.results ?? {}) }
            for (const [pk, r] of Object.entries(saved.results ?? {})) {
              if (r && !isEmptyResult(r)) merged[Number(pk)] = r
            }
            const quiz = sanitizeQuiz(saved.quiz) ?? sanitizeQuiz(remote.quiz)
            const overview = saved.overview ?? remote.overview
            const mEvals = { ...(remote.evals ?? {}), ...(saved.evals ?? {}) }
            const mergedSave: SavedGame = {
              ...saved,
              results: merged,
              quiz: quiz ?? undefined,
              overview,
              evals: Object.keys(mEvals).length ? mEvals : undefined,
              savedAt: Date.now(),
            }
            saveGame(mergedSave)
            setResults(merged)
            setQuizSaved(quiz)
            setGameOverview(overview ?? null)
            setEvals((prev) => ({ ...mEvals, ...prev }))
            setHistory(listGames())
          })
          .finally(() => setRestoringKey((k) => (k === key ? null : k)))
      }
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
      // a run for THIS game is going: stamp it, so a killed tab resumes on
      // reopen (undefined inherits the stored flag — see saveGame)
      pendingRun: bgAnalysing.has(storeRef.current.key) ? true : undefined,
    }
    // mirror the STAMPED save (stable addedAt) — uploading the bare object
    // would wipe the cloud row's anchor and let list positions drift
    cloudSave(saveGame(game), markSynced)
  }, [phase, results, focus, headers, quizSaved, gameOverview, evals, mySide, bgAnalysing])

  // Chess.com-style per-side accuracy from the engine-checked moves — shown
  // in the Game overview header and fed to the overview generation. Only
  // studied sides carry engine data.
  const overviewAccuracy = useMemo(() => {
    const forSide = (c: Color) => {
      const evs: EngineEval[] = []
      for (const r of Object.values(results)) {
        if (r.engine && moves[r.ply]?.color === c) evs.push(r.engine)
      }
      return gameAccuracy(evs)
    }
    const out: Array<{ key: string; label: string; value: number }> = []
    for (const c of ['w', 'b'] as const) {
      const v = forSide(c)
      if (v == null) continue
      out.push({ key: c, label: mySide === c ? 'You' : colorName(c), value: v })
    }
    return out
  }, [results, moves, mySide])

  const fetchOverview = useCallback(async () => {
    if (!moves.length) return
    const gen = genRef.current
    setOverviewLoading(true)
    setOverviewError(null)
    try {
      // Ground the overview in the engine's story: the sweep's evals, with
      // per-move engine checks filling any gaps the sweep hasn't reached.
      const evs: Record<number, number> = {}
      for (const m of moves) {
        if (evals[m.ply] !== undefined) {
          evs[m.ply] = evals[m.ply]
        } else {
          const e = results[m.ply]?.engine
          if (e) evs[m.ply] = m.color === 'w' ? e.evalPlayed : -e.evalPlayed
        }
      }
      const accOf = (c: Color) => overviewAccuracy.find((a) => a.key === c)?.value
      const resp = await fetchOverviewApi({
        mode: 'overview',
        focus,
        game: toGameMoves(moves),
        headers,
        evals: Object.keys(evs).length ? evs : undefined,
        accuracy: accOf('w') != null || accOf('b') != null ? { w: accOf('w'), b: accOf('b') } : undefined,
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
  }, [moves, focus, headers, apiKey, evals, results, overviewAccuracy])

  // Guess-the-move candidates: the studied side's engine-flagged moves that
  // cost the most, capped at 5 and presented in game order. A position only
  // quizzes something if there was a real choice — automatic recaptures and
  // (near-)forced positions teach nothing. Underpromotion answers are also
  // skipped: board input always promotes to a queen, so they'd be unsolvable.
  const quizCandidates = useMemo<number[]>(() => {
    const isObvious = (m: ParsedMove) => {
      const prev = moves[m.ply - 1]
      if (prev && prev.san.includes('x') && m.san.includes('x') && m.to === prev.to) return true
      try {
        return new Chess(m.fenBefore).moves().length <= 2
      } catch {
        return true
      }
    }
    return moves
      .filter((m) => isStudied(m.color, focus))
      .map((m) => ({ m, e: results[m.ply]?.engine }))
      .filter(
        (x): x is { m: ParsedMove; e: EngineEval } =>
          !!x.e && !x.e.isBest && x.e.cpLoss >= 30 && !/=[RNB]/.test(x.e.bestSan) && !isObvious(x.m),
      )
      .sort((a, b) => b.e.cpLoss - a.e.cpLoss)
      .slice(0, 5)
      .map((x) => x.m.ply)
      .sort((a, b) => a - b)
  }, [moves, focus, results])

  // Analysed moves with no Stockfish check (saves that predate the engine
  // integration). The quiz can mint just these locally — no re-analysis.
  const quizEngineMissing = useMemo(
    () =>
      moves.filter((m) => isStudied(m.color, focus) && results[m.ply] && !results[m.ply].engine)
        .length,
    [moves, focus, results],
  )
  const [quizEngineBusy, setQuizEngineBusy] = useState<{ done: number; total: number } | null>(null)
  const addQuizEngine = useCallback(async () => {
    if (quizEngineBusy) return
    const gen = genRef.current
    const targets = moves.filter(
      (m) => isStudied(m.color, focus) && resultsRef.current[m.ply] && !resultsRef.current[m.ply].engine,
    )
    if (!targets.length || !(await engineAvailable())) return
    setQuizEngineBusy({ done: 0, total: targets.length })
    let done = 0
    for (const m of targets) {
      if (genRef.current !== gen) return // a different game took over — stop quietly
      const ev = await evaluateMove(m)
      done++
      if (genRef.current !== gen) return
      if (ev) {
        // merge into the EXISTING result only: minting a result for an
        // unanalysed ply would wrongly mark the move as analysed everywhere
        setResults((prev) =>
          prev[m.ply] ? { ...prev, [m.ply]: { ...prev[m.ply], engine: ev } } : prev,
        )
      }
      setQuizEngineBusy({ done, total: targets.length })
    }
    setQuizEngineBusy(null)
  }, [moves, focus, quizEngineBusy])

  // Starting (or restarting) freezes the current picks into the save, so a
  // later re-analysis can't silently swap positions mid-round. The round
  // counter gives each start a fresh identity: async patches from an older
  // round (a slow grade or explanation) bounce off instead of corrupting it.
  const startQuiz = useCallback(() => {
    if (!quizCandidates.length) return
    setQuizSaved((prev) => ({
      v: 2,
      positions: quizCandidates.map((ply) => ({
        ply,
        attempts: [],
        solved: false,
        revealed: false,
        hintUsed: false,
      })),
      current: 0,
      round: (prev?.round ?? 0) + 1,
    }))
  }, [quizCandidates])

  // The coaching for one finished quiz position, grounded in the stored
  // engine numbers (the server never re-derives them). In-flight calls are
  // shared per game+ply: the Quiz component unmounts on tab switches, and a
  // remount must adopt the pending fetch, not start a duplicate one.
  const explainInFlight = useRef(new Map<string, Promise<QuizExplanation>>())
  const explainQuiz = useCallback(
    (pos: QuizPosition): Promise<QuizExplanation> => {
      const m = moves[pos.ply]
      const e = results[pos.ply]?.engine
      if (!m || !e) {
        return Promise.reject(new Error("This position's analysis is missing — re-analyse the game."))
      }
      const flightKey = `${storeRef.current?.key ?? ''}:${pos.ply}`
      const pending = explainInFlight.current.get(flightKey)
      if (pending) return pending
      // the game move is covered by whyPlayed — no attempt note for it
      const attempts = pos.attempts
        .filter((a) => !a.isGameMove)
        .map((a) => ({ san: a.san, cpLoss: a.cpLoss }))
      const p = fetchQuizApi({
        mode: 'quiz',
        focus,
        me: mySide,
        game: toGameMoves(moves),
        ply: pos.ply,
        fenBefore: m.fenBefore,
        played: { san: m.san, cpLoss: e.cpLoss },
        best: { san: e.bestSan, evalBest: e.evalBest, pv: e.pv },
        ...(attempts.length ? { attempts } : {}),
        ...(pos.solution ? { solvedWith: { san: pos.solution.san, cpLoss: pos.solution.cpLoss } } : {}),
        apiKey: apiKey.trim() || undefined,
      }).then((resp) => resp.explanation)
      explainInFlight.current.set(flightKey, p)
      p.finally(() => explainInFlight.current.delete(flightKey)).catch(() => {})
      return p
    },
    [moves, results, focus, mySide, apiKey],
  )

  // Sweep bookkeeping: "Re-analyse all" forces a full sweep redo via these.
  const forceSweepRef = useRef(false)
  const [sweepGen, setSweepGen] = useState(0)

  // The whole-game overview fires the moment the move-by-move analysis run
  // completes — or immediately when the PGN itself shipped near-full [%eval]
  // coverage (lichess exports), since the eval story is already on hand. The
  // Stockfish eval-bar sweep never gates it: the overview just rides on
  // whatever evals exist when it fires.
  const overviewGameKey = storeRef.current?.key ?? ''
  // This game's server-side job is queued or running (cloud analysis mode).
  const serverActive =
    serverJob?.key === overviewGameKey &&
    (serverJob.job.status === 'queued' || serverJob.job.status === 'running')
  const focusDone =
    moves.length > 0 && moves.every((m) => !isStudied(m.color, focus) || !!results[m.ply])
  const analysisSettled =
    // an in-flight run vetoes: a forced re-analysis keeps old results on
    // screen until each is replaced, so "every ply has a result" alone would
    // fire the overview off stale data
    !bgAnalysing.has(overviewGameKey) &&
    !serverActive &&
    (focusDone || analysisRunDone.has(overviewGameKey))
  const overviewWaiting =
    phase === 'game' &&
    !gameOverview &&
    !overviewLoading &&
    !overviewError &&
    !restoringKey &&
    moves.length > 0 &&
    pgnEvalCoverage < 0.9 &&
    !analysisSettled
  useEffect(() => {
    if (phase !== 'game' || gameOverview || overviewLoading || overviewError) return
    if (restoringKey) return // the restored save carries its overview
    if (overviewWaiting) return // the move-by-move run is still going
    void fetchOverview()
  }, [phase, gameOverview, overviewLoading, overviewError, fetchOverview, restoringKey, overviewWaiting])

  // Auto-analyse the selected move when it belongs to the studied colour and
  // hasn't been analysed (or errored) yet.
  useEffect(() => {
    if (phase !== 'game' || restoringKey) return
    // a batch run is (or may be) covering this ply — a single-move request
    // now would just duplicate its work and its tokens
    if (bgAnalysing.size > 0) return
    const sj = serverJobRef.current
    if (
      sj &&
      sj.key === (storeRef.current?.key ?? '') &&
      (sj.job.status === 'queued' || sj.job.status === 'running')
    )
      return // the server run is covering this game
    const m = moves[selectedPly]
    if (!m || !(isStudied(m.color, focus) || hasLiteKey)) return
    if (
      results[selectedPly] ||
      loadingPlies.has(selectedPly) ||
      queuedPlies.has(selectedPly) ||
      errorByPly[selectedPly]
    )
      return
    void analyzePlies(moves, focus, [selectedPly])
  }, [phase, selectedPly, focus, moves, results, loadingPlies, errorByPly, analyzePlies, restoringKey, hasLiteKey, bgAnalysing])

  // Server-run viewer: one status check when a game opens (discovers a run
  // started elsewhere — another device, or before the app was closed), then a
  // steady poll while its job is active. Results stream into the view as the
  // server's batches land; completion unlocks the overview exactly like a
  // local run finishing.
  const serverPulledRef = useRef(-1)
  useEffect(() => {
    if (phase !== 'game' || !serverRuns) return
    const key = storeRef.current?.key
    if (!key) return
    let stop = false
    const tick = async () => {
      const st = await serverJobStatus(key)
      if (stop || storeRef.current?.key !== key) return
      const j = st?.job ?? null
      setServerJob(j ? { key, job: j } : null)
      if (!st || !j) return
      // pull the grown results whenever the cloud copy is ahead of what we
      // last pulled (batches land server-side between polls)
      if (st.analysed !== serverPulledRef.current) {
        serverPulledRef.current = st.analysed
        const remote = await cloudGet(key)
        if (stop || storeRef.current?.key !== key || !remote || remote.key !== key) return
        setResults((prev) => {
          const c = { ...prev }
          for (const [pk, r] of Object.entries(remote.results ?? {})) {
            const p = Number(pk)
            // never replace a real local card with a blank remote one
            if (!c[p] || isEmptyResult(c[p]) || !isEmptyResult(r)) c[p] = r
          }
          return c
        })
        setEvals((prev) => ({ ...(remote.evals ?? {}), ...prev }))
        setHistory(listGames())
      }
      if (j.status === 'done') {
        // unblocks the overview — every move's analysis is in
        setAnalysisRunDone((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
      }
    }
    serverPulledRef.current = -1
    void tick()
    if (!serverActive) {
      return () => {
        stop = true
      }
    }
    const iv = setInterval(tick, 4000)
    return () => {
      stop = true
      clearInterval(iv)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, serverRuns, serverActive, moves])

  // Cancel the run holding the engine: its workers stop at the next batch
  // boundary, and its game is stamped pendingRun so the work resumes on that
  // game's next open. The lock (activeRunRef) is released synchronously.
  const cancelActiveRun = () => {
    const prior = activeRunRef.current
    if (!prior) return
    prior.cancelled = true
    if (prior.key) {
      const s = loadGame(prior.key)
      if (s && s.pendingRun !== true) saveGame({ ...s, pendingRun: true })
    }
    setBgAnalysing((prev) => {
      const c = new Set(prev)
      if (prior.key) c.delete(prior.key)
      return c
    })
    activeRunRef.current = null
  }

  // The analyse-all core, decoupled from the on-screen state: everything a
  // run needs travels in `q`, so a QUEUED game can start after the user has
  // moved to another game (or the landing page). What is already analysed is
  // re-read at start time — results may have grown since the tap.
  const startAnalysisRun = async (q: QueuedAnalysis) => {
    const runKey = q.key || undefined
    const live = phaseRef.current === 'game' && !!q.key && storeRef.current?.key === q.key
    const known = live ? resultsRef.current : ((runKey ? loadGame(runKey)?.results : undefined) ?? {})
    // With the lite tier available a run can cover EVERY move — the studied
    // side on the Claude tiers, the opponent on the bargain model. Studied
    // moves go first: the coaching the user came for lands before the context.
    // Both extras are opt-in per call: empty-shell repairs and the opponent
    // tier only run when EXPLICITLY requested (or, for the lite tier, on a
    // brand-new analysis) — reopening an old game must never start work the
    // user didn't ask for.
    const withLite = liteKeyRef.current && q.includeLite
    const plies = q.moves
      .filter(
        (m) =>
          (isStudied(m.color, q.focus) || withLite) &&
          (q.force || !known[m.ply] || (q.repairEmpty && isEmptyResult(known[m.ply]))),
      )
      .map((m) => m.ply)
      .sort(
        (a, b) =>
          (isStudied(q.moves[a].color, q.focus) ? 0 : 1) -
            (isStudied(q.moves[b].color, q.focus) ? 0 : 1) || a - b,
      )
    if (!plies.length) {
      startNextQueued() // nothing to do — keep the chain moving
      return
    }
    // An off-screen start takes a gen no view ever had: every on-screen
    // indicator (progress bar, per-ply spinners) stays keyed to the game the
    // user is actually looking at, not to this background run.
    const gen = live ? genRef.current : -1
    // Persist the run's EXISTENCE: if the tab closes mid-run the flag stays
    // set, and reopening the game resumes the work automatically. Cleared on
    // completion below — a run the user watched to the end never resumes.
    if (runKey) {
      const s = loadGame(runKey)
      if (s && s.pendingRun !== true) saveGame({ ...s, pendingRun: true })
    }
    if (q.force) {
      // Explicit repair: recompute every engine check and the eval bar from a
      // clean cache, so a bad saved evaluation cannot survive re-analysis.
      clearEngineCache()
      if (live) {
        setEvals({})
        setPgnEvalCoverage(0) // the PGN's own evals were just wiped with the rest
        forceSweepRef.current = true
        setSweepGen((g) => g + 1)
        // the overview is part of the analysis — rebuild it too, once this
        // fresh run completes (the auto-generate effect waits for it)
        setGameOverview(null)
        setOverviewError(null)
      }
      if (runKey) {
        setAnalysisRunDone((prev) => {
          const c = new Set(prev)
          c.delete(runKey)
          return c
        })
      }
    }
    const run: AnalysisRun = {
      gen,
      key: q.key,
      pgn: q.pgn,
      headers: q.headers,
      freshGame: !!runKey && !loadGame(runKey),
    }
    activeRunRef.current = run
    const BATCH = 6
    const CONCURRENCY = 3
    const batches: number[][] = []
    for (let i = 0; i < plies.length; i += BATCH) batches.push(plies.slice(i, i + BATCH))
    if (live) {
      setQueuedPlies(new Set(plies))
      setAllProgress({ done: 0, total: plies.length })
    }
    if (runKey) setBgAnalysing((prev) => new Set(prev).add(runKey))
    let done = 0
    let next = 0
    // The run is NOT tied to the game staying on screen: leaving to the main
    // screen (or opening another game) lets the batches finish in the
    // background — analyzePlies writes them straight to this game's save.
    // Only the on-screen indicators are gen-guarded.
    const worker = async () => {
      while (next < batches.length) {
        if (run.cancelled) return
        const chunk = batches[next++]
        if (genRef.current === gen) {
          setQueuedPlies((prev) => {
            const c = new Set(prev)
            chunk.forEach((p) => c.delete(p)) // no longer queued — now in flight
            return c
          })
        }
        await analyzePlies(q.moves, q.focus, chunk, run, { freshEngine: q.force })
        done += chunk.length
        if (genRef.current === gen) setAllProgress({ done: Math.min(plies.length, done), total: plies.length })
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker))
    // Taken over mid-run: the takeover released the lock and kept pendingRun,
    // and the NEW run now owns the progress state and the queue — touch none
    // of it here.
    if (run.cancelled) return
    // A run must not END with blank cards: any ply whose analysis came back
    // empty (a skipped ply both requests missed) gets ONE final repair pass
    // here, inside the same run — never again on later opens. Read from the
    // save when the user has moved on: resultsRef tracks the on-screen game.
    const onThisGame = genRef.current === gen || storeRef.current?.key === runKey
    const resultsNow = onThisGame
      ? resultsRef.current
      : ((runKey ? loadGame(runKey)?.results : undefined) ?? {})
    const stillEmpty = plies.filter((p) => isEmptyResult(resultsNow[p]))
    if (stillEmpty.length > 0) {
      await analyzePlies(q.moves, q.focus, stillEmpty, run)
    }
    if (run.cancelled) return // taken over during the repair pass
    if (activeRunRef.current === run) activeRunRef.current = null
    if (runKey) {
      setBgAnalysing((prev) => {
        const c = new Set(prev)
        c.delete(runKey)
        return c
      })
      // this unblocks the overview — the analysis of every move is in
      setAnalysisRunDone((prev) => new Set(prev).add(runKey))
      // the run finished — it must not resume on the next open
      const endSave = loadGame(runKey)
      if (endSave?.pendingRun) saveGame({ ...endSave, pendingRun: false })
    }
    setHistory(listGames())
    if (genRef.current === gen) {
      setAllProgress(null)
      setQueuedPlies(new Set())
    }
    // one game at a time, in tap order: the next queued game starts the
    // moment this one finishes
    startNextQueued()
  }

  const startNextQueued = () => {
    while (queueRef.current.length > 0) {
      const nxt = queueRef.current.shift()!
      setAnalysisQueue(queueRef.current.map((e) => e.key))
      if (!loadGame(nxt.key)) continue // deleted while it waited — skip
      void startAnalysisRun(nxt)
      return
    }
  }

  const handleAnalyzeAll = async (
    force = false,
    opts?: { repairEmpty?: boolean; includeLite?: boolean; explicit?: boolean },
  ) => {
    // Server-side runs: the tap queues a job in the cloud and returns — the
    // analysis survives the phone locking or the tab closing, and multiple
    // games queue naturally on the server. The poll effect streams results
    // back in. On enqueue failure (offline?) fall through to the local path.
    if (serverRunsRef.current && storeRef.current?.key) {
      const key = storeRef.current.key
      const shell: SavedGame = loadGame(key) ?? {
        key,
        pgn: storeRef.current.pgn,
        focus,
        headers: headersRef.current,
        savedAt: Date.now(),
        results: {},
      }
      const job = await serverEnqueue(shell, {
        force,
        includeLite: opts?.includeLite === true,
        repairEmpty: opts?.repairEmpty === true,
      })
      if (job) {
        if (force) {
          // same on-screen resets as a local force run (the server clears its
          // own engine cache; local evals stay until fresh ones stream in)
          clearEngineCache()
          setGameOverview(null)
          setOverviewError(null)
          setAnalysisRunDone((prev) => {
            const c = new Set(prev)
            c.delete(key)
            return c
          })
        }
        setServerJob({ key, job })
        return
      }
    }
    const q: QueuedAnalysis = {
      key: storeRef.current?.key ?? '',
      pgn: storeRef.current?.pgn ?? '',
      headers: headersRef.current,
      moves,
      focus,
      force,
      repairEmpty: opts?.repairEmpty === true,
      includeLite: opts?.includeLite === true,
    }
    // ONE analysis run at a time, across all games: parallel runs would fight
    // over the single engine worker and double-analyse overlapping plies.
    // While another game's run holds the lock, an EXPLICIT tap QUEUES this
    // game (it starts the moment the current run finishes); a second tap on a
    // queued game jumps the queue — the active run is cancelled and resumes
    // on its game's next open. Auto runs still defer (their effect re-fires
    // when the lock frees up). activeRunRef is the synchronous lock — state
    // (bgAnalysing) can lag a render behind.
    const prior = activeRunRef.current
    if (prior) {
      if (opts?.explicit !== true) return
      if (prior.key && prior.key === q.key) {
        // re-analysing the very game that's running: restart it right away
        cancelActiveRun()
        await startAnalysisRun(q)
        return
      }
      const idx = queueRef.current.findIndex((e) => e.key === q.key)
      if (idx === -1) {
        queueRef.current.push(q)
        setAnalysisQueue(queueRef.current.map((e) => e.key))
        return
      }
      // second tap: jump the queue
      queueRef.current.splice(idx, 1)
      setAnalysisQueue(queueRef.current.map((e) => e.key))
      cancelActiveRun()
      await startAnalysisRun(q)
      return
    }
    await startAnalysisRun(q)
  }

  // Analyse the WHOLE game automatically after a load: browsing stays instant
  // because every move is already (being) analysed in background batches.
  // The marker includes the lite flag: it loads async from the server, and a
  // game opened before it lands must re-run once it does, or the opponent
  // moves would silently stay unanalysed for the whole session.
  // An ACTIVE background run for this game blocks a duplicate; a run that
  // died (reload, phone lock, tab discarded) re-arms on the next open —
  // handleSubmit clears the marker, so re-entering always self-heals.
  const autoRanRef = useRef<string | null>(null)
  useEffect(() => {
    if (phase !== 'game' || moves.length === 0) return
    if (restoringKey) return // the cloud may have this analysis — don't redo it
    if (!liteKnown) return // don't start half-scoped — wait for the server flag
    const gameK = storeRef.current?.key ?? ''
    // ANY active run defers this one — the effect re-fires when it finishes
    // (bgAnalysing is a dependency), and the marker below is not yet set.
    // activeRunRef is the synchronous check: a queued run chains into the
    // next one before the state commit lands.
    if (bgAnalysing.size > 0 || activeRunRef.current) return
    const key = gameK + (hasLiteKey ? '+lite' : '')
    if (autoRanRef.current === key) return
    autoRanRef.current = key
    // Auto-analysis runs for BRAND-NEW games, and RESUMES a run that died
    // mid-way (tab closed, phone locked — the save still carries its
    // pendingRun flag). Any other reopened game starts nothing by itself:
    // whatever is missing waits on the "Analyse remaining" button.
    const interrupted = gameK ? loadGame(gameK)?.pendingRun === true : false
    if (Object.keys(results).length > 0 && !interrupted) return
    void handleAnalyzeAll(false, { includeLite: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, moves, restoringKey, hasLiteKey, bgAnalysing, liteKnown])

  // Background Stockfish sweep: one eval per position so the eval bar covers
  // the whole game. Shares the engine's FEN cache with the per-move checks.
  // "Re-analyse all" forces a full redo (forceSweepRef + sweepGen bump).
  const sweepRef = useRef<string | null>(null)
  useEffect(() => {
    if (phase !== 'game' || moves.length === 0) return
    const key = storeRef.current?.key ?? ''
    if (!forceSweepRef.current && sweepRef.current === key) return
    const forced = forceSweepRef.current
    forceSweepRef.current = false
    sweepRef.current = key
    const gen = genRef.current
    const known = forced ? new Set<number>() : new Set(Object.keys(evals).map(Number))
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
  }, [phase, moves, sweepGen])

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
    setQuizEngineBusy(null)
    setGameOverview(null)
    setEvals({})
    setPgnEvalCoverage(0)
    setOverviewLoading(false)
    setOverviewError(null)
    setJumpBack(null)
    setGfx({ kind: 'auto' })
    setHistory(listGames())
  }

  // Digests of every locally analysed game — the meta report and the
  // cross-game Ask box both run on these (the server adds the cloud archive).
  const metaSummaries = useMemo(
    () =>
      history.filter((g) => Object.keys(g.results).length > 0).map(summarizeGame),
    [history],
  )
  // Local + cloud-archive digests, deduped (local wins) — the live cross-game
  // stats and history rows cover the WHOLE backlog, not just this browser.
  const allSummaries = useMemo(() => {
    if (!cloudSummaries?.length) return metaSummaries
    const localKeys = new Set(metaSummaries.map((s) => s.key))
    return [...metaSummaries, ...cloudSummaries.filter((s) => !localKeys.has(s.key))]
  }, [metaSummaries, cloudSummaries])

  // Cross-game meta-analysis: the server merges the cloud archive on top and
  // asks Claude for the patterns. The report persists locally until regenerated.
  const generateMeta = async () => {
    if (metaLoading) return
    setMetaLoading(true)
    setMetaError(null)
    try {
      const summaries = metaSummaries
      const resp = await fetchMetaApi({ mode: 'meta', summaries, apiKey: apiKey.trim() || undefined })
      const rep: SavedMetaReport = { ...resp.report, generatedAt: Date.now(), gamesCount: resp.gamesUsed }
      try {
        localStorage.setItem(META_KEY, JSON.stringify(rep))
      } catch {
        /* best-effort */
      }
      cloudSaveMeta(rep) // follows the user across devices, like the games
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

  // Landing live status: while any cloud job is queued/running, keep the
  // cloud list fresh so the rows show analysis progress. The list also
  // refreshes once whenever the landing screen is (re-)entered, so counts and
  // finished runs are never a session stale.
  const anyCloudJobActive = useMemo(
    () =>
      (cloudGames ?? []).some(
        (c) => c.job && (c.job.status === 'queued' || c.job.status === 'running'),
      ),
    [cloudGames],
  )
  useEffect(() => {
    if (phase !== 'input' || !serverRuns) return
    let cancelled = false
    const refresh = () =>
      void cloudList().then((games) => {
        if (!cancelled && games) setCloudGames(games)
      })
    refresh()
    if (!anyCloudJobActive) {
      return () => {
        cancelled = true
      }
    }
    const iv = setInterval(refresh, 6000)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [phase, serverRuns, anyCloudJobActive])

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
     * to the app — never when it was (re-)analysed. Shown on the row. */
    date: number
    /** list position: when the game was ADDED to the app — stable across
     * re-analysis (which bumps savedAt but must not reorder the list) */
    sortKey: number
    result?: 'won' | 'lost' | 'draw'
    analysed: number
    hasQuiz: boolean
    cloudOnly: boolean
    /** present in the cloud (listed there, or upload confirmed this session) */
    inCloud: boolean
    /** which side is the user (from the local save; cloud listings don't carry it) */
    me?: Color
    /** chess.com-style accuracy % for the player's side, when engine-checked */
    accuracy?: number
    /** cloud analysis job (queued/running shows a live badge on the row) */
    job?: CloudGameMeta['job']
  }
  // Result from the player's own perspective (me flag, else the studied side).
  const resultFor = (
    h: Record<string, string>,
    me: Color | undefined,
    focus: Focus,
  ): 'won' | 'lost' | 'draw' | undefined => {
    const r = h?.Result
    if (r === '1/2-1/2') return 'draw'
    const side = me ?? (focus !== 'both' ? focus : undefined)
    if (!side) return undefined
    if (r === '1-0') return side === 'w' ? 'won' : 'lost'
    if (r === '0-1') return side === 'b' ? 'won' : 'lost'
    return undefined
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
    const accByKey = new Map(allSummaries.map((s) => [s.key, s.engine?.accuracy]))
    const byKey = new Map<string, HistoryItem>()
    for (const g of history) {
      byKey.set(g.key, {
        key: g.key,
        pgn: g.pgn,
        focus: g.focus,
        headers: g.headers,
        savedAt: g.savedAt,
        date: gameDate(g.headers, g.addedAt, g.savedAt),
        sortKey: g.addedAt ?? gameDate(g.headers, undefined, g.savedAt),
        result: resultFor(g.headers, g.me, g.focus),
        analysed: Object.keys(g.results).length,
        hasQuiz: sanitizeQuiz(g.quiz) !== null, // old-format quizzes are gone on load
        cloudOnly: false,
        inCloud: syncedKeys.has(g.key),
        me: g.me,
        accuracy: accByKey.get(g.key),
      })
    }
    for (const c of cloudGames ?? []) {
      const local = byKey.get(c.key)
      if (local) {
        local.inCloud = true
        local.job = c.job
        // a cloud run may be ahead of this device's stale save — show the truth
        local.analysed = Math.max(local.analysed, c.analysed)
      }
      if (!local) {
        byKey.set(c.key, {
          ...c,
          date: gameDate(c.headers, c.addedAt, c.savedAt),
          sortKey: c.addedAt ?? gameDate(c.headers, undefined, c.savedAt),
          result: resultFor(c.headers, undefined, c.focus),
          cloudOnly: true,
          inCloud: true,
          accuracy: accByKey.get(c.key),
        })
      } else if (c.savedAt > local.savedAt) {
        byKey.set(c.key, {
          ...local,
          savedAt: c.savedAt,
          analysed: Math.max(local.analysed, c.analysed),
          hasQuiz: local.hasQuiz || c.hasQuiz,
        })
      }
    }
    // Newest first, where "newest" is the LATER of the game's own date and the
    // day it was added: games sit at their played date (so the listing reads
    // chronologically and reopening never reorders — both stamps are stable),
    // but a game imported long after it was played (or the 1851 example game)
    // still surfaces at the top on the day it was added instead of sinking
    // straight to the bottom. Compare by calendar DAY (a PGN Date header lands
    // at midnight while addedAt carries a clock time — mixing granularities
    // let a dateless game outrank a game pasted after it), then addedAt so the
    // most recently added game tops its day, then the key keeps equal stamps
    // stable no matter what order the LRU index delivered them.
    const dayOf = (t: number) => new Date(t).setHours(0, 0, 0, 0)
    const recency = (h: HistoryItem) => Math.max(dayOf(h.date), dayOf(h.sortKey))
    return [...byKey.values()].sort(
      (a, b) => recency(b) - recency(a) || b.sortKey - a.sortKey || (a.key < b.key ? -1 : 1),
    )
  }, [history, cloudGames, syncedKeys, allSummaries])

  // Every analysed move flagged dubious — or costing 1+ pawn by the engine —
  // becomes a practice position for the Drill screen, as long as we know a
  // better move (the engine's, else the AI's suggested alternative).
  const drillItems = useMemo<DrillItem[]>(() => {
    const out: DrillItem[] = []
    for (const g of history) {
      let parsed: ParsedMove[] | null = null
      const meSide = g.me ?? (g.focus !== 'both' ? g.focus : undefined)
      for (const r of Object.values(g.results)) {
        const mistake = r.soundness === 'dubious' || (r.engine?.cpLoss ?? 0) >= 100
        if (!mistake) continue
        // when the ENGINE verified the played move as its top choice, there is
        // no better move to drill — never fall back to the AI's alternative
        if (r.engine?.isBest) continue
        const best = r.engine ? r.engine.bestSan : r.alternative?.move
        if (!best) continue
        if (!parsed) {
          try {
            parsed = parsePgn(g.pgn).moves
          } catch {
            break
          }
        }
        const mv = parsed[r.ply]
        if (!mv) continue
        if (meSide ? mv.color !== meSide : !isStudied(mv.color, g.focus)) continue
        // the stored better move must be LEGAL here (the AI's alternative can
        // hallucinate) — validate now so the drill count is always honest,
        // and adopt the canonical SAN spelling for exact option matching
        let legal: string[]
        try {
          legal = new Chess(mv.fenBefore).moves()
        } catch {
          continue
        }
        const plainSan = (x: string) => x.replace(/[+#]/g, '')
        const canonBest = legal.find((m) => plainSan(m) === plainSan(best))
        if (!canonBest || plainSan(canonBest) === plainSan(mv.san)) continue
        out.push({
          key: `${g.key}:${r.ply}`,
          gameKey: g.key,
          ply: r.ply,
          fen: mv.fenBefore,
          color: mv.color,
          played: mv.san,
          best: canonBest,
          legal,
          cpLoss: r.engine?.cpLoss,
          ruleIds: r.rules.filter((h) => h.status === 'violates').map((h) => h.id),
          lesson: r.lesson,
          why: r.alternative?.why,
          label: `${g.headers.White ?? 'White'} vs ${g.headers.Black ?? 'Black'} · move ${Math.floor(r.ply / 2) + 1}`,
        })
      }
    }
    return out
  }, [history])

  const eloOf = (h: Record<string, string>, c: Color): number | undefined => {
    const v = parseInt((c === 'w' ? h?.WhiteElo : h?.BlackElo) ?? '', 10)
    return Number.isFinite(v) && v > 0 ? v : undefined
  }
  // The strength faced: the non-you side's Elo; when the user's side is
  // unknown (both studied, no flag) fall back to the stronger listed player.
  const opponentEloOf = (g: HistoryItem): number | undefined => {
    const me = g.me ?? (g.focus !== 'both' ? g.focus : undefined)
    if (me) return eloOf(g.headers, me === 'w' ? 'b' : 'w')
    const w = eloOf(g.headers, 'w')
    const b = eloOf(g.headers, 'b')
    return w !== undefined && b !== undefined ? Math.max(w, b) : (w ?? b)
  }

  // History filters: player name, studied colour, result, opponent-Elo range.
  const [histFilter, setHistFilter] = useState({
    q: '',
    color: 'all' as 'all' | Focus,
    result: 'all' as 'all' | 'won' | 'lost' | 'draw',
    eloMin: '',
    eloMax: '',
  })
  const histFilterActive =
    histFilter.q !== '' ||
    histFilter.color !== 'all' ||
    histFilter.result !== 'all' ||
    histFilter.eloMin !== '' ||
    histFilter.eloMax !== ''
  const visibleHistory = useMemo(() => {
    if (!histFilterActive) return historyItems
    const q = histFilter.q.trim().toLowerCase()
    const min = parseInt(histFilter.eloMin, 10)
    const max = parseInt(histFilter.eloMax, 10)
    return historyItems.filter((g) => {
      if (q && !`${g.headers.White ?? ''} ${g.headers.Black ?? ''}`.toLowerCase().includes(q)) return false
      if (histFilter.color !== 'all' && g.focus !== histFilter.color) return false
      if (histFilter.result !== 'all' && g.result !== histFilter.result) return false
      if (Number.isFinite(min) || Number.isFinite(max)) {
        const e = opponentEloOf(g)
        if (e === undefined) return false
        if (Number.isFinite(min) && e < min) return false
        if (Number.isFinite(max) && e > max) return false
      }
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyItems, histFilter, histFilterActive])

  // Open a saved game: when the cloud copy is the only one — or clearly newer
  // than this browser's — pull it down first so the analysis comes with it.
  const openSaved = async (item: HistoryItem, atPly?: number) => {
    const local = loadGame(item.key)
    const cloud = (cloudGames ?? []).find((c) => c.key === item.key)
    if (!local || (cloud && cloud.savedAt > local.savedAt)) {
      const remote = await cloudGet(item.key)
      if (remote) saveGame(remote)
    }
    handleSubmit(item.pgn, item.focus, atPly)
  }

  const deleteSaved = (key: string) => {
    const item = historyItems.find((h) => h.key === key)
    const name = item ? `${item.headers.White ?? 'White'} vs ${item.headers.Black ?? 'Black'}` : 'this game'
    if (!window.confirm(`Delete ${name} and its analysis everywhere (this device and the cloud)?`)) return
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
      if (e.key === 'ArrowRight') stepPlyRef.current(1)
      if (e.key === 'ArrowLeft') stepPlyRef.current(-1)
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

  // Stockfish's best move resolved the same way — shown in blue so "the engine
  // says" reads apart from the coach's green suggestion.
  const engineArrow = useMemo(() => {
    const e = results[selectedPly]?.engine
    const m = moves[selectedPly]
    if (!e || e.isBest || !m) return null
    try {
      const mv = new Chess(m.fenBefore).move(e.bestSan, { strict: false })
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
    if (gfx.kind === 'engine') {
      return engineArrow
        ? { arrows: [{ from: engineArrow.from, to: engineArrow.to, color: 'blue' }] }
        : undefined
    }
    const r = results[selectedPly]
    if (!r) return undefined
    if (gfx.kind === 'rule') return r.rules.find((h) => h.id === gfx.id)?.graphics
    // auto: the key rule's graphics PLUS the better-move arrow, chess.com
    // style — Stockfish's best in blue whenever the played move wasn't it,
    // falling back to the coach's cleaner alternative (green) when there is
    // no engine check. No tapping a chip required; "off" still hides all.
    const base = autoGfxRule?.graphics
    const better = engineArrow
      ? { from: engineArrow.from, to: engineArrow.to, color: 'blue' as const }
      : !r.engine && altArrow
        ? { from: altArrow.from, to: altArrow.to, color: 'green' as const }
        : null
    if (!better) return base
    const arrows = [...(base?.arrows ?? [])]
    if (!arrows.some((a) => a.from === better.from && a.to === better.to)) arrows.push(better)
    return { ...(base?.squares?.length ? { squares: base.squares } : {}), arrows }
  }, [gfx, altArrow, engineArrow, results, selectedPly, autoGfxRule])

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
  const focusMovesRemaining = moves.filter(
    (m) => isStudied(m.color, focus) && (!results[m.ply] || isEmptyResult(results[m.ply])),
  ).length
  // What "Analyse remaining" will ACTUALLY run (incl. the opponent's moves on
  // the lite tier and empty-shell repairs) — the button count must match the
  // progress counter it produces, not just the studied side.
  const analyseRemainingCount = moves.filter(
    (m) =>
      (isStudied(m.color, focus) || hasLiteKey) &&
      (!results[m.ply] || isEmptyResult(results[m.ply])),
  ).length
  const studiedPlies = useMemo(
    () => moves.filter((m) => isStudied(m.color, focus)).map((m) => m.ply),
    [moves, focus],
  )
  const analyzedFocus = studiedPlies.length - focusMovesRemaining
  // Is anything actually working (or about to work) on THIS game? The overview
  // card must not show an "analysing…" spinner on a game nothing is analysing
  // — a partially-analysed game with no run is a dead end the user has to
  // unstick by hand, and the card says so instead.
  const overviewRunActive =
    bgAnalysing.has(overviewGameKey) ||
    serverActive ||
    !!allProgress ||
    analysisQueue.includes(overviewGameKey)

  // Moves worth revisiting: judged dubious, or a 1.5+ pawn engine loss.
  const dubiousPlies = useMemo(
    () =>
      moves
        .filter((m) => isStudied(m.color, focus))
        .map((m) => m.ply)
        .filter((ply) => {
          const r = results[ply]
          return !!r && (r.soundness === 'dubious' || (r.engine?.cpLoss ?? 0) >= 150)
        }),
    [moves, focus, results],
  )

  // Step through EVERY ply (both sides) so the game's sequence is followable;
  // opponent moves show on the board with a note, studied moves get analysis.
  // In dubious-only mode the same step jumps between flagged moves instead.
  const stepPly = (dir: 1 | -1) => {
    if (dubiousOnly && dubiousPlies.length) {
      const next =
        dir === 1
          ? dubiousPlies.find((ply) => ply > selectedPly)
          : [...dubiousPlies].reverse().find((ply) => ply < selectedPly)
      if (next !== undefined) setSelectedPly(next)
      return
    }
    setSelectedPly((p) => Math.min(moves.length - 1, Math.max(0, p + dir)))
  }
  // The keyboard listener (and swipe) call through a ref so they always see
  // the current mode without re-subscribing.
  const stepPlyRef = useRef(stepPly)
  stepPlyRef.current = stepPly

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
  // Desktop: the panel is its own scroll container (sticky next to the board),
  // so only ITS scroll resets — the page and the board never move. Mobile:
  // the page scrolls under the pinned board, so the window scrolls instead.
  const scrollToAnalysisTop = useCallback((force = false) => {
    const panel = explainRef.current
    if (!panel) return
    if (getComputedStyle(panel).overflowY === 'auto') {
      panel.scrollTo({ top: 0 })
      return
    }
    const sticky = stickyRef.current
    const stickyH =
      sticky && getComputedStyle(sticky).position === 'sticky'
        ? sticky.getBoundingClientRect().height
        : 82 // fallback: just below the sticky topbar
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
    const panel = explainRef.current
    const onScroll = () => {
      if (tab === 'rules' || tab === 'map') {
        setShowToTop(window.scrollY > 220)
        return
      }
      if (!panel) {
        setShowToTop(false)
        return
      }
      if (getComputedStyle(panel).overflowY === 'auto') {
        setShowToTop(panel.scrollTop > 220)
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
    panel?.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      panel?.removeEventListener('scroll', onScroll)
    }
  }, [tab])
  const atFirst = selectedPly <= 0
  const atLast = moves.length === 0 || selectedPly >= moves.length - 1
  // In dubious-only mode the arrows are exhausted when no flagged move remains
  // in that direction.
  const noPrev = dubiousOnly && dubiousPlies.length ? !dubiousPlies.some((p) => p < selectedPly) : atFirst
  const noNext = dubiousOnly && dubiousPlies.length ? !dubiousPlies.some((p) => p > selectedPly) : atLast
  const moveLabel = (m: ParsedMove) => `${m.moveNumber}${m.color === 'w' ? '.' : '…'} ${m.san}`

  // Which piece should glide when the shown position changes: stepping forward
  // animates the arriving move; stepping back animates the piece returning;
  // longer jumps animate the move that produced the new position.
  const prevPlyRef = useRef<number | null>(null)
  const prevPlyForAnim = prevPlyRef.current
  let boardAnim: { from: string; to: string } | null = null
  if (prevPlyForAnim !== null && prevPlyForAnim !== selectedPly && moves.length) {
    if (selectedPly === prevPlyForAnim - 1 && moves[prevPlyForAnim]) {
      const undone = moves[prevPlyForAnim]
      boardAnim = { from: undone.to, to: undone.from }
    } else if (moves[selectedPly]) {
      boardAnim = { from: moves[selectedPly].from, to: moves[selectedPly].to }
    }
  }
  useEffect(() => {
    prevPlyRef.current = selectedPly
  }, [selectedPly])

  // Swipe on the board area browses moves (horizontal-dominant gestures only,
  // so vertical scrolling through the analysis is unaffected).
  const touchRef = useRef<{ x: number; y: number } | null>(null)
  const onBoardTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0]
    touchRef.current = t ? { x: t.clientX, y: t.clientY } : null
  }
  const onBoardTouchEnd = (e: React.TouchEvent) => {
    const start = touchRef.current
    touchRef.current = null
    const t = e.changedTouches[0]
    if (!start || !t) return
    const dx = t.clientX - start.x
    const dy = t.clientY - start.y
    if (Math.abs(dx) > 48 && Math.abs(dx) > 1.6 * Math.abs(dy)) {
      stepPlyRef.current(dx < 0 ? 1 : -1)
    }
  }

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
        {phase !== 'game' && (
          <div className="topbar-right">
            <button
              className="btn ghost"
              onClick={() => setShowSettings(true)}
              title="Settings"
              aria-label="API key settings"
            >
              ⚙
            </button>
          </div>
        )}
        {phase === 'game' && (
          <div className="topbar-right">
            <div className="game-meta">
              <strong>
                {headers.White ?? 'White'}
                {mySide === 'w'
                  ? ' (you)'
                  : headers.WhiteElo && parseInt(headers.WhiteElo, 10) > 0
                    ? ` (${parseInt(headers.WhiteElo, 10)})`
                    : ''}
              </strong>{' '}
              vs{' '}
              <strong>
                {headers.Black ?? 'Black'}
                {mySide === 'b'
                  ? ' (you)'
                  : headers.BlackElo && parseInt(headers.BlackElo, 10) > 0
                    ? ` (${parseInt(headers.BlackElo, 10)})`
                    : ''}
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
              onClick={() =>
                void handleAnalyzeAll(analyseRemainingCount === 0, {
                  repairEmpty: true,
                  includeLite: true,
                  explicit: true,
                })
              }
              disabled={!!allProgress || bgAnalysing.has(overviewGameKey) || serverActive}
              title={
                serverActive
                  ? 'Analysing in the cloud — this run keeps going even if you close the app.'
                  : serverJob?.key === overviewGameKey && serverJob.job.status === 'error'
                    ? `The cloud run hit a problem (${serverJob.job.error ?? 'unknown'}) — tap to retry.`
                    : bgAnalysing.size > 0 && !bgAnalysing.has(overviewGameKey)
                      ? analysisQueue.includes(overviewGameKey)
                        ? 'Queued after the current analysis — tap again to pause that game and start this one right away.'
                        : 'Another game is being analysed — tapping queues this game to run next.'
                      : analyseRemainingCount === 0
                        ? 'Everything is analysed. Tap to redo the whole game from scratch — fresh Stockfish checks and fresh AI analysis (useful when something looks off).'
                        : undefined
              }
            >
              {serverActive
                ? serverJob?.job.progress
                  ? `Analysing… ${serverJob.job.progress.done}/${serverJob.job.progress.total}`
                  : 'Analysing…'
                : allProgress
                  ? `Analysing… ${allProgress.done}/${allProgress.total}`
                  : analysisQueue.includes(overviewGameKey)
                    ? 'Queued — tap to start now'
                    : analyseRemainingCount === 0
                      ? '↻ Re-analyse all'
                      : analyzedFocus > 0 || focusMovesRemaining === 0
                        ? `Analyse remaining (${analyseRemainingCount})`
                        : `Analyse all ${analyseRemainingCount} moves`}
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

      {drillRun > 0 ? (
        <div className="workspace" hidden={phase !== 'drill'}>
          <Drill
            key={drillRun}
            items={drillItems}
            onOpenRule={openRule}
            onOpenGame={(gameKey, ply) => {
              const item = historyItems.find((h) => h.key === gameKey)
              // the drill stays mounted; the flag is set after the game loads
              if (item) void openSaved(item, ply).then(() => setFromDrill(true))
            }}
            onExit={() => setPhase('input')}
          />
        </div>
      ) : null}
      {phase === 'input' ? (
        <div className="landing">
          <PgnInput
            onSubmit={handleSubmit}
            onOpenSettings={() => setShowSettings(true)}
            error={parseError}
            hasServerKey={hasServerKey}
          />
          <GameImport onPick={handleSubmit} />
          {drillItems.length > 0 ? (
            <div className="card drill-entry">
              <div>
                <h2>🎯 Drill your mistakes</h2>
                <p className="muted small">
                  {drillItems.length} position{drillItems.length === 1 ? '' : 's'} from your games
                  where a better move existed — practise them until they stick.
                </p>
              </div>
              <button
                className="btn primary"
                onClick={() => {
                  setDrillRun((r) => r + 1)
                  setPhase('drill')
                }}
              >
                Start drilling
              </button>
            </div>
          ) : null}
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
              {histOpen && historyItems.length > 3 ? (
                <div className="history-filters">
                  <input
                    className="hf-q"
                    placeholder="Filter by player…"
                    aria-label="Filter games by player name"
                    value={histFilter.q}
                    onChange={(e) => setHistFilter((f) => ({ ...f, q: e.target.value }))}
                  />
                  <select
                    aria-label="Filter by studied colour"
                    value={histFilter.color}
                    onChange={(e) =>
                      setHistFilter((f) => ({ ...f, color: e.target.value as 'all' | Focus }))
                    }
                  >
                    <option value="all">Any colour</option>
                    <option value="w">as White</option>
                    <option value="b">as Black</option>
                    <option value="both">Both sides</option>
                  </select>
                  <select
                    aria-label="Filter by result"
                    value={histFilter.result}
                    onChange={(e) =>
                      setHistFilter((f) => ({
                        ...f,
                        result: e.target.value as 'all' | 'won' | 'lost' | 'draw',
                      }))
                    }
                  >
                    <option value="all">Any result</option>
                    <option value="won">Won</option>
                    <option value="lost">Lost</option>
                    <option value="draw">Draw</option>
                  </select>
                  <input
                    className="hf-elo"
                    inputMode="numeric"
                    placeholder="Elo ≥"
                    aria-label="Minimum opponent Elo"
                    value={histFilter.eloMin}
                    onChange={(e) => setHistFilter((f) => ({ ...f, eloMin: e.target.value }))}
                  />
                  <input
                    className="hf-elo"
                    inputMode="numeric"
                    placeholder="Elo ≤"
                    aria-label="Maximum opponent Elo"
                    value={histFilter.eloMax}
                    onChange={(e) => setHistFilter((f) => ({ ...f, eloMax: e.target.value }))}
                  />
                  {histFilterActive ? (
                    <button
                      className="btn ghost hf-clear"
                      onClick={() =>
                        setHistFilter({ q: '', color: 'all', result: 'all', eloMin: '', eloMax: '' })
                      }
                      aria-label="Clear filters"
                      title="Clear filters"
                    >
                      ✕
                    </button>
                  ) : null}
                </div>
              ) : null}
              {histOpen && histFilterActive ? (
                <p className="muted small hf-count">
                  {visibleHistory.length === 0
                    ? 'No games match these filters.'
                    : `${visibleHistory.length} of ${historyItems.length} games`}
                </p>
              ) : null}
              {histOpen ? (
              <ul className="history-list">
                {visibleHistory.map((g) => (
                  <li key={g.key}>
                    <button className="history-row" onClick={() => void openSaved(g)}>
                      <span className="history-title">
                        {g.headers.White ?? 'White'}
                        {(g.me ?? (g.focus !== 'both' ? g.focus : undefined)) !== 'w' && eloOf(g.headers, 'w') ? (
                          <span className="elo"> ({eloOf(g.headers, 'w')})</span>
                        ) : null}{' '}
                        vs {g.headers.Black ?? 'Black'}
                        {(g.me ?? (g.focus !== 'both' ? g.focus : undefined)) !== 'b' && eloOf(g.headers, 'b') ? (
                          <span className="elo"> ({eloOf(g.headers, 'b')})</span>
                        ) : null}
                      </span>
                      <span className="history-meta">
                        as {colorName(g.focus)} · {g.analysed} analysed
                        {g.accuracy != null ? (
                          <>
                            {' · '}
                            <span
                              className="hist-acc"
                              title="Engine accuracy for your side (chess.com-style scale)"
                            >
                              {g.accuracy}%
                            </span>
                          </>
                        ) : null}
                        {bgAnalysing.has(g.key)
                          ? ' · analysing…'
                          : g.job && (g.job.status === 'queued' || g.job.status === 'running')
                            ? g.job.status === 'queued'
                              ? ' · ☁ queued'
                              : g.job.progress
                                ? ` · ☁ analysing ${g.job.progress.done}/${g.job.progress.total}`
                                : ' · ☁ analysing…'
                            : ''}
                        {g.hasQuiz ? ' · quiz' : ''}
                        {g.inCloud || g.cloudOnly ? ' · ☁' : ''} ·{' '}
                        {new Date(g.date).toLocaleDateString(undefined, {
                          day: 'numeric',
                          month: 'short',
                          ...(new Date(g.date).getFullYear() !== new Date().getFullYear()
                            ? { year: 'numeric' }
                            : {}),
                        })}
                      </span>
                      {g.result ? (
                        <span
                          className={'cc-res r-' + g.result}
                          title={g.result === 'won' ? 'You won' : g.result === 'lost' ? 'You lost' : 'Draw'}
                        >
                          {g.result === 'won' ? 'W' : g.result === 'lost' ? 'L' : '='}
                        </span>
                      ) : null}
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
            onOpenGame={(key, ply) => {
              const item = historyItems.find((h) => h.key === key)
              // the flag is set AFTER the game loads (handleSubmit clears it)
              if (item) void openSaved(item, ply).then(() => setFromMeta(true))
            }}
            onOpenRule={openRule}
            summaries={allSummaries}
            apiKey={apiKey}
            onNeedKey={() => setShowSettings(true)}
          />
        </div>
      ) : phase !== 'game' ? null : (
        <div className="workspace">
          {(allProgress || bgAnalysing.has(overviewGameKey) || serverActive) && studiedPlies.length > 0 ? (
            <div className="ana-progress" role="status">
              <div className="ana-bar" aria-hidden="true">
                <div
                  className="ana-fill"
                  style={{
                    // the RUN's own counter when one is on screen — a forced
                    // re-analysis keeps old results visible, which would pin a
                    // results-based bar at 100% for the whole redo
                    width: `${Math.round(
                      allProgress
                        ? (100 * allProgress.done) / Math.max(1, allProgress.total)
                        : serverActive && serverJob?.job.progress
                          ? (100 * serverJob.job.progress.done) /
                            Math.max(1, serverJob.job.progress.total)
                          : (100 * (hasLiteKey ? Object.keys(results).length : analyzedFocus)) /
                            Math.max(1, hasLiteKey ? moves.length : studiedPlies.length),
                    )}%`,
                  }}
                />
              </div>
              <span className="ana-text">
                {allProgress
                  ? `Analysing · ${allProgress.done}/${allProgress.total}`
                  : serverActive && serverJob?.job.progress
                    ? `Analysing in the cloud · ${serverJob.job.progress.done}/${serverJob.job.progress.total}`
                    : serverActive
                      ? 'Analysing in the cloud…'
                      : hasLiteKey
                        ? `Analysing · ${Object.keys(results).length}/${moves.length}`
                        : `Analysing your moves · ${analyzedFocus}/${studiedPlies.length}`}
                {Object.keys(evals).length < moves.length
                  ? ` · eval bar ${Object.keys(evals).length}/${moves.length}`
                  : ''}
              </span>
            </div>
          ) : null}
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
                waiting={overviewWaiting}
                waitingProgress={{ done: analyzedFocus, total: studiedPlies.length }}
                runActive={overviewRunActive}
                remaining={analyseRemainingCount}
                onAnalyse={() =>
                  void handleAnalyzeAll(false, {
                    repairEmpty: true,
                    includeLite: true,
                    explicit: true,
                  })
                }
                error={overviewError}
                moves={moves}
                onJump={jumpTo}
                onRetry={fetchOverview}
                accuracy={overviewAccuracy}
                askKey={storeRef.current?.key ?? 'game'}
                askContext={{
                  focus,
                  me: mySide,
                  white: headers.White,
                  black: headers.Black,
                  game: toGameMoves(moves),
                }}
                apiKey={apiKey}
                onNeedKey={() => setShowSettings(true)}
                onOpenRule={openRule}
              />
              {/* Only when the game is otherwise DONE: while moves are still
                  unanalysed, "Analyse remaining" is the one action on screen —
                  a second enabled re-analyse button just competes with it. */}
              {analyzedFocus > 0 && !hasAnyGraphics && analyseRemainingCount === 0 ? (
                <div className="regen-banner">
                  <span>
                    This analysis predates the <strong>board graphics</strong> — re-analyse to get
                    squares and arrows with each rule.
                  </span>
                  <button
                    className="btn"
                    onClick={() => void handleAnalyzeAll(true, { explicit: true })}
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
                <div
                  className={'board-sticky' + (boardMini ? ' mini' : '')}
                  ref={stickyRef}
                  onTouchStart={onBoardTouchStart}
                  onTouchEnd={onBoardTouchEnd}
                >
                {/* The alternative-move / engine-move arrows live in the position
                    BEFORE the played move — show that position while one is
                    toggled on. The arrow says it all; no caption (it only ate
                    board space). */}
                {(gfx.kind === 'alt' && altArrow) || (gfx.kind === 'engine' && engineArrow) ? (
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
                    anim={boardAnim}
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
                    disabled={noPrev}
                    aria-label={dubiousOnly ? 'Previous dubious move' : 'Previous move'}
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
                    disabled={noNext}
                    aria-label={dubiousOnly ? 'Next dubious move' : 'Next move'}
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
                    className={'navbtn warnbtn' + (dubiousOnly ? ' on' : '')}
                    onClick={() => setDubiousOnly((v) => !v)}
                    disabled={dubiousPlies.length === 0}
                    aria-pressed={dubiousOnly}
                    aria-label="Step only through dubious moves"
                    title={
                      dubiousPlies.length === 0
                        ? 'No dubious moves flagged (yet)'
                        : dubiousOnly
                          ? 'Stepping through dubious moves only — tap to step through all moves'
                          : `Step only through the ${dubiousPlies.length} dubious move${dubiousPlies.length === 1 ? '' : 's'}`
                    }
                  >
                    ⚠{dubiousPlies.length ? <span className="warn-count">{dubiousPlies.length}</span> : null}
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
                {/* Always rendered (hidden when no eval) so the sticky block
                    keeps a CONSTANT height — otherwise the board visibly jumps
                    when stepping between evaluated and unevaluated moves. */}
                <div
                  className="eval-row"
                  style={currentEvalCp === undefined ? { visibility: 'hidden' } : undefined}
                  title={
                    currentEvalCp === undefined
                      ? undefined
                      : `Stockfish evaluation after this move, from White's side: ${(currentEvalCp / 100).toFixed(2)}`
                  }
                >
                  <div className="evalbar">
                    <div
                      className="evalbar-fill"
                      style={{ width: `${50 + 50 * Math.tanh((currentEvalCp ?? 0) / 600)}%` }}
                    />
                  </div>
                  <span className="eval-num">
                    {currentEvalCp === undefined
                      ? '0.0'
                      : Math.abs(currentEvalCp) >= 9000
                        ? currentEvalCp > 0
                          ? '+M'
                          : '−M'
                        : (currentEvalCp >= 0 ? '+' : '') + (currentEvalCp / 100).toFixed(1)}
                  </span>
                </div>
                {jumpBack !== null && jumpBack !== selectedPly && moves[jumpBack] ? (
                  <button className="jump-back" onClick={returnFromJump}>
                    ↩ Back to {moveLabel(moves[jumpBack])}
                  </button>
                ) : null}
                {fromDrill ? (
                  <button
                    className="jump-back"
                    onClick={() => {
                      setFromDrill(false)
                      setPhase('drill')
                    }}
                  >
                    ↩ Back to the drill
                  </button>
                ) : null}
                {fromMeta ? (
                  <button
                    className="jump-back"
                    onClick={() => {
                      setFromMeta(false)
                      reset()
                      // landing renders next frame — then bring the report into view
                      requestAnimationFrame(() =>
                        document
                          .querySelector('.meta-card')
                          ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
                      )
                    }}
                  >
                    ↩ Back to “Your play” summary
                  </button>
                ) : null}
                </div>
              </div>
              <div className="explain-panel" ref={explainRef}>
                {isStudied(move.color, focus) ||
                results[selectedPly] ||
                (hasLiteKey && (loadingPlies.has(selectedPly) || queuedPlies.has(selectedPly))) ? (
                  <MoveAnalysis
                    move={move}
                    focus={focus}
                    result={results[selectedPly]}
                    loading={loadingPlies.has(selectedPly)}
                    error={errorByPly[selectedPly]}
                    onReanalyze={() =>
                      analyzePlies(moves, focus, [selectedPly], undefined, { freshEngine: true })
                    }
                    onOpenRule={openRule}
                    gfx={gfx}
                    onGfx={setGfx}
                    autoGfxRuleId={autoGfxRule?.id}
                    altArrow={!!altArrow}
                    engineArrow={!!engineArrow}
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
                    me: mySide,
                    white: headers.White,
                    black: headers.Black,
                    game: toGameMoves(moves),
                    ply: selectedPly,
                    san: move.san,
                    fen: move.fenAfter,
                    fenBefore: move.fenBefore,
                    // the coaching on screen — so "why is your suggestion
                    // better?" is understood
                    analysis: results[selectedPly],
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
              key={overviewGameKey} // a different game must not inherit quiz UI state
              moves={moves}
              results={results}
              saved={quizSaved}
              candidates={quizCandidates}
              // pending only while a run is actually going: an errored or
              // never-run analysis must not block starting forever
              analysisPending={bgAnalysing.has(overviewGameKey) ? focusMovesRemaining : 0}
              missingEngine={quizEngineMissing}
              engineBusy={quizEngineBusy}
              onAddEngine={() => void addQuizEngine()}
              onStart={startQuiz}
              // guarded by the game key captured NOW: a slow grade/explanation
              // resolving after the user opened another game patches nothing
              onChange={((key) => (update: (q: SavedQuiz) => SavedQuiz) =>
                setQuizSaved((q) => (q && storeRef.current?.key === key ? update(q) : q)))(
                overviewGameKey,
              )}
              gradeMove={evalCandidateMove}
              explain={explainQuiz}
              onOpenRule={openRule}
              onJump={(ply) => {
                setTab('move')
                jumpTo(ply)
              }}
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
                onReanalyzeAll={() => void handleAnalyzeAll(true, { explicit: true })}
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
          whiteElo={headers.WhiteElo ?? ''}
          blackElo={headers.BlackElo ?? ''}
          me={mySide ?? (focus !== 'both' ? focus : undefined)}
          onSave={(w, b, me, wElo, bElo) => {
            setHeaders((h) => {
              const next: Record<string, string> = { ...h, White: w, Black: b }
              if (wElo) next.WhiteElo = wElo
              else delete next.WhiteElo
              if (bElo) next.BlackElo = bElo
              else delete next.BlackElo
              return next
            })
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
          serverBuild={serverBuild}
          liteModel={liteModel}
          theme={theme}
          onTheme={setTheme}
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

