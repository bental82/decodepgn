// Extract everything we can know about a single position, independent of which
// colour the user chose to analyse. Rules read from this structured snapshot.

import { Chess } from 'chess.js'
import {
  FILES,
  PIECE_VALUE,
  boardMapFromArray,
  fileIndex,
  findKing,
  makeSquare,
  onBoard,
  opposite,
  pawnAttackSquares,
  piecesOf,
  rankIndex,
  reachableSquares,
  squareColorOf,
  type BoardMap,
} from './board'
import type {
  BishopInfo,
  CenterInfo,
  Color,
  FileInfo,
  KingZone,
  MaterialBalance,
  MaterialCount,
  OutpostInfo,
  PawnStructure,
  PieceActivity,
  PositionInfo,
  Square,
} from './types'

function newMaterialCount(): MaterialCount {
  return { p: 0, n: 0, b: 0, r: 0, q: 0, points: 0 }
}

function material(board: BoardMap, perspective: Color): MaterialBalance {
  const white = newMaterialCount()
  const black = newMaterialCount()
  for (const p of board.values()) {
    if (p.type === 'k') continue
    const bucket = p.color === 'w' ? white : black
    bucket[p.type as 'p' | 'n' | 'b' | 'r' | 'q'] += 1
    bucket.points += PIECE_VALUE[p.type]
  }
  const rawDiff = white.points - black.points
  return { white, black, diff: perspective === 'w' ? rawDiff : -rawDiff }
}

function pawnStructure(board: BoardMap, color: Color): PawnStructure {
  const own = piecesOf(board, color).filter((p) => p.type === 'p')
  const enemy = piecesOf(board, opposite(color)).filter((p) => p.type === 'p')
  const byFile = new Map<number, number[]>() // file -> ranks
  for (const p of own) {
    const fi = fileIndex(p.square)
    if (!byFile.has(fi)) byFile.set(fi, [])
    byFile.get(fi)!.push(rankIndex(p.square))
  }
  const enemyByFile = new Map<number, number[]>()
  for (const p of enemy) {
    const fi = fileIndex(p.square)
    if (!enemyByFile.has(fi)) enemyByFile.set(fi, [])
    enemyByFile.get(fi)!.push(rankIndex(p.square))
  }
  const enemyPawnAttacks = new Set<Square>()
  for (const p of enemy) for (const s of pawnAttackSquares(opposite(color), p.square)) enemyPawnAttacks.add(s)

  const dir = color === 'w' ? 1 : -1
  const pawns: PawnStructure['pawns'] = []
  const doubledFiles = new Set<string>()
  const isolatedSquares: Square[] = []
  const backwardSquares: Square[] = []
  const passedSquares: Square[] = []

  for (const p of own) {
    const fi = fileIndex(p.square)
    const ri = rankIndex(p.square)
    const sameFile = byFile.get(fi)!
    const doubled = sameFile.length > 1
    if (doubled) doubledFiles.add(FILES[fi])

    const leftHas = (byFile.get(fi - 1)?.length ?? 0) > 0
    const rightHas = (byFile.get(fi + 1)?.length ?? 0) > 0
    const isolated = !leftHas && !rightHas

    // passed: no enemy pawn on this or adjacent file ahead of the pawn
    let passed = true
    for (const f of [fi - 1, fi, fi + 1]) {
      const ranks = enemyByFile.get(f)
      if (!ranks) continue
      for (const r of ranks) {
        if (color === 'w' ? r > ri : r < ri) passed = false
      }
    }

    // backward: cannot be defended by a friendly pawn (no friendly pawn on an
    // adjacent file at or behind this rank) and the stop-square is covered by an
    // enemy pawn.
    const stop = makeSquare(fi, ri + dir)
    let supportable = false
    for (const f of [fi - 1, fi + 1]) {
      for (const r of byFile.get(f) ?? []) {
        if (color === 'w' ? r <= ri : r >= ri) supportable = true
      }
    }
    const backward = !isolated && !supportable && onBoard(fi, ri + dir) && enemyPawnAttacks.has(stop)

    if (isolated) isolatedSquares.push(p.square)
    if (backward) backwardSquares.push(p.square)
    if (passed) passedSquares.push(p.square)
    pawns.push({
      square: p.square,
      file: FILES[fi],
      rank: ri + 1,
      doubled,
      isolated,
      backward,
      passed,
    })
  }

  return {
    pawns,
    doubledFiles: [...doubledFiles],
    isolatedSquares,
    backwardSquares,
    passedSquares,
  }
}

function fileInfo(board: BoardMap): FileInfo {
  const whitePawnFiles = new Set<number>()
  const blackPawnFiles = new Set<number>()
  for (const p of board.values()) {
    if (p.type !== 'p') continue
    if (p.color === 'w') whitePawnFiles.add(fileIndex(p.square))
    else blackPawnFiles.add(fileIndex(p.square))
  }
  const open: string[] = []
  const semiOpenForWhite: string[] = []
  const semiOpenForBlack: string[] = []
  for (let f = 0; f < 8; f++) {
    const w = whitePawnFiles.has(f)
    const b = blackPawnFiles.has(f)
    if (!w && !b) open.push(FILES[f])
    else {
      if (!w && b) semiOpenForWhite.push(FILES[f])
      if (!b && w) semiOpenForBlack.push(FILES[f])
    }
  }
  return { open, semiOpenForWhite, semiOpenForBlack }
}

