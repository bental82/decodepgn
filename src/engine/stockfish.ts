// OPTIONAL supporting layer. Stockfish is used only to sanity-check tactics and
// blunders — never as the source of the strategic explanations. It is loaded
// lazily from a CDN as a single-threaded asm.js worker, so it needs no special
// cross-origin headers and deploys to any static host (Vercel, Netlify, ...).
// If it fails to load (offline, blocked CDN), the app degrades gracefully.

const CDN_URL = 'https://cdn.jsdelivr.net/npm/stockfish@10.0.2/src/stockfish.js'

export interface EngineEval {
  /** score in pawns from White's perspective (positive = White better). */
  scorePawns?: number
  mateIn?: number
  bestMove?: string
  depth: number
}

type Pending = {
  resolve: (e: EngineEval) => void
  reject: (err: Error) => void
  lastCp?: number
  lastMate?: number
  depth: number
  turn: 'w' | 'b'
}

export class Stockfish {
  private worker: Worker | null = null
  private ready = false
  private queue: Pending | null = null

  static isSupported(): boolean {
    return typeof window !== 'undefined' && typeof Worker !== 'undefined'
  }

  async init(): Promise<void> {
    if (this.ready) return
    if (!Stockfish.isSupported()) throw new Error('Web Workers are not available in this environment.')
    const bootstrap = `try { importScripts('${CDN_URL}'); } catch (e) { postMessage('LOAD_ERROR:' + e.message); }`
    const blob = new Blob([bootstrap], { type: 'application/javascript' })
    const worker = new Worker(URL.createObjectURL(blob))
    this.worker = worker
    worker.onmessage = (ev: MessageEvent) => this.onLine(String(ev.data))

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Stockfish took too long to load.')), 15000)
      const onReady = (ev: MessageEvent) => {
        const line = String(ev.data)
        if (line.startsWith('LOAD_ERROR:')) {
          clearTimeout(timeout)
          worker.removeEventListener('message', onReady)
          reject(new Error('Could not load Stockfish from the CDN.'))
        } else if (line.includes('uciok')) {
          clearTimeout(timeout)
          worker.removeEventListener('message', onReady)
          this.ready = true
          resolve()
        }
      }
      worker.addEventListener('message', onReady)
      worker.postMessage('uci')
    })
    this.send('isready')
    this.send('ucinewgame')
  }

  private send(cmd: string): void {
    this.worker?.postMessage(cmd)
  }

  private onLine(line: string): void {
    if (!this.queue) return
    const q = this.queue
    if (line.startsWith('info') && line.includes(' score ')) {
      const cpMatch = line.match(/score cp (-?\d+)/)
      const mateMatch = line.match(/score mate (-?\d+)/)
      const depthMatch = line.match(/ depth (\d+)/)
      if (depthMatch) q.depth = parseInt(depthMatch[1], 10)
      if (cpMatch) {
        q.lastCp = parseInt(cpMatch[1], 10)
        q.lastMate = undefined
      }
      if (mateMatch) {
        q.lastMate = parseInt(mateMatch[1], 10)
        q.lastCp = undefined
      }
    } else if (line.startsWith('bestmove')) {
      const best = line.split(' ')[1]
      // engine scores are from the side-to-move's perspective; normalise to White.
      const sign = q.turn === 'w' ? 1 : -1
      const evalResult: EngineEval = {
        depth: q.depth,
        bestMove: best,
        scorePawns: q.lastCp !== undefined ? (sign * q.lastCp) / 100 : undefined,
        mateIn: q.lastMate !== undefined ? sign * q.lastMate : undefined,
      }
      this.queue = null
      q.resolve(evalResult)
    }
  }

  /** Evaluate a FEN to a fixed depth. Serialised: one position at a time. */
  async evaluate(fen: string, depth = 12): Promise<EngineEval> {
    if (!this.ready) await this.init()
    // wait for any in-flight evaluation to finish
    while (this.queue) await new Promise((r) => setTimeout(r, 20))
    const turn = (fen.split(' ')[1] as 'w' | 'b') || 'w'
    return new Promise<EngineEval>((resolve, reject) => {
      this.queue = { resolve, reject, depth: 0, turn }
      this.send('position fen ' + fen)
      this.send('go depth ' + depth)
    })
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
    this.ready = false
    this.queue = null
  }
}

let singleton: Stockfish | null = null
export function getStockfish(): Stockfish {
  if (!singleton) singleton = new Stockfish()
  return singleton
}
