import type { ChatMessage, ClientMessage, FileRef, Note, NoteDraft, ServerMessage } from '../../shared/protocol'
import { MAX_FILES_PER_MESSAGE } from '../../shared/protocol'

/** What the chat and the notes need from the voice connection they share. */
export interface SpaceLink {
  send(message: ClientMessage): void
  /** HTTP address of the host, e.g. http://192.168.1.16:47800. */
  httpBase(): string
}

export interface UploadView {
  id: number
  name: string
  /** 0 to 1. */
  progress: number
  failed: boolean
}

export interface SpaceSnapshot {
  /** True when connected to a host that keeps messages and notes. */
  available: boolean
  messages: ChatMessage[]
  /** True when older messages can still be loaded. */
  more: boolean
  loadingOlder: boolean
  notes: Note[]
  /** Messages received while the chat was not on screen. */
  unread: number
  uploads: UploadView[]
}

const DISPLAYABLE_IMAGE = /^image\/(png|jpeg|gif|webp|avif|bmp)$/
const THUMB_MAX_PIXELS = 640
/** Photos lighter than this are shown as they are, without a separate preview. */
const THUMB_MIN_BYTES = 200 * 1024

export const isImage = (file: FileRef): boolean => DISPLAYABLE_IMAGE.test(file.mime)
export const isVideo = (file: FileRef): boolean => file.mime.startsWith('video/')
export const isAudio = (file: FileRef): boolean => file.mime.startsWith('audio/')

/** Pinned notes first, then the most recently changed. */
const sortNotes = (notes: Note[]): Note[] =>
  [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)

async function makePreview(file: File): Promise<{ blob: Blob | null; width: number; height: number } | null> {
  if (!DISPLAYABLE_IMAGE.test(file.type)) return null
  try {
    const bitmap = await createImageBitmap(file)
    const { width, height } = bitmap
    const scale = Math.min(1, THUMB_MAX_PIXELS / Math.max(width, height))
    let blob: Blob | null = null
    // Animated images keep moving only if the original is shown, so they get no preview.
    if (file.size > THUMB_MIN_BYTES && file.type !== 'image/gif') {
      const canvas = new OffscreenCanvas(Math.round(width * scale), Math.round(height * scale))
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
    }
    bitmap.close()
    return { blob, width, height }
  } catch {
    return null
  }
}

export class Space {
  private listeners = new Set<() => void>()
  private snapshot: SpaceSnapshot
  private token: string | null = null
  private messages: ChatMessage[] = []
  private more = false
  private loadingOlder = false
  private notes = new Map<string, Note>()
  private unread = 0
  private uploads: UploadView[] = []
  private nextUpload = 1
  private chatVisible = false

  constructor(private link: SpaceLink) {
    this.snapshot = this.build()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): SpaceSnapshot => this.snapshot

  private build(): SpaceSnapshot {
    return {
      available: this.token !== null,
      messages: this.messages,
      more: this.more,
      loadingOlder: this.loadingOlder,
      notes: sortNotes([...this.notes.values()]),
      unread: this.unread,
      uploads: this.uploads
    }
  }

  private emit(): void {
    this.snapshot = this.build()
    for (const listener of this.listeners) listener()
  }

  // ----- Fed by the voice connection -----

