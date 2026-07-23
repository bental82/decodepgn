// Screenshot pass for UI work: drives the built app with the analysis API
// mocked, so every view renders fully without a key. Usage:
//   npm run build && npm run preview   (in another terminal, port 4173)
//   npm run shots                       (PNGs land in /tmp/shots)
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = 'http://localhost:4173'
const OUT = '/tmp/shots'
mkdirSync(OUT, { recursive: true })

const STATUSES = ['follows', 'partially', 'violates', 'relevant']
const RULES = [3, 12, 21, 34, 47, 58, 66, 79, 88, 101]

function analyzeResult(ply) {
  const st = STATUSES[ply % STATUSES.length]
  const key = ply % 7 === 0
  return {
    ply,
    rules: [
      {
        id: RULES[ply % RULES.length],
        status: st,
        why: `Move ${ply}: the ${st} reading of the position, with enough text to wrap onto a second line for layout purposes.`,
        relevance: key ? 5 : 3,
        graphics: {
          squares: [
            { square: 'e4', color: 'green' },
            { square: 'd5', color: 'yellow' },
          ],
          arrows: [{ from: 'g1', to: 'f3', color: 'blue' }],
        },
      },
      {
        id: RULES[(ply + 3) % RULES.length],
        status: 'relevant',
        why: 'A secondary idea still in play here.',
        relevance: 2,
      },
    ],
    lesson:
      ply % 5 === 0
        ? 'The decisive lesson for this move: know which principle the position is actually asking for.'
        : '',
    soundness: ply % 6 === 0 ? 'dubious' : ply % 4 === 0 ? 'speculative' : 'sound',
    alternative:
      ply % 6 === 0 ? { move: 'Nf3', why: 'develops with tempo and keeps the centre flexible' } : null,
  }
}

async function mockApi(page) {
  await page.route('**/api/analyze', async (route) => {
    const req = route.request()
    if (req.method() === 'GET') {
      return route.fulfill({
        json: { hasServerKey: true, serverRuns: false, hasLiteKey: false, build: 'screenshot' },
      })
    }
    const body = JSON.parse(req.postData() || '{}')
    if (body.mode === 'overview') {
      return route.fulfill({
        json: {
          overview: {
            summary:
              'White seized the initiative out of the opening and never gave it back — the game was decided by superior piece activity in the middlegame.',
            trend: 'Even for twelve moves, then steadily downhill for Black after the premature pawn grab.',
            phases: 'Opening: equal. Middlegame: White’s initiative grows. Endgame: conversion.',
            keyMoments: [
              { ply: 10, title: 'The turning point', why: 'Black grabs a pawn and falls behind in development.' },
              { ply: 24, title: 'Winning break', why: 'The central break opens lines against the king.' },
            ],
          },
        },
      })
    }
    if (body.mode === 'quiz') {
      return route.fulfill({
        json: {
          explanation: {
            whyPlayed: 'The game move loses time and hands over the initiative.',
            whyBest: 'The engine move wins a pawn and keeps every piece active.',
          },
        },
      })
    }
    if (body.mode === 'ask') {
      return route.fulfill({ json: { answer: 'Because the centre is still unstable, the flank pawn grab is premature.' } })
    }
    // default: per-move analysis
    const targets = Array.isArray(body.targets) ? body.targets : []
    return route.fulfill({ json: { results: targets.map((t) => analyzeResult(t.ply)) } })
  })
  // no cloud in this deployment
  await page.route('**/api/games*', (route) => route.fulfill({ status: 404, body: '{}' }))
  // skip the ~80MB Stockfish download: without it the app proceeds engine-less,
  // so the mocked analysis lands instantly (this pass is about layout, not evals)
  await page.route('**/engine/**', (route) => route.abort())
}

async function openGame(page) {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Load example game' }).click()
  await page.getByRole('button', { name: /Analyse the game/ }).click()
  await page.waitForSelector('.study', { timeout: 15000 })
  // wait until the mocked analysis actually rendered (card + overview text)
  await page.waitForSelector('.finding', { timeout: 20000 })
  await page.waitForSelector('.overview-summary', { timeout: 20000 })
  await page.waitForTimeout(600)
}

const browser = await chromium.launch()

// 1. landing, dark, desktop
let ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
let page = await ctx.newPage()
await mockApi(page)
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.screenshot({ path: `${OUT}/01-landing-dark.png` })

// 2. study view, dark, desktop
await openGame(page)
await page.screenshot({ path: `${OUT}/02-study-dark.png`, fullPage: false })

// 3. by-rule map tab
await page.getByRole('button', { name: 'By rule' }).click()
await page.waitForTimeout(600)
await page.screenshot({ path: `${OUT}/03-map-dark.png` })

// 4. quiz tab
await page.getByRole('button', { name: 'Quiz' }).click()
await page.waitForTimeout(600)
await page.screenshot({ path: `${OUT}/04-quiz-dark.png` })
await ctx.close()

// 5. light theme: landing + study
ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
page = await ctx.newPage()
await mockApi(page)
await page.addInitScript(() => localStorage.setItem('decodepgn.theme', 'light'))
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.screenshot({ path: `${OUT}/05-landing-light.png` })
await openGame(page)
await page.screenshot({ path: `${OUT}/06-study-light.png` })
await ctx.close()

// 6. mobile, dark: landing + study
ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
})
page = await ctx.newPage()
await mockApi(page)
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.screenshot({ path: `${OUT}/07-landing-mobile.png` })
await openGame(page)
await page.screenshot({ path: `${OUT}/08-study-mobile.png` })
// scrolled into the analysis, sticky board visible
await page.evaluate(() => window.scrollTo(0, 500))
await page.waitForTimeout(400)
await page.screenshot({ path: `${OUT}/09-study-mobile-scrolled.png` })
await ctx.close()

await browser.close()
console.log('done')
