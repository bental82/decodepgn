import { useEffect, useRef, useState } from 'react'
import { RULES, CATEGORIES } from '../shared/rules'
import type { RulesReferenceProps } from './contract'

export default function RulesReference({
  highlightId,
  usage,
  onPickRule,
}: RulesReferenceProps) {
  const [query, setQuery] = useState('')
  const hiRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (highlightId !== undefined && hiRef.current) {
      hiRef.current.scrollIntoView({ block: 'nearest' })
    }
  }, [highlightId])

  const q = query.trim().toLowerCase()
  const filtered = RULES.filter((r) => {
    if (q === '') return true
    if (
      r.title.toLowerCase().includes(q) ||
      r.detail.toLowerCase().includes(q) ||
      r.category.toLowerCase().includes(q)
    ) {
      return true
    }
    return String(r.id).startsWith(q)
  })

  return (
    <div className="rules-ref">
      <input
        className="rules-search"
        type="search"
        aria-label="Search the 40 rules"
        placeholder="Search the 40 rules…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {CATEGORIES.map((category) => {
        const rules = filtered.filter((r) => r.category === category)
        if (rules.length === 0) return null
        return (
          <div key={category}>
            <div className="rule-cat">{category}</div>
            {rules.map((r) => {
              const isHi = highlightId === r.id
              return (
                <div
                  key={r.id}
                  ref={isHi ? hiRef : undefined}
                  className={'rule-item' + (isHi ? ' hi' : '')}
                  role="button"
                  tabIndex={0}
                  onClick={() => onPickRule(r.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onPickRule(r.id)
                    }
                  }}
                >
                  <span className="num">{r.id}</span>
                  <div>
                    <div className="rule-title">{r.title}</div>
                    <div className="rule-detail">{r.detail}</div>
                    {usage[r.id] ? (
                      <div className="rule-usage">
                        Came up in {usage[r.id]} analysed move(s)
                      </div>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
