// The consolidated list of chess "rules of thumb".
// This single source is used both to render the readable reference in the UI and
// to give Claude the rule set to reason against. Ids are stable, contiguous from
// 1; RULE_COUNT (below) is the single source of truth for the total.

export interface Rule {
  id: number
  category: string
  title: string
  detail: string
}

export const CATEGORIES = [
  'Trading rules',
  'Bishop, knight, and endgame rules',
  'Rooks, files, and activity',
  'Center, pawn breaks, and tension',
  'Weaknesses and planning',
  'King safety and attacking rules',
  'Endgame-transition rules',
  'Opening and development',
  'Positional play and weaknesses',
  'Endgame technique',
] as const

export const RULES: Rule[] = [
  // Trading rules
  {
    id: 1,
    category: 'Trading rules',
    title: 'Do not trade automatically just because material is equal.',
    detail:
      'A good trade makes your remaining position better or easier to play. Before trading, ask: who is happier after this trade?',
  },
  {
    id: 2,
    category: 'Trading rules',
    title: 'Trade your bad pieces for your opponent’s good pieces.',
    detail:
      'Good: your passive knight for their active bishop. Bad: your active bishop for their undeveloped knight. Ask: am I trading my good piece for their bad piece?',
  },
  {
    id: 3,
    category: 'Trading rules',
    title: 'When ahead in material, trade pieces.',
    detail:
      'Up material, piece trades reduce counterplay and bring you closer to a winning endgame. But usually trade pieces, not necessarily pawns — you still need pawns to win.',
  },
  {
    id: 4,
    category: 'Trading rules',
    title: 'When behind in material, avoid unnecessary piece trades.',
    detail:
      'Down material, trades usually help the opponent simplify. When behind you often want complications, attacking chances, tactical opportunities, pawn breaks, and activity.',
  },
  {
    id: 5,
    category: 'Trading rules',
    title: 'Do not trade away attacking pieces without a concrete reason.',
    detail:
      'If you are attacking the king, do not casually exchange your attackers. Good reason: you remove a key defender. Bad reason: you reduce your own attacking force.',
  },
  {
    id: 6,
    category: 'Trading rules',
    title: 'Trade to remove defenders.',
    detail:
      'A trade can be excellent if the opponent’s piece defends the king, a weak square, a key pawn, a mating square, or an escape square. Ask: what job is that piece doing?',
  },
  {
    id: 7,
    category: 'Trading rules',
    title: 'Look at the pawn structure after recaptures.',
    detail:
      'Ask: after they recapture, what changes? Good: you give them doubled/isolated/backward pawns, create a passed pawn, open a useful file, or weaken their king. Bad: you damage your own structure, open lines toward your own king, fix their weaknesses, or activate their passive piece.',
  },
  {
    id: 8,
    category: 'Trading rules',
    title: 'The cramped side wants trades.',
    detail:
      'If cramped, trades give your pieces breathing room. If you have more space, avoid unnecessary trades because they help the cramped side. Less space = welcome trades; more space = keep useful pieces.',
  },

  // Bishop, knight, and endgame rules
  {
    id: 9,
    category: 'Bishop, knight, and endgame rules',
    title: 'Opposite-colored bishops favor the attacker in the middlegame.',
    detail:
      'With opposite-colored bishops and queens/rooks still on, the attacker can be very dangerous — your bishop attacks squares their bishop cannot defend.',
  },
  {
    id: 10,
    category: 'Bishop, knight, and endgame rules',
    title: 'Opposite-colored bishops favor the defender in the endgame.',
    detail:
      'If only opposite-colored bishops remain, the position is often drawish even a pawn up — the defender blockades on squares your bishop cannot control.',
  },
  {
    id: 11,
    category: 'Bishop, knight, and endgame rules',
    title: 'A bad bishop is blocked by its own pawns.',
    detail:
      'If your pawns are mostly on one color, your bishop of that color may be bad. Solve it by trading the bishop, moving pawns off its color, rerouting it, or opening the position.',
  },
  {
    id: 12,
    category: 'Bishop, knight, and endgame rules',
    title: 'Knights love outposts.',
    detail:
      'An outpost is an advanced square where your knight is protected, cannot easily be attacked by enemy pawns, and sits near the center or enemy camp. A knight on a strong outpost can be worth more than a bishop.',
  },
  {
    id: 13,
    category: 'Bishop, knight, and endgame rules',
    title: 'Bishops like open positions; knights like closed positions.',
    detail:
      'Open center and long diagonals favor bishops; a locked center and blocked pawn chains favor knights. Before trading bishop for knight, ask: is this position open or closed?',
  },

  // Rooks, files, and activity
  {
    id: 14,
    category: 'Rooks, files, and activity',
    title: 'Rooks belong on open or semi-open files.',
    detail:
      'Open file = no pawns; semi-open = only the opponent has a pawn there. Rooks should attack something: weak pawns, open files, the seventh rank, king lines, backward pawns.',
  },
  {
    id: 15,
    category: 'Rooks, files, and activity',
    title: 'Improve your worst piece.',
    detail:
      'When you do not know what to do, find your least useful piece and improve it. Ask: which of my pieces is doing the least? One of the best practical middlegame rules.',
  },
  {
    id: 16,
    category: 'Rooks, files, and activity',
    title: 'Do not grab pawns if your development or king safety suffers.',
    detail:
      'A pawn is not free if taking it gives the opponent development, initiative, open lines, an attack, or tempo against your queen. Ask: after I take the pawn, what does my opponent get?',
  },
  {
    id: 17,
    category: 'Rooks, files, and activity',
    title: 'The queen is powerful, but not a developer.',
    detail:
      'Early queen moves are often punished by tempo-gaining attacks. Develop minor pieces first unless the queen move has a concrete purpose (a real threat, supporting a break, winning material, joining an attack, connecting rooks, exploiting a tactic).',
  },

  // Center, pawn breaks, and tension
  {
    id: 18,
    category: 'Center, pawn breaks, and tension',
    title: 'A pawn break challenges the opponent’s pawn structure.',
    detail:
      'A pawn break is a pawn move that attacks an enemy pawn and tries to change the structure — e.g. e4/c4 vs a black d5 pawn, b4-b5 vs c6, ...c5 or ...e5 vs White’s d4 center. It says: I am attacking the base or support of your pawn chain.',
  },
  {
    id: 19,
    category: 'Center, pawn breaks, and tension',
    title: 'Identify pawn breaks by looking at pawn structure first.',
    detail:
      'Ask which enemy pawn holds their position together. If Black has c6 and d5, c6 supports d5, so White may attack it with b4-b5 or hit d5 directly with e4.',
  },
  {
    id: 20,
    category: 'Center, pawn breaks, and tension',
    title: 'Prepare pawn breaks before playing them.',
    detail:
      'A break is stronger when your pieces are ready to use the opened lines — e.g. Rfe1 then e4, or Rab1 then b4-b5. Do not open the position before your pieces are ready.',
  },
  {
    id: 21,
    category: 'Center, pawn breaks, and tension',
    title: 'Before a pawn break, ask who benefits if the position opens.',
    detail:
      'If your rooks, bishops, and queen become active, the break may be good. If the opened lines expose your own king or activate the opponent’s pieces, the break may be bad.',
  },
  {
    id: 22,
    category: 'Center, pawn breaks, and tension',
    title: 'Tension means both sides can capture, but neither has yet.',
    detail:
      'E.g. a White c4 pawn and a Black d5 pawn attacking each other is pawn tension. Keeping tension means not capturing yet.',
  },
  {
    id: 23,
    category: 'Center, pawn breaks, and tension',
    title: 'Keep tension when the threat is stronger than the capture.',
    detail:
      'The possibility of capturing can force the opponent to defend awkwardly. Capturing too early may let them fix their structure — the threat can be stronger than the execution.',
  },
  {
    id: 24,
    category: 'Center, pawn breaks, and tension',
    title: 'Release tension only when you gain something concrete.',
    detail:
      'Good reasons to capture: win material, create a weakness, open a useful file or diagonal, remove a defender, reach a better endgame, or force a tactic. Bad reasons: “I can, so I should,” nervousness, or simplifying without checking who benefits.',
  },
  {
    id: 25,
    category: 'Center, pawn breaks, and tension',
    title: 'Do not release tension if it improves the opponent’s position.',
    detail:
      'Avoid captures that activate their bad piece, fix their pawn weakness, help the cramped side, remove your own pressure, or open lines for their attack. Ask: what changes after the recapture?',
  },
  {
    id: 26,
    category: 'Center, pawn breaks, and tension',
    title: 'Do not start a flank attack before your center is safe.',
    detail:
      'If you push wing pawns while your center is unstable, the opponent may strike in the center. An attack on the wing is often answered by a strike in the center.',
  },
  {
    id: 27,
    category: 'Center, pawn breaks, and tension',
    title: 'When attacked on the wing, counter in the center.',
    detail:
      'If your opponent throws kingside pawns at you, do not only defend passively — look for central breaks like ...c5, ...e5, d4-d5, e4-e5. Opening the center can punish a premature flank attack.',
  },

  // Weaknesses and planning
  {
    id: 28,
    category: 'Weaknesses and planning',
    title: 'One weakness can often be defended. Two weaknesses are much harder.',
    detail:
      'If your opponent has one weak pawn, they may defend it. Your next goal is often to create a second target elsewhere — the principle of two weaknesses.',
  },
  {
    id: 29,
    category: 'Weaknesses and planning',
    title: 'Attack the base of the pawn chain.',
    detail:
      'In a pawn chain the front pawn is often protected; the base is usually more vulnerable. If Black has c6-d5, White may attack the base with b4-b5.',
  },
  {
    id: 30,
    category: 'Weaknesses and planning',
    title: 'Passed pawns should be pushed, but only when safe.',
    detail:
      'A passed pawn becomes stronger as it advances, but do not push if it allows a blockade, capture, counterplay, or loss of king safety or key squares. Passed pawns want to move, but not blindly.',
  },
  {
    id: 31,
    category: 'Weaknesses and planning',
    title: 'Do not make random moves. Improve something.',
    detail:
      'A move should usually improve a piece, prepare a break, increase pressure, create a threat, stop the opponent’s plan, improve king safety, trade a bad piece, occupy an outpost, control a file, or create a weakness. Ask: am I improving my position or just making a move?',
  },

  // King safety and attacking rules
  {
    id: 32,
    category: 'King safety and attacking rules',
    title: 'King safety can outweigh material.',
    detail:
      'In the middlegame an exposed king may matter more than a pawn, exchange, or even a piece. Before taking material ask: is my king safe after this? Before sacrificing ask: do I get forcing play, or am I just hoping?',
  },
  {
    id: 33,
    category: 'King safety and attacking rules',
    title: 'A sacrifice must have concrete compensation.',
    detail:
      'A sacrifice is not sound just because it looks attacking. It needs at least one of: forced mate, winning material back with interest, a decisive attack, perpetual check, a huge development lead, an exposed enemy king, removal of key defenders, or long-term positional compensation.',
  },
  {
    id: 34,
    category: 'King safety and attacking rules',
    title: 'Count attackers and defenders before sacrificing.',
    detail:
      'Before sacrificing against the king, count how many pieces attack vs defend near the king, whether defenders are pinned or can be removed, and whether your queen, rooks, knight, and bishop can join. More attackers than defenders is a good sign.',
  },
  {
    id: 35,
    category: 'King safety and attacking rules',
    title: 'Forcing moves matter most in attacks.',
    detail:
      'When calculating a sacrifice, look first at checks, then captures, then threats. A sacrifice is much stronger when the follow-up is forcing rather than hoping the opponent errs.',
  },
  {
    id: 36,
    category: 'King safety and attacking rules',
    title: 'Check whether the enemy king has escape squares.',
    detail:
      'Before sacrificing, ask: can the king run? Are escape squares covered? Can the opponent give back material to escape, decline the sacrifice, or trade queens? A sacrifice often fails if the king can simply walk away.',
  },
  {
    id: 37,
    category: 'King safety and attacking rules',
    title: 'Sacrifices are more likely to work when the enemy king cover is weakened.',
    detail:
      'Good attacking signs: moved g/h/f pawns, weak squares near the king, a missing fianchetto bishop, a pinned defender, an open file near the king, a bishop aimed at h7/h2, a queen that can reach h5/g4/a4, a knight that can jump to g5/e5/f7/h6/d6, or a rook that can join.',
  },
  {
    id: 38,
    category: 'King safety and attacking rules',
    title: 'Sacrifices are suspicious when only one piece is attacking.',
    detail:
      'One attacker with no quick reinforcements is usually hope, not calculation. Warning signs: no forcing follow-up, enough defenders, the queen far away, rooks not involved, your own king unsafe, the center can be opened against you, or the opponent can accept and consolidate.',
  },

  // Endgame-transition rules
  {
    id: 39,
    category: 'Endgame-transition rules',
    title: 'Do not trade into an endgame without checking if it is good.',
    detail:
      'Simplifying is not automatically good. Before queen trades or mass trades, ask what endgame you are entering — be careful with pawn endings, rook endings, opposite-colored bishop endings, blockaded extra pawns, and insufficient winning material.',
  },
  {
    id: 40,
    category: 'Endgame-transition rules',
    title: 'If worse, opposite-colored bishop endings can be a defensive resource.',
    detail:
      'If you are worse, trading into opposite-colored bishops may give drawing chances. If you are better, be careful — it may throw away your winning chances.',
  },

  // Opening and development
  {
    id: 41,
    category: 'Opening and development',
    title: 'Develop a new piece with most opening moves.',
    detail:
      'In the opening, getting knights and bishops into play quickly is usually worth more than pawn-grabbing or slow maneuvers. Ask: does this move bring a new piece into the game, or clearly help one come out?',
  },
  {
    id: 42,
    category: 'Opening and development',
    title: 'Fight for the center.',
    detail:
      'Occupy or control the central squares (d4, e4, d5, e5) with pawns and pieces. Central control gives your own pieces more scope and limits where the opponent’s pieces can go.',
  },
  {
    id: 43,
    category: 'Opening and development',
    title: 'Castle early — get the king safe and the rooks connected.',
    detail:
      'Tucking the king away and linking the rooks is often more valuable than an extra pawn or a slow plan while the center is still open. Ask: is my king still in the center with lines about to open?',
  },
  {
    id: 44,
    category: 'Opening and development',
    title: 'Do not move the same piece twice in the opening without a reason.',
    detail:
      'Each repeated move of one piece is a tempo not spent developing another. Good reasons: win material, meet a real threat, reach a clearly better square, or exploit a tactic.',
  },
  {
    id: 45,
    category: 'Opening and development',
    title: 'Develop knights toward the center, usually before the bishops.',
    detail:
      'Knights have clear early homes (f3/c3, f6/c6) and reach their best squares fast; bishops often need to see the pawn structure first. Developing toward the center maximizes a piece’s influence.',
  },
  {
    id: 46,
    category: 'Opening and development',
    title: 'Finish developing before you attack.',
    detail:
      'Attacks launched with pieces still on the back rank tend to run out of steam. Bring your force out and castle before committing to an assault, unless there is a concrete forced tactic.',
  },
  {
    id: 47,
    category: 'Opening and development',
    title: 'Answer a gambit by developing, not by clutching the pawn.',
    detail:
      'If offered a pawn, either return it for a good position or hold it only while you finish developing. Hanging on to material with an undeveloped position invites a strong attack.',
  },
  {
    id: 48,
    category: 'Opening and development',
    title: 'A lead in development is a reason to open the position.',
    detail:
      'When you are better developed, opening lines with a timely break or trade tends to favor your more active pieces before the opponent can catch up.',
  },

  // Positional play and weaknesses
  {
    id: 49,
    category: 'Positional play and weaknesses',
    title: 'The bishop pair is a lasting asset, especially in open positions.',
    detail:
      'Two bishops cover squares of both colors and grow stronger as the position opens. Part with one only for something concrete — a strong knight outpost, damage to their structure, or an attack.',
  },
  {
    id: 50,
    category: 'Positional play and weaknesses',
    title: 'Avoid creating unnecessary pawn weaknesses.',
    detail:
      'Isolated, doubled, and backward pawns become long-term targets and hand the opponent squares. Accept such a weakness only for real compensation: activity, open lines, the bishop pair, or a strong square.',
  },
  {
    id: 51,
    category: 'Positional play and weaknesses',
    title: 'Double rooks and seize the seventh rank.',
    detail:
      'Rooks multiply their force when doubled on an open file, and a rook (or two) on the seventh/second rank attacks pawns and boxes in the king. Ask: can I load up on the file or invade the seventh?',
  },
  {
    id: 52,
    category: 'Positional play and weaknesses',
    title: 'Play prophylaxis — stop the opponent’s plan before pushing your own.',
    detail:
      'Before improving your position, ask what your opponent wants and whether a quiet move prevents it. Taking away their break or their best piece’s square is often worth more than a direct threat.',
  },
  {
    id: 53,
    category: 'Positional play and weaknesses',
    title: 'Restrict enemy pieces, then attack them.',
    detail:
      'Take good squares away from the opponent’s pieces — especially knights — so they run out of useful moves. A permanently bad piece is like being a piece up in the part of the board that matters.',
  },
  {
    id: 54,
    category: 'Positional play and weaknesses',
    title: 'Piece activity can be worth more than a pawn.',
    detail:
      'A well-placed, coordinated piece often outweighs material. Prefer moves that increase the scope and harmony of your pieces, and think twice before winning a pawn that sidelines a piece.',
  },
  {
    id: 55,
    category: 'Positional play and weaknesses',
    title: 'Give the king luft to avoid back-rank problems.',
    detail:
      'Once your heavy pieces leave the back rank, a single quiet h/g-pawn move can prevent a back-rank mate. Make luft at the right moment — not so early that it needlessly weakens the king.',
  },

  // Endgame technique
  {
    id: 56,
    category: 'Endgame technique',
    title: 'Activate and centralize the king in the endgame.',
    detail:
      'With queens off the board the king is a fighting piece; march it toward the center and the action. A passive king is one of the most common causes of lost endgames.',
  },
  {
    id: 57,
    category: 'Endgame technique',
    title: 'Put the rook behind the passed pawn.',
    detail:
      'Behind your own passer the rook supports each advance; behind the opponent’s it gains power as the pawn moves while their rook grows passive. Ask: which passed pawn matters, and is my rook behind it?',
  },
  {
    id: 58,
    category: 'Endgame technique',
    title: 'Use the opposition in king-and-pawn endings.',
    detail:
      'When the kings stand a square apart with the opponent to move, the opposition forces their king to give ground — often the difference between promoting and being held, or holding and losing.',
  },
  {
    id: 59,
    category: 'Endgame technique',
    title: 'Create an outside passed pawn to decoy the enemy king.',
    detail:
      'A passed pawn far from the other pawns drags the defending king away from the main battle, letting your king clean up on the other wing. A distant passer is often worth more than a central one.',
  },
  {
    id: 60,
    category: 'Endgame technique',
    title: 'In rook endings, keep the rook active — even for a pawn.',
    detail:
      'Passive rook defense usually loses; an active rook that checks, attacks pawns, and cuts off the enemy king often saves or wins. Giving a pawn for genuine rook activity is frequently a good trade.',
  },
]

/** Total number of rules — keep prompt, schema, validation, and UI in sync. */
export const RULE_COUNT = RULES.length

export const RULES_BY_ID: Record<number, Rule> = Object.fromEntries(RULES.map((r) => [r.id, r]))

/** Compact numbered rule text for the model prompt. */
export function rulesForPrompt(): string {
  return RULES.map((r) => `${r.id}. [${r.category}] ${r.title} ${r.detail}`).join('\n')
}
