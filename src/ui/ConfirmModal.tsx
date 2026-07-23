import { useEffect } from 'react'

interface Props {
  title: string
  /** body copy — may include the thing being acted on */
  body: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}

// Styled replacement for window.confirm (which blocked the UI thread and
// clashed with the app's modals). Same behaviour contract as the other
// dialogs: Escape cancels, a press that STARTS on the backdrop cancels.
export default function ConfirmModal({ title, body, confirmLabel, onConfirm, onCancel }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter') onConfirm()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, onConfirm])

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id="confirm-title">{title}</h2>
        </div>
        <p className="confirm-text">{body}</p>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button className="btn danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
