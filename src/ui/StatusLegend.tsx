import type { Soundness } from '../shared/types'
import { STATUS_ORDER, soundnessMeta, statusMeta } from './contract'

const SOUNDNESS_ORDER: Soundness[] = ['sound', 'speculative', 'dubious']

// A compact "how to read this" key, shown once in the Study view. The rule
// labels are the part testers found ambiguous ("Relevant" looked positive even
// when a move broke a rule), so each state is spelled out here.
export default function StatusLegend() {
  return (
    <div className="legend" role="note" aria-label="Label key">
      <div className="legend-row">
        <span className="legend-title">Rule labels</span>
        {STATUS_ORDER.map((s) => {
          const m = statusMeta(s)
          return (
            <span className="legend-item" key={s}>
              <span className={'badge ' + m.cls}>
                {m.icon} {m.label}
              </span>
              <span className="legend-desc">{m.desc}</span>
            </span>
          )
        })}
      </div>
      <div className="legend-row">
        <span className="legend-title">Move soundness</span>
        {SOUNDNESS_ORDER.map((s) => {
          const m = soundnessMeta(s)
          return (
            <span className="legend-item" key={s}>
              <span className={'badge ' + m.cls}>
                {m.icon} {m.label}
              </span>
              <span className="legend-desc">{m.desc}</span>
            </span>
          )
        })}
      </div>
    </div>
  )
}
