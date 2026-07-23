import { useEffect, useRef, useState } from 'react'
import type { SettingsProps } from './contract'
import Icon from './Icon'

/**
 * Force-load the newest deployed version. Home-screen (PWA-style) installs —
 * especially on iOS — keep serving a cached start page long after a deploy;
 * this clears every app cache and reloads with a cache-busting URL. Saved
 * games and the API key live in localStorage and are NOT touched.
 */
async function hardRefresh() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map((r) => r.unregister()))
    }
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    }
  } catch {
    /* best-effort — the cache-busting reload below still helps */
  }
  const u = new URL(window.location.href)
  u.searchParams.set('fresh', String(Date.now()))
  window.location.replace(u.toString())
}

// Palette picker metadata: swatch = [page bg, board dark square, accent].
// The token sets themselves live in styles.css under [data-palette='…'].
const PALETTES = [
  { id: 'classic', name: 'Classic', dots: ['#312e2b', '#739552', '#81b64c'] },
  { id: 'ocean', name: 'Ocean', dots: ['#0f141c', '#8ca2ad', '#4fb3f5'] },
  { id: 'walnut', name: 'Walnut', dots: ['#1a1713', '#a67c52', '#d9a648'] },
  { id: 'violet', name: 'Violet', dots: ['#130f1c', '#8273b3', '#a78bfa'] },
]

export default function Settings({ apiKey, hasServerKey, serverBuild, liteModel, theme, onTheme, palette, onPalette, onSave, onClose }: SettingsProps) {
  const [value, setValue] = useState(apiKey)
  const [refreshing, setRefreshing] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        // close only when the PRESS starts on the backdrop: selecting text
        // inside the dialog and releasing outside must not close it
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id="settings-title">Anthropic API key</h2>
          <button className="btn ghost" onClick={onClose} aria-label="Close">
            <Icon name="x" size={15} />
          </button>
        </div>
        <p className="muted small">
          Your key is stored only in this browser (localStorage) and sent to this app’s own /api endpoint to
          call Claude.{' '}
          {hasServerKey
            ? 'This deployment already has a key configured, so providing one here is optional.'
            : 'A key is required to analyse games.'}{' '}
          You can get one at{' '}
          <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
            console.anthropic.com
          </a>
          .
        </p>
        <label>
          <span className="sr-only">Anthropic API key</span>
          <input
            ref={inputRef}
            type="password"
            placeholder="sk-ant-…"
            aria-label="Anthropic API key"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onSave(value)}>
            Save
          </button>
        </div>
        <div className="settings-theme">
          <span className="muted small">Theme</span>
          <div className="theme-opts">
            <button
              className={'btn' + (theme === 'dark' ? ' on' : '')}
              aria-pressed={theme === 'dark'}
              onClick={() => onTheme('dark')}
            >
              <Icon name="moon" size={14} /> Dark
            </button>
            <button
              className={'btn' + (theme === 'light' ? ' on' : '')}
              aria-pressed={theme === 'light'}
              onClick={() => onTheme('light')}
            >
              <Icon name="sun" size={14} /> Light
            </button>
          </div>
        </div>
        <div className="settings-colors">
          <span className="muted small">Colors</span>
          <div className="palette-grid" role="radiogroup" aria-label="Colour palette">
            {PALETTES.map((p) => (
              <button
                key={p.id}
                className={'pal-btn' + (palette === p.id ? ' on' : '')}
                role="radio"
                aria-checked={palette === p.id}
                onClick={() => onPalette(p.id)}
              >
                <span className="pal-dots" aria-hidden="true">
                  {p.dots.map((d) => (
                    <span key={d} className="pal-dot" style={{ background: d }} />
                  ))}
                </span>
                {p.name}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-update">
          <span className="muted small">
            App version: <code>{__BUILD_ID__}</code>
            {serverBuild ? (
              <>
                {' '}
                · server: <code>{serverBuild}</code>
              </>
            ) : null}{' '}
            · opponent-move analysis:{' '}
            {liteModel ? (
              <>
                on (<code>{liteModel}</code>)
              </>
            ) : (
              'off'
            )}
            . Seeing something stale? Force-load the newest version — your saved games and key are
            kept.
          </span>
          <button
            className="btn"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true)
              void hardRefresh()
            }}
          >
            {refreshing ? (
              'Updating…'
            ) : (
              <>
                <Icon name="refresh" size={14} /> Update app
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
