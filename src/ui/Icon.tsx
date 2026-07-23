import type { CSSProperties } from 'react'

/**
 * Inline SVG icon set (lucide-style: 24×24, stroke = currentColor). Replaces
 * the old unicode glyphs (⚙ ◈ ⏮ …), which rendered inconsistently across
 * platforms and were invisible to screen-reader users scanning controls.
 * All icons are aria-hidden — the button around them carries the label.
 */
export type IconName =
  | 'gear'
  | 'cpu'
  | 'edit'
  | 'x'
  | 'chevron-down'
  | 'chevron-right'
  | 'refresh'
  | 'star'
  | 'board'
  | 'first'
  | 'prev'
  | 'next'
  | 'last'
  | 'warning'
  | 'expand'
  | 'shrink'
  | 'back'
  | 'arrow-up'
  | 'cloud'
  | 'target'
  | 'moon'
  | 'sun'
  | 'trash'
  | 'check'
  | 'pawn'
  | 'flip'

const PATHS: Record<IconName, React.ReactNode> = {
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.31.22.65.22 1a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  cpu: (
    <>
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <rect x="9.5" y="9.5" width="5" height="5" />
      <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
    </>
  ),
  edit: <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  'chevron-right': <path d="m9 6 6 6-6 6" />,
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </>
  ),
  star: <path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />,
  board: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 12h18M12 3v18" />
      <path d="M3 3h9v9H3zM12 12h9v9h-9z" fill="currentColor" stroke="none" opacity="0.35" />
    </>
  ),
  first: (
    <>
      <path d="m11 17-5-5 5-5" />
      <path d="m18 17-5-5 5-5" />
    </>
  ),
  prev: <path d="m15 18-6-6 6-6" />,
  next: <path d="m9 18 6-6-6-6" />,
  last: (
    <>
      <path d="m6 17 5-5-5-5" />
      <path d="m13 17 5-5-5-5" />
    </>
  ),
  warning: (
    <>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  expand: (
    <>
      <path d="M15 3h6v6M9 21H3v-6" />
      <path d="M21 3l-7 7M3 21l7-7" />
    </>
  ),
  shrink: (
    <>
      <path d="M4 14h6v6M20 10h-6V4" />
      <path d="M14 10l7-7M3 21l7-7" />
    </>
  ),
  back: (
    <>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" />
    </>
  ),
  'arrow-up': <path d="M12 19V5M5 12l7-7 7 7" />,
  cloud: <path d="M17.5 19a4.5 4.5 0 0 0 .42-8.98 6 6 0 0 0-11.7 1.62A4.5 4.5 0 0 0 7.5 19h10z" />,
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  moon: <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  flip: (
    <>
      <path d="M7 16V4M7 4 3 8m4-4 4 4" />
      <path d="M17 8v12m0 0 4-4m-4 4-4-4" />
    </>
  ),
  pawn: (
    <g fill="currentColor" stroke="none">
      <circle cx="12" cy="5.5" r="2.6" />
      <path d="M12 9.2c-2.1 0-3.6 2-3.6 4.4 0 1.4.55 2.5 1.4 3.4H7.3L6.2 21h11.6l-1.1-4h-2.5c.85-.9 1.4-2 1.4-3.4 0-2.4-1.5-4.4-3.6-4.4z" />
    </g>
  ),
}

interface Props {
  name: IconName
  /** px size (icons are stroke-based, so they scale cleanly); default 16 */
  size?: number
  style?: CSSProperties
}

export default function Icon({ name, size = 16, style }: Props) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={style}
    >
      {PATHS[name]}
    </svg>
  )
}
