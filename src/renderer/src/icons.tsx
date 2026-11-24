import type { ReactNode } from 'react'
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
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />
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

/** The app's own icon: Mousse, dozing. Kept in step with scripts/make-icon.mjs. */
export function AppIcon({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 100 100" aria-hidden>
      <rect width="100" height="100" rx="24" fill="#6e916d" />
      <path d="M0 24 Q0 0 24 0 H76 Q100 0 100 24 V44 Q88 29 75 42 Q63 54 50 42 Q37 30 25 42 Q12 54 0 44 Z" fill="#93b38b" />
      <path d="M23 63 A11 11 0 0 0 45 63 M55 63 A11 11 0 0 0 77 63" fill="none" stroke="#1c1d20" strokeWidth="6.5" strokeLinecap="round" />
      <g fill="#f3ead9">
        <circle cx="76" cy="12" r="6.6" />
        <circle cx="67.8" cy="18" r="6.6" />
        <circle cx="70.9" cy="27.6" r="6.6" />
        <circle cx="81.1" cy="27.6" r="6.6" />
        <circle cx="84.2" cy="18" r="6.6" />
      </g>
      <circle cx="76" cy="20.5" r="5.4" fill="#f2b866" />
    </svg>
  )
}
