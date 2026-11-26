/**
 * What the host keeps on disk for everyone: chat messages, shared notes and media files.
 *   <dir>/messages.jsonl   one line per message sent, changed or deleted, only ever appended to
 *   <dir>/notes.json       all notes
 *   <dir>/media/<id>       photos, videos and other files, named by a random id
 * Plain files, so the folder can be copied or backed up as it is.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { appendFile, unlink } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  HISTORY_PAGE,
  MAX_NOTE_LENGTH,
  MAX_REACTIONS,
  MAX_SEARCH_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
  NOTE_COLORS,
  REPLY_SNIPPET,
  SEARCH_LIMIT,
  type ChatMessage,
  type FileRef,
  type Note,
  type NoteDraft
} from '../shared/protocol'

const MEDIA_ID = /^[a-f0-9]{24}$/
const NOTE_ID = /^[\w-]{1,64}$/
const NOTES_SAVE_DELAY_MS = 400

/** m: a new message, u: a message as it is after a change, d: the id of a deleted message. */
type LogLine = { m: ChatMessage } | { u: ChatMessage } | { d: string }

/** One emoji (with its skin tone or joiners), nothing else: no text, no spaces. */
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})[\p{Extended_Pictographic}\p{Emoji_Component}\p{Regional_Indicator}\u200d\ufe0f\u20e3]*$/u

/** Lower case without accents, so "ete" finds "Été". */
const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

export interface HistoryPage {
  messages: ChatMessage[]
  /** Older messages exist before this page. */
  more: boolean
  /** Newer messages exist after this page. */
  newer: boolean
}

export interface MediaInfo {
  path: string
  name: string
  mime: string
}

export interface DataStore {
  dir: string
  newMediaId(): string
  /** Path of a media file, or null when the id is not a valid one. */
  mediaPath(id: string): string | null
  /** Name and type of a file that belongs to a message. */
  mediaInfo(id: string): MediaInfo | null
  history(at?: { before?: string; after?: string; around?: string; date?: number }): HistoryPage
  addMessage(from: string, text: string, files: FileRef[], replyTo?: string): ChatMessage
  /** Deletes a message and its files. Only its author may do so. */
  deleteMessage(id: string, by: string): boolean
  /** Changes the text of a message. Only its author may do so; it keeps at least a file or some text. */
  editMessage(id: string, by: string, text: string): ChatMessage | null
  /** Adds someone's emoji to a message, or takes it back. */
  react(id: string, by: string, emoji: string): ChatMessage | null
  pin(id: string, by: string, pinned: boolean): ChatMessage | null
  /** Pinned messages, the most recently pinned first. */
  pins(): ChatMessage[]
  /**
   * Messages whose text, author or file names contain every word searched, sent between from and to
   * when given, newest first.
   */
  search(query: string, from?: number, to?: number): { messages: ChatMessage[]; total: number }
  notes(): Note[]
  saveNote(draft: NoteDraft, by: string): Note | null
  deleteNote(id: string): boolean
  /** Resolves once everything is written to disk. */
  flush(): Promise<void>
}

