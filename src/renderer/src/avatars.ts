/**
 * The default faces: ten small characters you might meet around a campfire at night. They share
 * one face (two oval eyes, a tiny mouth or none), one body colour each and one telling detail.
 * Drawn on a 100×100 canvas, flat, so they stay readable at 36 px.
 */
import { AVATAR_COUNT } from '../../shared/protocol'

const INK = '#1c1d20'
const CREAM = '#f3ead9'
const DISC = '#2a2c31'

const eyes = (x1: number, x2: number, y: number, rx = 4.2, ry = 5.2): string =>
  `<ellipse cx="${x1}" cy="${y}" rx="${rx}" ry="${ry}" fill="${INK}"/><ellipse cx="${x2}" cy="${y}" rx="${rx}" ry="${ry}" fill="${INK}"/>`

const sleepyEyes = (x1: number, x2: number, y: number, r = 7): string =>
  [x1, x2].map((x) => `<path d="M${x - r} ${y} A${r} ${r} 0 0 0 ${x + r} ${y} Z" fill="${INK}"/>`).join('')

const smile = (x: number, y: number, w = 6): string =>
  `<path d="M${x - w} ${y} Q${x} ${y + 5} ${x + w} ${y}" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>`

export interface Face {
  name: string
  /** SVG markup, without the outer <svg>. */
  art: string
}

