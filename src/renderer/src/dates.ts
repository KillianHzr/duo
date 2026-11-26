/**
 * Dates typed in the chat search: "12/11", "12/11/2026", "2026-11-12", "12 novembre", "novembre 2026",
 * "hier"… Each becomes a span of time on this computer's clock, and the rest of the text stays the words searched.
 */
export interface DateSpan {
  from: number
  to: number
  /** How the span reads, to show what was understood. */
  label: string
}

const MONTHS: Record<string, number> = {
  janvier: 0, janv: 0, january: 0, jan: 0,
  fevrier: 1, fevr: 1, fev: 1, february: 1, feb: 1,
  mars: 2, march: 2, mar: 2,
  avril: 3, avr: 3, april: 3, apr: 3,
  mai: 4, may: 4,
  juin: 5, june: 5, jun: 5,
  juillet: 6, juil: 6, july: 6, jul: 6,
  aout: 7, august: 7, aug: 7,
  septembre: 8, sept: 8, sep: 8, september: 8,
  octobre: 9, oct: 9, october: 9,
  novembre: 10, nov: 10, november: 10,
  decembre: 11, dec: 11, december: 11
}
const MONTH = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|')
const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

const fullYear = (raw: string | undefined, month: number, day = 1): number => {
  if (raw) return raw.length === 2 ? 2000 + Number(raw) : Number(raw)
  // Without a year, the most recent such date: in January, "12 décembre" means last December.
  const now = new Date()
  return new Date(now.getFullYear(), month, day) > now ? now.getFullYear() - 1 : now.getFullYear()
}

const dayLabel = (d: Date): string => d.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })
const daySpan = (year: number, month: number, day: number): DateSpan | null => {
  const start = new Date(year, month, day)
  if (start.getMonth() !== month || start.getDate() !== day) return null
  return { from: start.getTime(), to: new Date(year, month, day + 1).getTime(), label: dayLabel(start) }
}
const monthSpan = (year: number, month: number): DateSpan => {
  const start = new Date(year, month, 1)
  return {
    from: start.getTime(),
    to: new Date(year, month + 1, 1).getTime(),
    label: start.toLocaleDateString([], { month: 'long', year: 'numeric' })
  }
}

interface Rule {
  pattern: RegExp
  span: (m: RegExpExecArray) => DateSpan | null
}

const RULES: Rule[] = [
  { pattern: /\b(aujourd'?hui|today)\b/, span: () => relative(0) },
  { pattern: /\b(avant-hier)\b/, span: () => relative(-2) },
  { pattern: /\b(hier|yesterday)\b/, span: () => relative(-1) },
  {
    pattern: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/,
    span: (m) => daySpan(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  },
  {
    pattern: /\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}|\d{2}))?\b/,
    span: (m) => daySpan(fullYear(m[3], Number(m[2]) - 1, Number(m[1])), Number(m[2]) - 1, Number(m[1]))
  },
  {
    pattern: new RegExp(`\\b(\\d{1,2})(?:er)?\\s+(${MONTH})\\.?(?:\\s+(\\d{4}))?\\b`),
    span: (m) => daySpan(fullYear(m[3], MONTHS[m[2]], Number(m[1])), MONTHS[m[2]], Number(m[1]))
  },
  {
    pattern: new RegExp(`\\b(${MONTH})(?:\\s+(\\d{4}))?\\b`),
    span: (m) => monthSpan(fullYear(m[2], MONTHS[m[1]]), MONTHS[m[1]])
  }
]

function relative(days: number): DateSpan {
  const now = new Date()
  return daySpan(now.getFullYear(), now.getMonth(), now.getDate() + days) ?? daySpan(now.getFullYear(), now.getMonth(), now.getDate())!
}

/** Splits a search into the date it mentions, if any, and the words left to search. */
export function readSearch(query: string): { words: string; date: DateSpan | null } {
  const text = fold(query)
  for (const rule of RULES) {
    const m = rule.pattern.exec(text)
    if (!m) continue
    const span = rule.span(m)
    if (!span) continue
    // Folding keeps the length of plain text, so the same positions cut the original.
    const words = text.length === query.length ? query.slice(0, m.index) + query.slice(m.index + m[0].length) : text.replace(m[0], '')
    return { words: words.replace(/\s+/g, ' ').trim(), date: span }
  }
  return { words: query.trim(), date: null }
}
