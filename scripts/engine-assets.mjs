#!/usr/bin/env node
// Copies the full-strength Stockfish build (loader + six ~13MB wasm parts,
// ~79MB total) from the pinned `stockfish` npm package into public/engine/.
// Runs on postinstall / predev / prebuild. The copies are gitignored — the
// npm package is their source of truth, so the repo stays small and GitHub's
// 100MB file limit is never in play. The lite build stays committed as the
// fallback when these files are missing or fail to load.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dest = join(here, '..', 'public', 'engine')

let srcDir
try {
  const require = createRequire(import.meta.url)
  srcDir = join(dirname(require.resolve('stockfish/package.json')), 'src')
} catch {
  console.warn(
    '[engine-assets] stockfish package not installed — full engine unavailable (lite fallback still works)',
  )
  process.exit(0)
}

const files = readdirSync(srcDir).filter((f) => f.startsWith('stockfish-17.1-single-'))
if (files.length === 0) {
  console.warn('[engine-assets] no full-engine files found in the stockfish package')
  process.exit(0)
}

mkdirSync(dest, { recursive: true })
let copied = 0
for (const f of files) {
  const s = join(srcDir, f)
  const d = join(dest, f)
  if (existsSync(d) && statSync(d).size === statSync(s).size) continue
  copyFileSync(s, d)
  copied++
}
console.log(`[engine-assets] ${copied ? `${copied} file(s) copied` : 'up to date'} → public/engine`)