export const FACES: Face[] = [
  {
    name: 'Braise',
    art: `<path d="M50 8 C58 22 78 34 78 58 C78 76 66 88 50 88 C34 88 22 76 22 58 C22 46 28 38 34 32 C36 40 40 42 44 40 C40 28 44 16 50 8 Z" fill="#f0795a"/><path d="M50 41 C56 49 66 55 66 67 C66 77 59 84 50 84 C41 84 34 77 34 67 C34 61 37 57 40 54 C42 58 45 58 46 56 C45 50 47 45 50 41 Z" fill="#ffb27a"/>${eyes(44, 56, 66, 3.6, 4.6)}${smile(50, 74, 4)}`
  },
  {
    name: 'Caillou',
    art: `<path d="M17 66 C15 44 30 26 52 26 C72 26 86 42 84 62 C83 76 70 82 50 82 C30 82 18 78 17 66 Z" fill="#a9adb8"/><path d="M63 31 L79 47" stroke="${CREAM}" stroke-width="5" stroke-linecap="round"/>${eyes(41, 53, 56, 3.8, 4.8)}<path d="M51 67 q4 3 7 0" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>`
  },
  {
    name: 'Bûche',
    art: `<path d="M38 34 Q35 20 49 18 Q50 31 38 34 Z" fill="#8fa58c"/><rect x="11" y="33" width="78" height="42" rx="21" fill="#b9805a"/><circle cx="69" cy="54" r="16" fill="#e3bd94"/><circle cx="69" cy="54" r="7.5" fill="none" stroke="#b9805a" stroke-width="3"/>${eyes(27, 43, 52, 3.8, 4.8)}<path d="M31 63 H39" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>`
  },
  {
    name: 'Loupiote',
    art: `<path d="M44 23 Q41 12 33 12" fill="none" stroke="#6f7ea8" stroke-width="3.5" stroke-linecap="round"/><path d="M56 23 L63 14 L70 19" fill="none" stroke="#6f7ea8" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><ellipse cx="50" cy="63" rx="25" ry="23" fill="#f2b866"/><circle cx="50" cy="37" r="18" fill="#6f7ea8"/>${eyes(43, 57, 38, 3.8, 4.8)}`
  },
  {
    name: 'Hou',
    art: `<path d="M27 36 L29 15 L45 28 Z" fill="#7f8fd0" stroke="#7f8fd0" stroke-width="4" stroke-linejoin="round"/><path d="M73 36 L77 25 L57 28 Z" fill="#7f8fd0" stroke="#7f8fd0" stroke-width="4" stroke-linejoin="round"/><ellipse cx="50" cy="55" rx="29" ry="33" fill="#7f8fd0"/><ellipse cx="50" cy="69" rx="17" ry="16" fill="${CREAM}"/>${sleepyEyes(40, 60, 45)}<path d="M46 54 H54 L50 60 Z" fill="#f2b866" stroke="#f2b866" stroke-width="2" stroke-linejoin="round"/>`
  },
  {
    name: 'Chapeau',
    art: `<rect x="35" y="46" width="30" height="38" rx="13" fill="${CREAM}"/><g transform="rotate(-8 50 44)"><path d="M13 50 Q13 16 50 16 Q87 16 87 50 Q87 55 82 55 H18 Q13 55 13 50 Z" fill="#c9747f"/><circle cx="80" cy="54" r="6" fill="${DISC}"/></g>${eyes(44, 56, 66, 3.4, 4.4)}${smile(50, 74, 4)}`
  },
  {
    name: 'Mousse',
    art: `<path d="M15 78 Q15 40 50 40 Q85 40 85 78 Q85 83 80 83 H20 Q15 83 15 78 Z" fill="#8fa58c"/><path d="M17 62 Q15 37 50 35 Q85 37 83 62 Q75 53 66 60 Q58 67 50 59 Q42 52 34 60 Q25 67 17 62 Z" fill="#b7c9a8"/><path d="M62 40 V28" stroke="#6f8a6a" stroke-width="3" stroke-linecap="round"/><g fill="${CREAM}"><circle cx="62" cy="16.5" r="4.4"/><circle cx="56.8" cy="20.3" r="4.4"/><circle cx="58.8" cy="26.4" r="4.4"/><circle cx="65.2" cy="26.4" r="4.4"/><circle cx="67.2" cy="20.3" r="4.4"/></g><circle cx="62" cy="22" r="3.4" fill="#f2b866"/>${sleepyEyes(40, 60, 70, 6)}`
  },
  {
    name: 'Fanal',
    art: `<g transform="rotate(9 50 22)"><path d="M38 23 C36 5 62 5 62 23" fill="none" stroke="#e39a5c" stroke-width="4.5" stroke-linecap="round"/></g><rect x="30" y="20" width="40" height="10" rx="5" fill="#e39a5c"/><rect x="23" y="27" width="54" height="52" rx="14" fill="#e39a5c"/><rect x="30" y="34" width="40" height="38" rx="9" fill="#f6dcae"/><rect x="28" y="77" width="44" height="9" rx="4.5" fill="#c97f45"/>${eyes(43, 57, 50, 3.8, 4.8)}${smile(50, 59, 5)}`
  },
  {
    name: 'Quart',
    art: `<path d="M46 22 C41 16 51 14 46 7" fill="none" stroke="${CREAM}" stroke-width="3.5" stroke-linecap="round"/><path d="M68 45 C86 45 86 67 68 67" fill="none" stroke="#5fb3a8" stroke-width="7" stroke-linecap="round"/><rect x="23" y="33" width="46" height="46" rx="9" fill="#5fb3a8"/><rect x="21" y="28" width="50" height="10" rx="5" fill="${CREAM}"/><g fill="${CREAM}"><circle cx="30" cy="46" r="1.7"/><circle cx="62" cy="48" r="1.7"/><circle cx="59" cy="70" r="1.7"/><circle cx="31" cy="71" r="1.7"/><circle cx="46" cy="44" r="1.4"/><circle cx="46" cy="72" r="1.4"/></g>${eyes(38, 54, 56)}`
  },
  {
    name: 'Piquant',
    art: `<g fill="#9a86c9" stroke="#9a86c9" stroke-width="5" stroke-linejoin="round"><path d="M10.5 43.7 L29.6 45.3 L26.2 54.7 Z"/><path d="M23 25.8 L38.7 36.8 L31.1 43.2 Z"/><path d="M42.7 16.6 L50.8 34 L41 35.8 Z"/><path d="M64.4 18.5 L62.7 37.6 L53.3 34.2 Z"/><path d="M82.2 31 L71.2 46.7 L64.8 39.1 Z"/><path d="M91.4 50.7 L74 58.8 L72.2 49 Z"/></g><circle cx="50" cy="58" r="27" fill="#9a86c9"/><ellipse cx="45" cy="65" rx="18" ry="15" fill="${CREAM}"/><path d="M59 25 C58 13 68 8 80 9 C80 20 71 28 59 25 Z" fill="#8fa58c"/><path d="M61 23.5 L76 12" stroke="#6f8a6a" stroke-width="2" stroke-linecap="round"/>${eyes(38, 51, 62, 3.6, 4.6)}<circle cx="44.5" cy="70" r="2.6" fill="${INK}"/>`
  }
].map((face) => ({ ...face, art: `<rect width="100" height="100" fill="${DISC}"/>${face.art}` }))

/** A stable number from a name, so colours and default faces never change for someone. */
export function hash(name: string): number {
  let sum = 0
  for (const char of name) sum = (sum * 31 + char.codePointAt(0)!) >>> 0
  return sum
}

const valid = (pick: unknown): pick is number => Number.isInteger(pick) && (pick as number) >= 0 && (pick as number) < AVATAR_COUNT

/** The face someone shows: the one they picked, or one drawn from their name. */
export const faceOf = (name: string, pick?: number | null): Face => FACES[valid(pick) ? pick : hash(name) % AVATAR_COUNT]

/** The face picked on this computer, if any. */
export function chosenFace(): number | undefined {
  const saved = localStorage.getItem('duo.avatar')
  const pick = saved === null ? NaN : Number(saved)
  return valid(pick) ? pick : undefined
}