function centerInfo(board: BoardMap): CenterInfo {
  // central files c-f (2..5), central ranks 3-6 (2..5)
  let whiteCentralPawns = 0
  let blackCentralPawns = 0
  const pawnAt = (fi: number, ri: number): Color | null => {
    const p = board.get(makeSquare(fi, ri))
    return p && p.type === 'p' ? p.color : null
  }
  for (let f = 2; f <= 5; f++) {
    for (let r = 2; r <= 5; r++) {
      const c = pawnAt(f, r)
      if (c === 'w') whiteCentralPawns++
      else if (c === 'b') blackCentralPawns++
    }
  }
  // locked contacts: a white pawn with a black pawn directly in front on d/e files
  let lockedContacts = 0
  for (let f = 2; f <= 5; f++) {
    for (let r = 1; r <= 6; r++) {
      if (pawnAt(f, r) === 'w' && pawnAt(f, r + 1) === 'b') lockedContacts++
    }
  }
  const total = whiteCentralPawns + blackCentralPawns
  const openness = Math.max(0, Math.min(100, 100 - 16 * total - 22 * lockedContacts))
  let state: CenterInfo['state']
  if (lockedContacts >= 2) state = 'locked'
  else if (openness >= 66) state = 'open'
  else if (openness >= 40) state = 'semi-open'
  else state = 'closed'
  return { state, openness, whiteCentralPawns, blackCentralPawns, lockedContacts }
}

function spaceFor(board: BoardMap, color: Color): number {
  // squares in the opponent's half controlled by this colour's pawns
  const ranks = color === 'w' ? [3, 4, 5] : [4, 3, 2] // 0-based ranks 4-6 / 3-5
  const controlled = new Set<Square>()
  for (const p of piecesOf(board, color)) {
    if (p.type !== 'p') continue
    for (const s of pawnAttackSquares(color, p.square)) {
      if (ranks.includes(rankIndex(s))) controlled.add(s)
    }
  }
  return controlled.size
}

function activity(board: BoardMap): PieceActivity[] {
  const out: PieceActivity[] = []
  for (const p of board.values()) {
    if (p.type === 'k' || p.type === 'p') continue
    const reach = reachableSquares(board, p.square)
    const fi = fileIndex(p.square)
    const ri = rankIndex(p.square)
    const centralized = fi >= 2 && fi <= 5 && ri >= 2 && ri <= 5
    let blockingPawns: number | undefined
    if (p.type === 'b') {
      const sc = squareColorOf(p.square)
      blockingPawns = piecesOf(board, p.color).filter(
        (q) => q.type === 'p' && squareColorOf(q.square) === sc,
      ).length
    }
    // score: mobility scaled, small central bonus, bishop penalised by own pawns
    const maxMob = p.type === 'q' ? 27 : p.type === 'r' ? 14 : p.type === 'b' ? 13 : 8
    let score = Math.round((reach.length / maxMob) * 80)
    if (centralized) score += 12
    if (blockingPawns !== undefined) score -= blockingPawns * 4
    score = Math.max(0, Math.min(100, score))
    out.push({
      square: p.square,
      type: p.type,
      color: p.color,
      mobility: reach.length,
      centralized,
      blockingPawns,
      score,
    })
  }
  return out
}

function bishopInfo(board: BoardMap, color: Color): BishopInfo[] {
  const out: BishopInfo[] = []
  for (const p of piecesOf(board, color)) {
    if (p.type !== 'b') continue
    const sc = squareColorOf(p.square)
    const ownPawnsSameColor = piecesOf(board, color).filter(
      (q) => q.type === 'p' && squareColorOf(q.square) === sc,
    ).length
    const mobility = reachableSquares(board, p.square).length
    out.push({
      square: p.square,
      color,
      squareColor: sc,
      ownPawnsSameColor,
      bad: ownPawnsSameColor >= 4 && mobility <= 6,
      mobility,
    })
  }
  return out
}

