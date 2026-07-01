import { useState } from 'react'
import type { SettingsProps } from './contract'

export default function Settings({ apiKey, hasServerKey, onSave, onClose }: SettingsProps) {
  const [value, setValue] = useState(apiKey)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Anthropic API key</h2>
          <button className="btn ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="muted small">
          Your key is stored only in this browser (localStorage) and sent to this app's own /api endpoint to call Claude.{' '}
          {hasServerKey
            ? 'This deployment may already have a key configured, so providing one here is optional.'
            : 'A key is required to analyse games.'}{' '}
          You can get one at{' '}
          <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">console.anthropic.com</a>.
        </p>
        <label>
          <input
            type="password"
            placeholder="sk-ant-…"
            aria-label="Anthropic API key"
            value={value}
            onChange={e => setValue(e.target.value)}
          />
        </label>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => onSave(value)}>Save</button>
        </div>
      </div>
    </div>
  )
}
