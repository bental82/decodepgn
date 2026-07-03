import type { ReactNode } from 'react'
import { RULES, RULES_BY_ID } from '../shared/rules'
import { stripToolLeak } from '../shared/types'

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// case/apostrophe/whitespace-insensitive key for title lookups
const normTitle = (s: string) => s.toLowerCase().replace(/['’]/g, "'").replace(/\s+/g, ' ')

const TITLE_TO_ID = new Map<string, number>()
const titleAlts: string[] = []
for (const r of RULES) {
  const t = r.title.replace(/[.\s]+$/, '')
  TITLE_TO_ID.set(normTitle(t), r.id)
  titleAlts.push(
    escapeRe(t)
      .replace(/['’]/g, "['’]")
      .replace(/ +/g, '\\s+'),
  )
}
// longest first so "rooks belong on open or semi-open files" beats a shorter prefix
titleAlts.sort((a, b) => b.length - a.length)

// One citation often lists several rules — "rules 17, 44, 46", "rules 32 and
// 61", "#12/#13" — so a number reference is a whole LIST of numbers joined by
// commas / "and" / "&" / "/", each optionally "#"-prefixed.
const NUM_LIST = '#?\\s*\\d{1,3}(?:\\s*(?:,|and\\b|&|/)\\s*#?\\s*\\d{1,3})*'

// Rule citations inside prose: by number ("#42", "rule 42", "Rule #42",
// "rules 17, 44, 46") or by name ("fight for the center") when no number is given.
const RULE_REF = new RegExp(
  `\\brules?\\s*(?:${NUM_LIST})|#\\s*\\d{1,3}(?:\\s*(?:,|and\\b|&|/)\\s*#?\\s*\\d{1,3})*|\\b(${titleAlts.join('|')})\\b`,
  'gi',
)

/**
 * Renders analysis prose with rule citations turned into links that open the
 * rule popup. EVERY number in a citation list becomes its own link ("rules 17,
 * 44, 46" gives three), keeping the words and separators as plain text.
 * Numbers that don't match a real rule id stay plain text.
 */
export default function RuleText({
  text: rawText,
  onOpenRule,
}: {
  text: string
  onOpenRule: (id: number) => void
}) {
  // Guard at render too: analyses SAVED before the server started stripping
  // leaked tool-call syntax still display clean without re-analysing.
  const text = stripToolLeak(rawText)
  const nodes: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(RULE_REF)) {
    const start = m.index ?? 0
    if (start < last) continue // overlaps a link we already emitted
    if (m[1] !== undefined) {
      // Title citation: the whole phrase is one link.
      const id = TITLE_TO_ID.get(normTitle(m[1])) ?? 0
      const rule = RULES_BY_ID[id]
      if (!rule) continue
      if (start > last) nodes.push(text.slice(last, start))
      nodes.push(
        <button
          key={start}
          className="rule-ref"
          onClick={() => onOpenRule(id)}
          title={`#${id} — ${rule.title}`}
        >
          {m[0]}
        </button>,
      )
      last = start + m[0].length
      continue
    }
    // Number citation(s): link each number in the list individually (keeping
    // its "#" when present); the keyword and separators stay plain text.
    const chunk = m[0]
    const pieces: ReactNode[] = []
    let chunkLast = 0
    for (const n of chunk.matchAll(/#\s*(\d{1,3})|(\d{1,3})/g)) {
      const id = Number(n[1] ?? n[2])
      const rule = RULES_BY_ID[id]
      if (!rule) continue // not a real rule id — stays plain text
      const nStart = n.index ?? 0
      if (nStart > chunkLast) pieces.push(chunk.slice(chunkLast, nStart))
      pieces.push(
        <button
          key={start + nStart}
          className="rule-ref"
          onClick={() => onOpenRule(id)}
          title={`#${id} — ${rule.title}`}
        >
          {n[0]}
        </button>,
      )
      chunkLast = nStart + n[0].length
    }
    if (pieces.length === 0) continue // nothing linkable in this citation
    if (start > last) nodes.push(text.slice(last, start))
    if (chunkLast < chunk.length) pieces.push(chunk.slice(chunkLast))
    nodes.push(...pieces)
    last = start + chunk.length
  }
  if (last === 0) return <>{text}</>
  if (last < text.length) nodes.push(text.slice(last))
  return <>{nodes}</>
}
