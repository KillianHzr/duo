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

export type ClientMessage =
  | { type: 'hello'; name: string; code: string; protocol: number }
  | { type: 'signal'; to: string; data: SignalData }
  | { type: 'state'; muted: boolean; deafened: boolean }

export type RejectReason = 'bad-code' | 'rate-limited' | 'version'

export type ServerMessage =
  | { type: 'welcome'; id: string; peers: PeerInfo[] }
  | { type: 'rejected'; reason: RejectReason }
  | { type: 'peer-joined'; peer: PeerInfo }
  | { type: 'peer-left'; id: string }
  | { type: 'peer-state'; id: string; muted: boolean; deafened: boolean }
  | { type: 'signal'; from: string; data: SignalData }
