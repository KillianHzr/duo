/**
 * TCP (WebSocket) and UDP (discovery) port of a server on the local network.
 * On the wire the app still answers to its first name, Duo, so older installs keep finding it.
 */
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
  /** Their built-in face: the one they picked, or the one the host drew for them. */
  avatar?: number
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
/** How many search results the host sends back at most. */
export const SEARCH_LIMIT = 50
/** Longest search someone can type. */
export const MAX_SEARCH_LENGTH = 100
/** How many different emoji a message can carry. */
export const MAX_REACTIONS = 20
/** The start of a message that a reply quotes. */
export const REPLY_SNIPPET = 140
export const NOTE_COLORS = 6
/** How many built-in faces someone can pick from. */
export const AVATAR_COUNT = 10

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

/** The message a reply answers, as it was when the reply was sent. */
export interface ReplyRef {
  id: string
  from: string
  /** The start of its text. */
  text: string
  /** How many files it carried. */
  files: number
}

export interface ChatMessage {
  id: string
  /** Milliseconds since 1970, on the host's clock. */
  at: number
  from: string
  text: string
  files: FileRef[]
  replyTo?: ReplyRef
  /** Emoji → names of the people who reacted with it, in the order they did. */
  reactions?: Record<string, string[]>
  pinned?: { by: string; at: number }
  /** When its author last changed its text. */
  editedAt?: number
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
  | { type: 'hello'; name: string; code: string; protocol: number; avatar?: number }
  | { type: 'signal'; to: string; data: SignalData }
  | { type: 'state'; muted: boolean; deafened: boolean }
  | { type: 'chat-send'; text: string; files: string[]; replyTo?: string }
  | { type: 'chat-delete'; id: string }
  /** Only the author can change the text of a message. */
  | { type: 'chat-edit'; id: string; text: string }
  /** Adds the emoji from this person, or takes it back if they had already added it. */
  | { type: 'chat-react'; id: string; emoji: string }
  | { type: 'chat-pin'; id: string; pinned: boolean }
  /**
   * Asks for a page of messages: older than `before`, newer than `after`, around `around`,
   * starting at the first message sent from `date` on (milliseconds), or the latest ones.
   */
  | { type: 'chat-history'; before?: string; after?: string; around?: string; date?: number }
  /** Words to find; `from`/`to` (milliseconds) keep only the messages sent in that span. */
  | { type: 'chat-search'; query: string; from?: number; to?: number }
  | { type: 'note-save'; note: NoteDraft }
  | { type: 'note-delete'; id: string }

export type RejectReason = 'bad-code' | 'rate-limited' | 'version'

export type ServerMessage =
  /** `token` authorizes this client's HTTP requests for media, while it stays connected. */
  | { type: 'welcome'; id: string; peers: PeerInfo[]; token?: string; avatar?: number }
  | { type: 'rejected'; reason: RejectReason }
  | { type: 'peer-joined'; peer: PeerInfo }
  | { type: 'peer-left'; id: string }
  | { type: 'peer-state'; id: string; muted: boolean; deafened: boolean }
  | { type: 'signal'; from: string; data: SignalData }
  | { type: 'chat-message'; message: ChatMessage }
  | { type: 'chat-deleted'; id: string }
  /** A message whose text, reactions or pin changed. */
  | { type: 'chat-updated'; message: ChatMessage }
  /** Every pinned message, newest pin first. */
  | { type: 'chat-pins'; messages: ChatMessage[] }
  /** `more`: older messages exist; `newer`: newer messages exist beyond this page. */
  | {
      type: 'chat-history'
      messages: ChatMessage[]
      more: boolean
      newer?: boolean
      before?: string
      after?: string
      around?: string
      date?: number
    }
  | { type: 'chat-search'; query: string; from?: number; to?: number; messages: ChatMessage[]; total: number }
  | { type: 'notes'; notes: Note[] }
  | { type: 'note-saved'; note: Note }
  | { type: 'note-deleted'; id: string }
