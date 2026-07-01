# DecodePGN — learn the *why* behind every move

A chess training web app that reads a PGN and, for the side you choose, explains
**which strategic “rules of thumb” apply on each move**, why they’re relevant, and
whether the move **follows, partly follows, or goes against** them — plus a plain
tactical safety check and a short human lesson.

The goal is teaching *decision-making*, not engine evaluation. The coaching comes
from a transparent, deterministic **rule engine** of 27 club-level principles.
A chess engine (Stockfish) is available only as an **optional tactical
cross-check**, never as the source of the explanations.

<p align="center"><em>Paste PGN → pick a colour → click through the moves.</em></p>

## Features

- **Paste or upload a PGN**, pick **White or Black**, and get a move list.
- Click any move to see:
  - the board **before** and **after** (oriented to your colour, move highlighted),
  - the move played and the **material balance** before/after,
  - the **relevant rules of thumb, ranked by importance**, each with a status
    (follows / partly follows / goes against / relevant-but-unclear), a
    **confidence level** (high / medium / low), and a plain-language reason,
  - a **tactical warning** if the move appears to drop material, hang a piece, or
    miss an obvious capture,
  - a short **human lesson**, candidate ideas (improve worst piece, prepare a
    break, keep tension, trade a defender, central counterplay, king safety), and
    the FENs.
- **Rule filter / search** by category or keyword.
- **Summary tab** of recurring patterns for your colour (e.g. *trades when behind,
  releases tension early, overlooks pawn breaks, queen out too early, worst piece
  left idle, unsound sacrifices, passive vs a wing attack*), with clickable
  examples that jump to the move.
- **Optional Stockfish cross-check** — a switch that adds a supporting engine eval
  and blunder swing, kept visually separate from the strategic verdict.

Everything runs client-side. No account, no server, no data leaves the browser.

## The 27 rules

| # | Rule | Category |
|---|------|----------|
| 1 | Trade bad pieces for good pieces | Trading |
| 2 | When ahead, trade pieces (keep pawns) | Trading |
| 3 | When behind, avoid piece trades | Trading |
| 4 | Keep your attacking pieces | Trading |
| 5 | Watch the pawn structure after a capture | Trading |
| 6 | Cramped side wants trades; more space avoids them | Trading |
| 7 | Before the endgame, ask if the endgame is good | Trading |
| 8 | Opposite-coloured bishops (attack vs. draw) | Bishops, knights & endgames |
| 9 | Bad bishop (blocked by your own pawns) | Bishops, knights & endgames |
| 10 | Knights love outposts | Bishops, knights & endgames |
| 11 | Bishops for open positions, knights for closed | Bishops, knights & endgames |
| 12 | Rooks belong on open / semi-open files | Rooks, files & activity |
| 13 | Improve your worst piece | Rooks, files & activity |
| 14 | Don’t grab pawns at the cost of development / king safety | Rooks, files & activity |
| 15 | The queen is not a developer | Rooks, files & activity |
| 16 | Identify your pawn breaks | Centre, breaks & tension |
| 17 | Prepare pawn breaks before playing them | Centre, breaks & tension |
| 18 | Keep tension vs release tension | Centre, breaks & tension |
| 19 | Meet a wing attack with central counterplay | Centre, breaks & tension |
| 20 | Don’t attack on the flank with an unstable centre | Centre, breaks & tension |
| 21 | Two weaknesses are better than one | Weaknesses & plans |
| 22 | Passed pawns must be pushed — safely | Weaknesses & plans |
| 23 | King safety can outweigh material | Weaknesses & plans |
| 24 | A sacrifice needs concrete compensation | Sacrifices against the king |
| 25 | Attacking sacrifice — promising signs | Sacrifices against the king |
| 26 | Hopeful sacrifice warning | Sacrifices against the king |
| 27 | How to calculate the sacrifice | Sacrifices against the king |

## How it works (and its limits)

The analysis is intentionally **heuristic and honest**. For every position it
extracts structured features — material, per-piece activity/mobility, pawn
structure (doubled / isolated / backward / passed), open & semi-open files,
centre state (open / semi-open / closed / locked), space, king safety
(shield, attackers vs defenders, open files, exposure), good/bad bishops,
opposite-coloured bishops, knight outposts, and candidate pawn breaks.

Tactics use a **static exchange evaluation (SEE)** played out with legal moves via
[chess.js](https://github.com/jhlywa/chess.js), so pins are handled correctly. That
catches *immediate* material loss and hanging pieces, and flags obviously missed
captures — but it does **not** see deep combinations or multi-move tactics. That’s
exactly what the optional engine is for.

Because chess principles are context-dependent, explanations deliberately hedge
(“may be”, “appears”, “likely”) and every finding carries a confidence level.
Treat the output as **coaching prompts**, not verdicts.

## Rule-engine format

Rules live in [`src/rules/`](src/rules) as plain data + a detector, so new
principles can be added without touching the engine or UI. Each rule has:

```ts
{
  id, title, category, description,
  positiveSignals: string[],   // what makes the move "follow" the rule
  negativeSignals: string[],   // what makes it "go against" the rule
  detect(ctx): RuleFinding | null   // status + confidence + explanation template
}
```

`ctx` (a `MoveContext`) bundles the before/after `PositionInfo`, the static
tactical read, and candidate breaks — so detectors stay short. See
[`src/engine/types.ts`](src/engine/types.ts) for the full contract and
[`src/rules/trading.ts`](src/rules/trading.ts) for worked examples.

## Project layout

```
src/
  engine/        feature extraction, SEE/tactics, pawn breaks, analyzer, summary, optional Stockfish
  rules/         the 27 rules (grouped by category) + shared detection helpers + registry
  ui/            React components (board, move list, analysis panel, filters, summary)
```

## Run locally

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build to dist/
npm run preview    # serve the production build
```

Requires Node 18+.

## Deploy to Vercel

This is a static Vite SPA — it deploys to Vercel (or Netlify/GitHub Pages) with no
special configuration.

1. Push the repo and “Import Project” in Vercel.
2. Vercel auto-detects Vite. If prompted, use **Build command** `npm run build`
   and **Output directory** `dist` (also pinned in [`vercel.json`](vercel.json)).
3. Deploy.

The optional Stockfish worker is a **single-threaded asm.js** build loaded lazily
from a CDN, so it needs **no** cross-origin isolation (COOP/COEP) headers and works
on plain static hosting. If the CDN is blocked or unavailable, the engine switch
simply reports it and the rest of the app keeps working.

## Notes

- The bundled example is Anderssen–Kieseritzky, the “Immortal Game”. Try it with
  White selected, then re-analyse with Black.
- The engine cross-check is off by default; turn it on from the top bar.
