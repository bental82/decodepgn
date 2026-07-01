import { useRef, useState } from 'react'
import type { Color } from '../engine/types'

interface Props {
  onAnalyze: (pgn: string, color: Color) => void
  error?: string
  busy?: boolean
}

const SAMPLE_PGN = `[Event "Immortal Game"]
[Site "London"]
[Date "1851.06.21"]
[White "Anderssen, Adolf"]
[Black "Kieseritzky, Lionel"]
[Result "1-0"]

1. e4 e5 2. f4 exf4 3. Bc4 Qh4+ 4. Kf1 b5 5. Bxb5 Nf6 6. Nf3 Qh6 7. d3 Nh5
8. Nh4 Qg5 9. Nf5 c6 10. g4 Nf6 11. Rg1 cxb5 12. h4 Qg6 13. h5 Qg5 14. Qf3 Ng8
15. Bxf4 Qf6 16. Nc3 Bc5 17. Nd5 Qxb2 18. Bd6 Bxg1 19. e5 Qxa1+ 20. Ke2 Na6
21. Nxg7+ Kd8 22. Qf6+ Nxf6 23. Be7# 1-0`

export default function PgnInput({ onAnalyze, error, busy }: Props) {
  const [pgn, setPgn] = useState('')
  const [color, setColor] = useState<Color>('w')
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setPgn(String(reader.result ?? ''))
    reader.readAsText(file)
  }

  return (
    <div className="pgn-input card">
      <h2>1. Paste or upload a PGN</h2>
      <textarea
        value={pgn}
        onChange={(e) => setPgn(e.target.value)}
        placeholder="Paste PGN here…"
        spellCheck={false}
        rows={10}
      />
      <div className="pgn-actions">
        <button className="btn ghost" onClick={() => fileRef.current?.click()}>
          Upload .pgn
        </button>
        <input ref={fileRef} type="file" accept=".pgn,text/plain" hidden onChange={handleFile} />
        <button className="btn ghost" onClick={() => setPgn(SAMPLE_PGN)}>
          Load example game
        </button>
      </div>

      <h2>2. Which side do you want to learn from?</h2>
      <div className="color-select">
        <label className={color === 'w' ? 'active' : ''}>
          <input type="radio" name="color" checked={color === 'w'} onChange={() => setColor('w')} />
          Analyse White’s decisions
        </label>
        <label className={color === 'b' ? 'active' : ''}>
          <input type="radio" name="color" checked={color === 'b'} onChange={() => setColor('b')} />
          Analyse Black’s decisions
        </label>
      </div>

      {error && <div className="error">{error}</div>}

      <button className="btn primary big" disabled={busy || !pgn.trim()} onClick={() => onAnalyze(pgn, color)}>
        {busy ? 'Analysing…' : '3. Analyse the game'}
      </button>
      <p className="muted small">
        Everything runs in your browser. The strategic coaching comes from a deterministic rule engine (27
        club-level principles); the chess engine is an optional cross-check you can switch on later.
      </p>
    </div>
  )
}