export function openStore(dir: string): DataStore {
  const mediaDir = join(dir, 'media')
  mkdirSync(mediaDir, { recursive: true })
  const logFile = join(dir, 'messages.jsonl')
  const notesFile = join(dir, 'notes.json')

  const messages: ChatMessage[] = []
  const media = new Map<string, { name: string; mime: string }>()
  const index = (message: ChatMessage): void => {
    for (const file of message.files) {
      media.set(file.id, { name: file.name, mime: file.mime })
      if (file.thumb) media.set(file.thumb, { name: 'preview.jpg', mime: 'image/jpeg' })
    }
  }

  if (existsSync(logFile)) {
    const deleted = new Set<string>()
    const loaded: ChatMessage[] = []
    const changed = new Map<string, ChatMessage>()
    for (const line of readFileSync(logFile, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as LogLine
        if ('d' in entry) deleted.add(entry.d)
        else if ('u' in entry && entry.u?.id) changed.set(entry.u.id, entry.u)
        else if ('m' in entry && entry.m?.id) loaded.push(entry.m)
      } catch {
        /* a line cut short by a crash: skip it */
      }
    }
    for (const message of loaded) {
      if (deleted.has(message.id)) continue
      const latest = changed.get(message.id) ?? message
      messages.push(latest)
      index(latest)
    }
  }

  const notes = new Map<string, Note>()
  if (existsSync(notesFile)) {
    try {
      for (const note of JSON.parse(readFileSync(notesFile, 'utf8')) as Note[]) if (note?.id) notes.set(note.id, note)
    } catch {
      // Keep the unreadable file aside instead of overwriting it with an empty list.
      try {
        renameSync(notesFile, `${notesFile}.broken-${Date.now()}`)
      } catch {
        /* nothing more we can do */
      }
    }
  }

  // Appends are chained so lines land in the order they were produced.
  let writes: Promise<void> = Promise.resolve()
  const append = (entry: LogLine): void => {
    writes = writes.then(() => appendFile(logFile, `${JSON.stringify(entry)}\n`)).catch(() => {})
  }

  let notesTimer: NodeJS.Timeout | null = null
  const writeNotes = (): void => {
    if (notesTimer) clearTimeout(notesTimer)
    notesTimer = null
    // Written next to the file then renamed, so a crash never leaves half a file.
    const temp = `${notesFile}.tmp`
    writeFileSync(temp, JSON.stringify([...notes.values()], null, 1))
    renameSync(temp, notesFile)
  }
  const scheduleNotes = (): void => {
    notesTimer ??= setTimeout(() => {
      try {
        writeNotes()
      } catch {
        /* disk unavailable: retried at the next change */
      }
    }, NOTES_SAVE_DELAY_MS)
  }

  const mediaPath = (id: string): string | null => (MEDIA_ID.test(id) ? join(mediaDir, id) : null)

  const find = (id: string): number => {
    // Recent messages are the ones people act on: look from the end.
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].id === id) return i
    return -1
  }
  /** Replaces a message with its changed copy and writes the change down. */
  const update = (at: number, next: ChatMessage): ChatMessage => {
    messages[at] = next
    append({ u: next })
    return next
  }

  return {
    dir,
    newMediaId: () => randomBytes(12).toString('hex'),
    mediaPath,
    mediaInfo(id) {
      const info = media.get(id)
      const path = mediaPath(id)
      return info && path ? { path, ...info } : null
    },

    history(at = {}) {
      let start: number
      let end: number
      const around = at.around ? find(at.around) : -1
      const after = at.after ? find(at.after) : -1
      const before = at.before ? find(at.before) : -1
      const date = Number.isFinite(at.date) ? messages.findIndex((m) => m.at >= at.date!) : -1
      if (date >= 0) {
        // A few messages from the day before, for context, then the day asked for.
        start = Math.max(0, date - 5)
        end = Math.min(messages.length, start + HISTORY_PAGE)
      } else if (around >= 0) {
        start = Math.max(0, around - Math.floor(HISTORY_PAGE / 2))
        end = Math.min(messages.length, start + HISTORY_PAGE)
        start = Math.max(0, end - HISTORY_PAGE)
      } else if (after >= 0) {
        start = after + 1
        end = Math.min(messages.length, start + HISTORY_PAGE)
      } else {
        end = before >= 0 ? before : messages.length
        start = Math.max(0, end - HISTORY_PAGE)
      }
      return { messages: messages.slice(start, end), more: start > 0, newer: end < messages.length }
    },

    addMessage(from, text, files, replyTo) {
      const message: ChatMessage = {
        id: randomUUID(),
        at: Date.now(),
        from,
        text: text.slice(0, MAX_TEXT_LENGTH),
        files
      }
      const quoted = replyTo ? messages[find(replyTo)] : undefined
      if (quoted) {
        message.replyTo = {
          id: quoted.id,
          from: quoted.from,
          text: quoted.text.slice(0, REPLY_SNIPPET),
          files: quoted.files.length
        }
      }
      messages.push(message)
      index(message)
      append({ m: message })
      return message
    },

    deleteMessage(id, by) {
      const at = find(id)
      if (at < 0 || messages[at].from !== by) return false
      const [message] = messages.splice(at, 1)
      append({ d: id })
      for (const file of message.files) {
        for (const mediaId of [file.id, file.thumb]) {
          const path = mediaId ? mediaPath(mediaId) : null
          if (!mediaId || !path) continue
          media.delete(mediaId)
          void unlink(path).catch(() => {})
        }
      }
      return true
    },

    editMessage(id, by, raw) {
      const at = find(id)
      const message = messages[at]
      const text = String(raw ?? '').slice(0, MAX_TEXT_LENGTH).trim()
      if (!message || message.from !== by || (!text && !message.files.length) || text === message.text) return null
      return update(at, { ...message, text, editedAt: Date.now() })
    },

    react(id, by, emoji) {
      const at = find(id)
      const message = messages[at]
      if (!message || typeof emoji !== 'string' || emoji.length > 32 || !EMOJI.test(emoji)) return null
      const reactions = { ...(message.reactions ?? {}) }
      const people = reactions[emoji] ?? []
      if (people.includes(by)) {
        const left = people.filter((name) => name !== by)
        if (left.length) reactions[emoji] = left
        else delete reactions[emoji]
      } else {
        if (!reactions[emoji] && Object.keys(reactions).length >= MAX_REACTIONS) return null
        reactions[emoji] = [...people, by]
      }
      const next: ChatMessage = { ...message, reactions }
      if (!Object.keys(reactions).length) delete next.reactions
      return update(at, next)
    },

    pin(id, by, pinned) {
      const at = find(id)
      const message = messages[at]
      if (!message || Boolean(message.pinned) === Boolean(pinned)) return null
      const next: ChatMessage = { ...message }
      if (pinned) next.pinned = { by, at: Date.now() }
      else delete next.pinned
      return update(at, next)
    },

    pins: () => messages.filter((m) => m.pinned).sort((a, b) => b.pinned!.at - a.pinned!.at),

    search(query, from, to) {
      const words = fold(String(query ?? '').slice(0, MAX_SEARCH_LENGTH)).split(/\s+/).filter(Boolean)
      const start = Number.isFinite(from) ? Number(from) : -Infinity
      const end = Number.isFinite(to) ? Number(to) : Infinity
      if (!words.length && start === -Infinity && end === Infinity) return { messages: [], total: 0 }
      const found: ChatMessage[] = []
      let total = 0
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.at < start || m.at >= end) continue
        const haystack = fold([m.from, m.text, ...m.files.map((f) => f.name)].join(' '))
        if (!words.every((word) => haystack.includes(word))) continue
        total++
        if (found.length < SEARCH_LIMIT) found.push(m)
      }
      return { messages: found, total }
    },

    notes: () => [...notes.values()],

    saveNote(draft, by) {
      if (!draft || !NOTE_ID.test(String(draft.id))) return null
      const color = Number(draft.color)
      const note: Note = {
        id: draft.id,
        title: String(draft.title ?? '').slice(0, MAX_TITLE_LENGTH),
        text: String(draft.text ?? '').slice(0, MAX_NOTE_LENGTH),
        color: Number.isInteger(color) && color >= 0 && color < NOTE_COLORS ? color : 0,
        pinned: Boolean(draft.pinned),
        updatedAt: Date.now(),
        updatedBy: by
      }
      notes.set(note.id, note)
      scheduleNotes()
      return note
    },

    deleteNote(id) {
      if (!notes.delete(id)) return false
      scheduleNotes()
      return true
    },

    async flush() {
      if (notesTimer) {
        try {
          writeNotes()
        } catch {
          /* disk unavailable */
        }
      }
      await writes
    }
  }
}
