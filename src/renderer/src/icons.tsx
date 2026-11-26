import { useId, type ReactNode } from 'react'
import { faceOf, hash } from './avatars'

const PATHS = {
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>
  ),
  micOff: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16" />
    </>
  ),
  headphones: (
    <>
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
      <rect x="3" y="14" width="4" height="6" rx="1.5" />
      <rect x="17" y="14" width="4" height="6" rx="1.5" />
    </>
  ),
  headphonesOff: (
    <>
      <path d="M4 14v-2a8 8 0 0 1 16 0v2M4 4l16 16" />
      <rect x="3" y="14" width="4" height="6" rx="1.5" />
      <rect x="17" y="14" width="4" height="6" rx="1.5" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M19 7h1M4 17h1M11 17h9" />
      <circle cx="16" cy="7" r="2.5" />
      <circle cx="8" cy="17" r="2.5" />
    </>
  ),
  voice: <path d="M4 10v4h3l5 4V6l-5 4zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" />,
  chat: <path d="M4 5h16v11H10l-6 4z" />,
  notes: (
    <>
      <rect x="5" y="4" width="14" height="16" rx="2" />
      <path d="M9 9h6M9 13h6" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  trash: <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />,
  send: <path d="M4 12l16-8-6 16-3-7z" />,
  pin: <path d="M12 17v4M8 4h8l-1 6 3 4H6l3-4z" />,
  download: <path d="M12 4v11M7 11l5 5 5-5M5 20h14" />,
  file: <path d="M7 3h7l4 4v14H7zM14 3v4h4" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  reply: <path d="M10 8L5 12l5 4M5 12h9a5 5 0 0 1 5 5v1" />,
  smile: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 14a4.5 4.5 0 0 0 7 0M9.5 9.5v.5M14.5 9.5v.5" />
    </>
  ),
  edit: <path d="M5 19l1-4L16 5l3 3L9 18zM14 7l3 3" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </>
  ),
  arrowDown: <path d="M12 5v14M6 13l6 6 6-6" />,
  calendar: (
    <>
      <rect x="4" y="5.5" width="16" height="14.5" rx="2.5" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
    </>
  ),
  external: <path d="M14 5h5v5M19 5l-8 8M17 14v5H5V7h5" />
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[name]}
    </svg>
  )
}

/** Someone's face: the character they picked, or the one their name gives them. */
export function Avatar({ name, pick, speaking }: { name: string; pick?: number | null; speaking?: boolean }) {
  return (
    <span className={speaking ? 'avatar speaking' : 'avatar'} aria-hidden>
      <svg viewBox="0 0 100 100" dangerouslySetInnerHTML={{ __html: faceOf(name, pick).art }} />
    </span>
  )
}

/** The colour index of someone's name in the chat. */
export const hue = (name: string): number => hash(name) % 6

/**
 * The app's own icon: the p of peinard lying on its back, leaning back. Kept in step with
 * scripts/make-icon.mjs. `small` is the heavier drawing used at 24 px and below.
 */
export function AppIcon({ className, small = false }: { className: string; small?: boolean }) {
  const id = useId()
  const w = small ? 17 : 13
  const tilt = 'rotate(12 50 54)'
  return (
    <svg className={className} viewBox="0 0 100 100" aria-hidden>
      <defs>
        <linearGradient id={`${id}fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c3304f" />
          <stop offset="1" stopColor="#7a1530" />
        </linearGradient>
        <clipPath id={`${id}disc`}>
          <circle cx="50" cy="50" r="46" />
        </clipPath>
      </defs>
      <circle cx="50" cy="50" r="46" fill={`url(#${id}fill)`} />
      <g clipPath={`url(#${id}disc)`}>
        <circle cx="50" cy="50.8" r="45.4" fill="none" stroke="#ffffff" strokeOpacity="0.18" strokeWidth="1.6" />
        <path d="M31 72 H130" transform={tilt} stroke="#ffe9d6" strokeWidth={w} strokeLinecap="round" />
      </g>
      <circle cx="48" cy={72 - 17.5 - w / 2} r="17.5" transform={tilt} fill="none" stroke="#ffe9d6" strokeWidth={w} />
    </svg>
  )
}
