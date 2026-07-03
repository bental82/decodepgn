import type { ReactNode } from 'react'
import { RULES, RULES_BY_ID } from '../shared/rules'

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

// Rule citations inside prose: by number ("#42", "rule 42", "Rule #42") or by
// name ("fight for the center") when no number is given.
const RULE_REF = new RegExp(
  `(?:rules?\\s*)?#(\\d{1,3})|\\brules?\\s+(\\d{1,3})\\b|\\b(${titleAlts.join('|')})\\b`,
  'gi',
)

/**
 * Renders analysis prose with rule citations turned into links that open the
 * rule popup. Numbers that don't match a real rule id stay plain text.
 */
export default function RuleText({
  text,
  onOpenRule,
}: {
  text: string
  onOpenRule: (id: number) => void
}) {
  const nodes: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(RULE_REF)) {
    const id =
      m[1] !== undefined || m[2] !== undefined
        ? Number(m[1] ?? m[2])
        : (TITLE_TO_ID.get(normTitle(m[3])) ?? 0)
    const rule = RULES_BY_ID[id]
    if (!rule) continue
    const start = m.index ?? 0
    if (start < last) continue // overlaps a link we already emitted
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
  }
  if (last === 0) return <>{text}</>
  if (last < text.length) nodes.push(text.slice(last))
  return <>{nodes}</>
}