  handle(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome':
        this.token = message.token ?? null
        break
      case 'chat-history':
        if (message.before) {
          const known = new Set(this.messages.map((m) => m.id))
          this.messages = [...message.messages.filter((m) => !known.has(m.id)), ...this.messages]
          this.loadingOlder = false
        } else {
          this.messages = message.messages
        }
        this.more = message.more
        break
      case 'chat-message':
        if (this.messages.some((m) => m.id === message.message.id)) return
        this.messages = [...this.messages, message.message]
        if (!this.chatVisible || document.visibilityState !== 'visible') this.unread++
        break
      case 'chat-deleted':
        this.messages = this.messages.filter((m) => m.id !== message.id)
        break
      case 'notes':
        this.notes = new Map(message.notes.map((note) => [note.id, note]))
        break
      case 'note-saved':
        this.notes.set(message.note.id, message.note)
        break
      case 'note-deleted':
        this.notes.delete(message.id)
        break
      default:
        return
    }
    this.emit()
  }

  disconnected(): void {
    if (this.token === null) return
    this.token = null
    this.loadingOlder = false
    this.emit()
  }

  // ----- Chat -----

  /** Tells whether the chat is on screen, which is what clears the unread count. */
  setChatVisible(visible: boolean): void {
    this.chatVisible = visible
    if (visible && this.unread) {
      this.unread = 0
      this.emit()
    }
  }

  mediaUrl(id: string, download = false): string {
    return `${this.link.httpBase()}/media/${id}?t=${this.token ?? ''}${download ? '&dl=1' : ''}`
  }

  loadOlder(): void {
    if (this.loadingOlder || !this.more || !this.messages.length) return
    this.loadingOlder = true
    this.link.send({ type: 'chat-history', before: this.messages[0].id })
    this.emit()
  }

  deleteMessage(id: string): void {
    this.link.send({ type: 'chat-delete', id })
  }

  /** Uploads the files to the host, then posts the message. Returns false if a file failed. */
  async sendMessage(text: string, files: File[]): Promise<boolean> {
    const ids: string[] = []
    let ok = true
    for (const file of files.slice(0, MAX_FILES_PER_MESSAGE)) {
      const view: UploadView = { id: this.nextUpload++, name: file.name, progress: 0, failed: false }
      this.uploads = [...this.uploads, view]
      this.emit()
      const update = (patch: Partial<UploadView>): void => {
        this.uploads = this.uploads.map((u) => (u.id === view.id ? { ...u, ...patch } : u))
        this.emit()
      }
      try {
        const preview = await makePreview(file)
        const params = new URLSearchParams({ name: file.name, type: file.type })
        if (preview) {
          params.set('w', String(preview.width))
          params.set('h', String(preview.height))
          if (preview.blob) {
            const thumb = await this.upload(preview.blob, new URLSearchParams({ name: 'preview.jpg', type: 'image/jpeg' }))
            params.set('thumb', thumb.id)
          }
        }
        ids.push((await this.upload(file, params, (progress) => update({ progress }))).id)
        this.uploads = this.uploads.filter((u) => u.id !== view.id)
        this.emit()
      } catch {
        ok = false
        update({ failed: true })
      }
    }
    if (text.trim() || ids.length) this.link.send({ type: 'chat-send', text, files: ids })
    return ok
  }

  dismissUpload(id: number): void {
    this.uploads = this.uploads.filter((u) => u.id !== id)
    this.emit()
  }

  private upload(body: Blob, params: URLSearchParams, onProgress?: (progress: number) => void): Promise<FileRef> {
    return new Promise((resolve, reject) => {
      if (this.token === null) return reject(new Error('not connected'))
      params.set('t', this.token)
      const request = new XMLHttpRequest()
      request.open('POST', `${this.link.httpBase()}/media?${params.toString()}`)
      request.responseType = 'json'
      request.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total)
      }
      request.onload = () => {
        if (request.status === 200 && request.response?.id) resolve(request.response as FileRef)
        else reject(new Error(`upload refused (${request.status})`))
      }
      request.onerror = () => reject(new Error('upload interrupted'))
      request.send(body)
    })
  }

  // ----- Notes -----

  /** Applies the change here at once and sends it; the host's answer then replaces it. */
  saveNote(draft: NoteDraft, by: string): void {
    this.notes.set(draft.id, { ...draft, updatedAt: Date.now(), updatedBy: by })
    this.link.send({ type: 'note-save', note: draft })
    this.emit()
  }

  deleteNote(id: string): void {
    this.notes.delete(id)
    this.link.send({ type: 'note-delete', id })
    this.emit()
  }
}