function kingZone(chess: Chess, board: BoardMap, color: Color, files: FileInfo): KingZone {
  const square = findKing(board, color)!
  const fi = fileIndex(square)
  const ri = rankIndex(square)
  const dir = color === 'w' ? 1 : -1
  const enemy = opposite(color)

  const zone: Square[] = []
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (onBoard(fi + df, ri + dr)) zone.push(makeSquare(fi + df, ri + dr))
    }
  }
  // shield: friendly pawns on the three files in front of the king
  let shieldPawns = 0
  const weakSquares: Square[] = []
  for (let df = -1; df <= 1; df++) {
    if (!onBoard(fi + df, ri + dir)) continue
    const front1 = makeSquare(fi + df, ri + dir)
    const front2 = onBoard(fi + df, ri + 2 * dir) ? makeSquare(fi + df, ri + 2 * dir) : null
    const p1 = board.get(front1)
    const p2 = front2 ? board.get(front2) : null
    const hasShield =
      (p1 && p1.type === 'p' && p1.color === color) || (p2 && p2.type === 'p' && p2.color === color)
    if (hasShield) shieldPawns++
    else weakSquares.push(front1)
  }

  const attackerSet = new Set<Square>()
  const defenderSet = new Set<Square>()
  for (const sq of zone) {
    for (const a of chess.attackers(sq as any, enemy)) attackerSet.add(a)
    for (const d of chess.attackers(sq as any, color)) if (d !== square) defenderSet.add(d)
  }

  const openFilesNearKing: string[] = []
  for (let df = -1; df <= 1; df++) {
    if (!onBoard(fi + df, 0)) continue
    const f = FILES[fi + df]
    if (files.open.includes(f) || (color === 'w' ? files.semiOpenForBlack : files.semiOpenForWhite).includes(f)) {
      openFilesNearKing.push(f)
    }
  }

  const castledSide: KingZone['castledSide'] = fi <= 2 ? 'queen' : fi >= 6 ? 'king' : 'center'

  let exposure = 0
  exposure += (3 - shieldPawns) * 14
  exposure += attackerSet.size * 12
  exposure -= defenderSet.size * 6
  exposure += openFilesNearKing.length * 10
  if (castledSide === 'center') exposure += 12
  exposure = Math.max(0, Math.min(100, exposure))

  return {
    color,
    square,
    castledSide,
    shieldPawns,
    attackers: attackerSet.size,
    defenders: defenderSet.size,
    openFilesNearKing,
    weakSquares,
    exposure,
  }
}

function outposts(board: BoardMap): OutpostInfo[] {
  const out: OutpostInfo[] = []
  const enemyPawnFiles = (color: Color) => {
    const map = new Map<number, number[]>()
    for (const p of piecesOf(board, opposite(color))) {
      if (p.type !== 'p') continue
      const f = fileIndex(p.square)
      if (!map.has(f)) map.set(f, [])
      map.get(f)!.push(rankIndex(p.square))
    }
    return map
  }
  for (const color of ['w', 'b'] as Color[]) {
    const dir = color === 'w' ? 1 : -1
    const enemyPawns = enemyPawnFiles(color)
    const ranks = color === 'w' ? [3, 4, 5] : [4, 3, 2]
    for (let f = 0; f < 8; f++) {
      for (const r of ranks) {
        const sq = makeSquare(f, r)
        // cannot be attacked by an enemy pawn: no enemy pawn on adjacent files ahead
        let safe = true
        for (const af of [f - 1, f + 1]) {
          for (const er of enemyPawns.get(af) ?? []) {
            if (color === 'w' ? er > r : er < r) safe = false
          }
        }
        if (!safe) continue
        // pawn support from behind
        let pawnSupported = false
        for (const af of [f - 1, f + 1]) {
          const sp = onBoard(af, r - dir) ? board.get(makeSquare(af, r - dir)) : undefined
          if (sp && sp.type === 'p' && sp.color === color) pawnSupported = true
        }
        const occ = board.get(sq)
        const occupiedByKnight = !!occ && occ.type === 'n' && occ.color === color
        // only surface meaningful outposts (supported or already occupied by a knight)
        if (!pawnSupported && !occupiedByKnight) continue
        out.push({ square: sq, color, pawnSupported, occupiedByKnight })
      }
    }
  }
  return out
}

const cache = new Map<string, PositionInfo>()

export function analyzePosition(fen: string): PositionInfo {
  const cached = cache.get(fen)
  if (cached) return cached

  const chess = new Chess()
  chess.load(fen, { skipValidation: true })
  const board = boardMapFromArray(chess.board() as any)
  const files = fileInfo(board)

  const wBishops = bishopInfo(board, 'w')
  const bBishops = bishopInfo(board, 'b')
  const oppositeColoredBishops =
    wBishops.length === 1 &&
    bBishops.length === 1 &&
    wBishops[0].squareColor !== bBishops[0].squareColor

  const info: PositionInfo = {
    fen,
    turn: chess.turn() as Color,
    material: material(board, 'w'),
    activity: activity(board),
    pawns: { w: pawnStructure(board, 'w'), b: pawnStructure(board, 'b') },
    files,
    center: centerInfo(board),
    space: { white: spaceFor(board, 'w'), black: spaceFor(board, 'b') },
    king: { w: kingZone(chess, board, 'w', files), b: kingZone(chess, board, 'b', files) },
    bishops: { w: wBishops, b: bBishops },
    outposts: outposts(board),
    oppositeColoredBishops,
    queensOff: ![...board.values()].some((p) => p.type === 'q'),
  }
  if (cache.size > 4000) cache.clear()
  cache.set(fen, info)
  return info
}

/** Material points from a given colour's perspective (positive = ahead). */
export function materialFor(info: PositionInfo, color: Color): number {
  return color === 'w' ? info.material.diff : -info.material.diff
}
