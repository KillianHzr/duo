/** TCP (WebSocket) and UDP (discovery) port of a Duo server on the local network. */
export const DUO_PORT = 47800
export const DISCOVERY_REQUEST = 'DUO_DISCOVER_V1'
/** Bumped whenever client and server stop being compatible. */
export const PROTOCOL_VERSION = 1

export const CODE_LENGTH = 6
/** No 0/O/1/I so a code can be read out loud without ambiguity. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export interface DiscoveryReply {
  service: 'duo'
  port: number
  host: string
}

export interface PeerInfo {
  id: string
  name: string
  muted: boolean
  deafened: boolean
}

/** WebRTC payload relayed untouched between two clients. */
export type SignalData =
  | { kind: 'description'; description: { type: 'offer' | 'answer'; sdp: string } }
  | { kind: 'candidate'; candidate: Record<string, unknown> | null }

export const MAX_TEXT_LENGTH = 4000
export const MAX_NOTE_LENGTH = 20_000
export const MAX_TITLE_LENGTH = 200
export const MAX_FILES_PER_MESSAGE = 10
export const HISTORY_PAGE = 50
export const NOTE_COLORS = 6

/** A file kept by the host, fetched over HTTP at /media/<id>. */
export interface FileRef {
  id: string
  name: string
  size: number
  mime: string
  /** Id of a small preview image, for photos. */
  thumb?: string
  /** Pixel size of a photo, so the chat can reserve its place before it loads. */
  width?: number
  height?: number
}

export interface ChatMessage {
  id: string
  /** Milliseconds since 1970, on the host's clock. */
  at: number
  from: string
  text: string
  files: FileRef[]
}

export interface Note {
  id: string
  title: string
  text: string
  /** Index into the note colour palette. */
  color: number
  pinned: boolean
  updatedAt: number
  updatedBy: string
}

export type NoteDraft = Pick<Note, 'id' | 'title' | 'text' | 'color' | 'pinned'>

export type ClientMessage =
  | { type: 'hello'; name: string; code: string; protocol: number }
  | { type: 'signal'; to: string; data: SignalData }
  | { type: 'state'; muted: boolean; deafened: boolean }
  | { type: 'chat-send'; text: string; files: string[] }
  | { type: 'chat-delete'; id: string }
  /** Asks for the page of messages older than `before` (or the latest page). */
  | { type: 'chat-history'; before?: string }
  | { type: 'note-save'; note: NoteDraft }
  | { type: 'note-delete'; id: string }

export type RejectReason = 'bad-code' | 'rate-limited' | 'version'

export type ServerMessage =
  /** `token` authorizes this client's HTTP requests for media, while it stays connected. */
  | { type: 'welcome'; id: string; peers: PeerInfo[]; token?: string }
  | { type: 'rejected'; reason: RejectReason }
  | { type: 'peer-joined'; peer: PeerInfo }
  | { type: 'peer-left'; id: string }
  | { type: 'peer-state'; id: string; muted: boolean; deafened: boolean }
  | { type: 'signal'; from: string; data: SignalData }
  | { type: 'chat-message'; message: ChatMessage }
  | { type: 'chat-deleted'; id: string }
  | { type: 'chat-history'; messages: ChatMessage[]; more: boolean; before?: string }
  | { type: 'notes'; notes: Note[] }
  | { type: 'note-saved'; note: Note }
  | { type: 'note-deleted'; id: string }
