import { useEffect, useRef, useState } from 'react'
import type { SettingsProps } from './contract'

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

export default function Settings({ apiKey, hasServerKey, serverBuild, liteModel, theme, onTheme, onSave, onClose }: SettingsProps) {
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
            ✕
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
              🌙 Dark
            </button>
            <button
              className={'btn' + (theme === 'light' ? ' on' : '')}
              aria-pressed={theme === 'light'}
              onClick={() => onTheme('light')}
            >
              ☀️ Light
            </button>
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
              'off — set OPENROUTER_API_KEY on the server to enable it'
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
            {refreshing ? 'Updating…' : '⟳ Update app'}
          </button>
        </div>
      </div>
    </div>
  )
}
