import { useEffect, useRef, useState } from 'react'
import type { Color } from '../shared/types'

interface Props {
  white: string
  black: string
  me?: Color
  onSave: (white: string, black: string, me?: Color) => void
  onClose: () => void
}

// Edit the players' display names and flag which side is the user. Names live
// in the game's headers (so they persist and sync with the analysis); the
// "me" flag feeds the cross-game meta-analysis.
export default function PlayersModal({ white, black, me, onSave, onClose }: Props) {
  const [w, setW] = useState(white)
  const [b, setB] = useState(black)
  const [mine, setMine] = useState<Color | undefined>(me)
  const firstRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    firstRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = () => onSave(w.trim() || 'White', b.trim() || 'Black', mine)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="players-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id="players-title">Players</h2>
          <button className="btn ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <label className="player-field">
          <span>White</span>
          <input
            ref={firstRef}
            value={w}
            maxLength={60}
            onChange={(e) => setW(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
          />
        </label>
        <label className="player-field">
          <span>Black</span>
          <input
            value={b}
            maxLength={60}
            onChange={(e) => setB(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
          />
        </label>
        <div className="player-me">
          <span className="player-me-label">Which one is you?</span>
          <div className="player-me-opts">
            <label>
              <input type="radio" name="me" checked={mine === 'w'} onChange={() => setMine('w')} />{' '}
              White
            </label>
            <label>
              <input type="radio" name="me" checked={mine === 'b'} onChange={() => setMine('b')} />{' '}
              Black
            </label>
            <label>
              <input
                type="radio"
                name="me"
                checked={mine === undefined}
                onChange={() => setMine(undefined)}
              />{' '}
              Not set
            </label>
          </div>
          <span className="muted small">
            Used by the cross-game analysis to know whose habits to profile.
          </span>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
