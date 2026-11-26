/**
 * The look of the app: a colour that tints the surfaces (neutral by default) and a light or dark mode.
 * Both are kept on this computer and set on <html>, where styles.css picks them up.
 */
export const THEMES = ['neutral', 'bordeaux', 'sapin', 'ocean'] as const
export const MODES = ['dark', 'light', 'system'] as const
export type Theme = (typeof THEMES)[number]
export type Mode = (typeof MODES)[number]

/** The swatch shown for each colour in the settings: its dark and its light background. */
export const SWATCHES: Record<Theme, [string, string]> = {
  neutral: ['#2c2d32', '#ecece8'],
  bordeaux: ['#3a2329', '#f3e9e5'],
  sapin: ['#22312a', '#e6eee9'],
  ocean: ['#212a38', '#e7edf5']
}

const THEME_KEY = 'duo.theme'
const MODE_KEY = 'duo.mode'
const dark = window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<() => void>()

const read = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
  const value = localStorage.getItem(key) as T | null
  return value && allowed.includes(value) ? value : fallback
}

let current = { theme: read(THEME_KEY, THEMES, 'neutral'), mode: read(MODE_KEY, MODES, 'dark') }

function apply(): void {
  const root = document.documentElement
  const light = current.mode === 'light' || (current.mode === 'system' && !dark.matches)
  if (current.theme === 'neutral') delete root.dataset.theme
  else root.dataset.theme = current.theme
  if (light) root.dataset.mode = 'light'
  else delete root.dataset.mode
  // The window behind the page and its system buttons follow, so nothing flashes in the old colours.
  const style = getComputedStyle(root)
  const hex = (name: string): string => style.getPropertyValue(name).trim()
  window.duo?.setWindowColors?.(hex('--bg-0'), hex('--muted'))
}

export function getAppearance(): { theme: Theme; mode: Mode } {
  return current
}

export function setAppearance(patch: Partial<{ theme: Theme; mode: Mode }>): void {
  current = { ...current, ...patch }
  localStorage.setItem(THEME_KEY, current.theme)
  localStorage.setItem(MODE_KEY, current.mode)
  apply()
  for (const listener of listeners) listener()
}

export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

dark.addEventListener('change', () => {
  if (current.mode === 'system') apply()
})
apply()
