/**
 * What the host keeps on disk for everyone: chat messages, shared notes and media files.
 *   <dir>/messages.jsonl   one line per message sent or deleted, only ever appended to
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
  MAX_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
  NOTE_COLORS,
  type ChatMessage,
  type FileRef,
  type Note,
  type NoteDraft
} from '../shared/protocol'

const MEDIA_ID = /^[a-f0-9]{24}$/
const NOTE_ID = /^[\w-]{1,64}$/
const NOTES_SAVE_DELAY_MS = 400

type LogLine = { m: ChatMessage } | { d: string }

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
  history(before?: string): { messages: ChatMessage[]; more: boolean }
  addMessage(from: string, text: string, files: FileRef[]): ChatMessage
  /** Deletes a message and its files. Only its author may do so. */
  deleteMessage(id: string, by: string): boolean
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
    for (const line of readFileSync(logFile, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as LogLine
        if ('d' in entry) deleted.add(entry.d)
        else if (entry.m?.id) loaded.push(entry.m)
      } catch {
        /* a line cut short by a crash: skip it */
      }
    }
    for (const message of loaded) {
      if (deleted.has(message.id)) continue
      messages.push(message)
      index(message)
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

  return {
    dir,
    newMediaId: () => randomBytes(12).toString('hex'),
    mediaPath,
    mediaInfo(id) {
      const info = media.get(id)
      const path = mediaPath(id)
      return info && path ? { path, ...info } : null
    },

    history(before) {
      let end = messages.length
      if (before) {
        const at = messages.findIndex((m) => m.id === before)
        if (at >= 0) end = at
      }
      const start = Math.max(0, end - HISTORY_PAGE)
      return { messages: messages.slice(start, end), more: start > 0 }
    },

    addMessage(from, text, files) {
      const message: ChatMessage = {
        id: randomUUID(),
        at: Date.now(),
        from,
        text: text.slice(0, MAX_TEXT_LENGTH),
        files
      }
      messages.push(message)
      index(message)
      append({ m: message })
      return message
    },

    deleteMessage(id, by) {
      const at = messages.findIndex((m) => m.id === id)
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
