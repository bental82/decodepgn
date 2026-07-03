import { useEffect } from 'react'
import { RULES_BY_ID } from '../shared/rules'
import AskBox from './AskBox'

interface Props {
  ruleId: number
  apiKey: string
  onNeedKey: () => void
  /** open the full searchable list, highlighting this rule */
  onOpenList: (id: number) => void
  /** rule citations inside Ask answers switch the popup to that rule */
  onOpenRule?: (id: number) => void
  onClose: () => void
}

// Popup with a single rule's full text + an Ask thread about it, so tapping a
// rule anywhere (move card, by-rule map, quiz) never loses your place.
export default function RuleModal({ ruleId, apiKey, onNeedKey, onOpenList, onOpenRule, onClose }: Props) {
  const rule = RULES_BY_ID[ruleId]

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!rule) return null

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal rule-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rule-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="rule-cat" style={{ margin: 0 }}>
            {rule.category}
          </span>
          <button className="btn ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <h2 id="rule-modal-title" className="rule-modal-title">
          <span className="rule-num">#{rule.id}</span> {rule.title}
        </h2>
        <p className="rule-modal-detail">{rule.detail}</p>
        <AskBox
          key={ruleId}
          context={{ ruleId }}
          apiKey={apiKey}
          onNeedKey={onNeedKey}
          label="Ask about this rule"
          placeholder="e.g. when does this not apply?"
          onOpenRule={onOpenRule}
        />
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => onOpenList(rule.id)}>
            Open in the full list
          </button>
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
