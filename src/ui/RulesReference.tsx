import { useEffect, useRef, useState } from 'react'
import { RULES, CATEGORIES, RULE_COUNT } from '../shared/rules'
import type { RulesReferenceProps } from './contract'
import AskBox from './AskBox'

export default function RulesReference({
  highlightId,
  usage,
  onPickRule,
  apiKey,
  onNeedKey,
}: RulesReferenceProps) {
  const [query, setQuery] = useState('')
  const hiRef = useRef<HTMLDivElement>(null)
  const catRefs = useRef<Record<string, HTMLDivElement | null>>({})

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
        aria-label={`Search the ${RULE_COUNT} rules`}
        placeholder={`Search the ${RULE_COUNT} rules…`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="rules-toc" aria-label="Jump to a category">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            className="toc-chip"
            onClick={() => catRefs.current[c]?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          >
            {c}
          </button>
        ))}
      </div>
      {CATEGORIES.map((category) => {
        const rules = filtered.filter((r) => r.category === category)
        if (rules.length === 0) return null
        return (
          <div
            key={category}
            ref={(el) => {
              catRefs.current[category] = el
            }}
            className="rule-cat-block"
          >
            <div className="rule-cat">{category}</div>
            {rules.map((r) => {
              const isHi = highlightId === r.id
              return (
                <div key={r.id}>
                  <div
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
                        <div className="rule-usage">Came up in {usage[r.id]} analysed move(s)</div>
                      ) : null}
                    </div>
                  </div>
                  {isHi ? (
                    <div className="rule-ask">
                      <AskBox
                        context={{ ruleId: r.id }}
                        apiKey={apiKey}
                        onNeedKey={onNeedKey}
                        label="Ask about this rule"
                        placeholder="e.g. when does this not apply?"
                        onOpenRule={onPickRule}
                      />
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
