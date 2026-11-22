/**
 * Duo server: introduces clients to each other on the local network.
 * Audio never goes through it — it flows directly between clients over WebRTC.
 * Used both by the desktop app ("host" mode) and by the standalone CLI in /server.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream, createWriteStream } from 'node:fs'
import { rename, stat, unlink } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { createSocket } from 'node:dgram'
import { hostname } from 'node:os'
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  DISCOVERY_REQUEST,
  DUO_PORT,
  MAX_FILES_PER_MESSAGE,
  MAX_TEXT_LENGTH,
  PROTOCOL_VERSION,
  normalizeCode,
  type ClientMessage,
  type DiscoveryReply,
  type FileRef,
  type PeerInfo,
  type RejectReason,
  type ServerMessage
} from '../shared/protocol'
import { openStore, type DataStore } from './store'

const MAX_MESSAGE_BYTES = 64 * 1024
const HEARTBEAT_MS = 15_000
const HELLO_TIMEOUT_MS = 10_000
const MAX_BAD_CODES = 5
const LOCKOUT_MS = 60_000
const MAX_UPLOAD_BYTES = 4 * 1024 ** 3
/** An uploaded file that no message claimed after this long is removed. */
const PENDING_UPLOAD_MS = 60 * 60_000
/** Types a browser may display in place; anything else is only ever offered as a download. */
const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/[\w.+-]+|audio\/[\w.+-]+)$/

export interface DuoServerOptions {
  /** Access code clients must present to join. */
  code: string
  port?: number
  /** Address to listen on. Defaults to every interface; tests use 127.0.0.1. */
  host?: string
  /** Folder for chat messages, notes and media. Without it, the server only does voice. */
  dataDir?: string
  log?: (message: string) => void
}

export interface DuoServer {
  port: number
  close(): Promise<void>
}

export function generateCode(): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return code
}

/** Only private addresses are accepted: this server is not meant for the Internet. */
export function isLocalAddress(raw: string | undefined): boolean {
  if (!raw) return false
  const addr = raw.startsWith('::ffff:') ? raw.slice(7) : raw
  if (addr === '::1' || addr.startsWith('127.')) return true
  if (addr.startsWith('10.') || addr.startsWith('192.168.') || addr.startsWith('169.254.')) return true
  const m = /^172\.(\d+)\./.exec(addr)
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true
  const lower = addr.toLowerCase()
  return lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')
}

function sameCode(expected: string, received: string): boolean {
  const a = Buffer.from(normalizeCode(expected))
  const b = Buffer.from(normalizeCode(received))
  return a.length === b.length && timingSafeEqual(a, b)
}

interface Client {
  info: PeerInfo
  socket: WebSocket
  alive: boolean
  token: string
}

interface PendingUpload {
  ref: FileRef
  owner: string
  at: number
}

const cleanName = (raw: string | null): string =>
  (raw ?? '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .trim()
    .slice(0, 120) || 'file'

const cleanMime = (raw: string | null): string =>
  raw && /^[\w.+-]+\/[\w.+-]+$/.test(raw) ? raw.toLowerCase() : 'application/octet-stream'

export function startDuoServer(options: DuoServerOptions): Promise<DuoServer> {
  const port = options.port ?? DUO_PORT
  const host = options.host ?? '0.0.0.0'
  const log = options.log ?? (() => {})
  const clients = new Map<string, Client>()
  const store: DataStore | null = options.dataDir ? openStore(options.dataDir) : null
  /** HTTP access to media is granted per connected client. */
  const tokens = new Map<string, Client>()
  const pending = new Map<string, PendingUpload>()
  /** Wrong-code attempts per address, to slow down guessing. */
  const strikes = new Map<string, { count: number; until: number }>()

  const send = (socket: WebSocket, message: ServerMessage): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }
  const broadcast = (message: ServerMessage, exceptId?: string): void => {
    for (const [id, client] of clients) if (id !== exceptId) send(client.socket, message)
  }
  const reject = (socket: WebSocket, reason: RejectReason): void => {
    send(socket, { type: 'rejected', reason })
    socket.close(1008, reason)
  }

  const discardUpload = (upload: PendingUpload): void => {
    for (const id of [upload.ref.id, upload.ref.thumb]) {
      const path = id ? store?.mediaPath(id) : null
      if (path) void unlink(path).catch(() => {})
    }
  }

  async function receiveUpload(
    req: IncomingMessage,
    res: ServerResponse,
    params: URLSearchParams,
    client: Client
  ): Promise<void> {
    if (!store) return
    if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD_BYTES) {
      res.writeHead(413).end()
      return
    }
    const id = store.newMediaId()
    const path = store.mediaPath(id)!
    const temp = `${path}.part`
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_UPLOAD_BYTES) req.destroy()
    })
    try {
      await pipeline(req, createWriteStream(temp))
      await rename(temp, path)
    } catch {
      // Interrupted or too large: leave nothing behind.
      void unlink(temp).catch(() => {})
      if (!res.headersSent) res.writeHead(400)
      res.end()
      return
    }

    const ref: FileRef = { id, name: cleanName(params.get('name')), size, mime: cleanMime(params.get('type')) }
    // A photo comes with a small preview, uploaded just before it.
    const thumb = pending.get(params.get('thumb') ?? '')
    if (thumb && thumb.owner === client.info.id && thumb.ref.mime === 'image/jpeg') {
      pending.delete(thumb.ref.id)
      ref.thumb = thumb.ref.id
    }
    const width = Number(params.get('w'))
    const height = Number(params.get('h'))
    if (width > 0 && height > 0 && width < 100_000 && height < 100_000) {
      ref.width = Math.round(width)
      ref.height = Math.round(height)
    }
    pending.set(id, { ref, owner: client.info.id, at: Date.now() })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(ref))
  }

  async function serveMedia(req: IncomingMessage, res: ServerResponse, id: string, download: boolean): Promise<void> {
    const info = store?.mediaInfo(id)
    const size = info
      ? await stat(info.path).then(
          (s) => s.size,
          () => -1
        )
      : -1
    if (!info || size < 0) {
      res.writeHead(404).end()
      return
    }
    const inline = !download && INLINE_TYPES.test(info.mime)
    const headers: Record<string, string | number> = {
      'content-type': inline ? info.mime : 'application/octet-stream',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(info.name)}`,
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=3600'
    }

    // Byte ranges let a video start playing, and seek, without downloading all of it.
    let start = 0
    let end = size - 1
    let partial = false
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1])
        if (range[2]) end = Math.min(Number(range[2]), size - 1)
      } else {
        start = Math.max(0, size - Number(range[2]))
      }
      if (start > end || start >= size) {
        res.writeHead(416, { 'content-range': `bytes */${size}` }).end()
        return
      }
      partial = true
      headers['content-range'] = `bytes ${start}-${end}/${size}`
    }
    headers['content-length'] = size === 0 ? 0 : end - start + 1
    res.writeHead(partial ? 206 : 200, headers)
    if (req.method === 'HEAD' || size === 0) {
      res.end()
      return
    }
    const file = createReadStream(info.path, { start, end })
    file.on('error', () => res.destroy())
    res.on('close', () => file.destroy())
    file.pipe(res)
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ service: 'duo', protocol: PROTOCOL_VERSION }))
      return
    }
    if (!store || !url.pathname.startsWith('/media')) {
      res.writeHead(404).end()
      return
    }
    // The app's window is not served by this server, so its requests are cross-origin.
    res.setHeader('access-control-allow-origin', '*')
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type' })
      res.end()
      return
    }
    if (!isLocalAddress(req.socket.remoteAddress)) {
      res.writeHead(403).end()
      return
    }
    const client = tokens.get(url.searchParams.get('t') ?? '')
    if (!client) {
      res.writeHead(401).end()
      return
    }
    if (req.method === 'POST' && url.pathname === '/media') {
      await receiveUpload(req, res, url.searchParams, client)
    } else if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/media/')) {
      await serveMedia(req, res, url.pathname.slice('/media/'.length), url.searchParams.has('dl'))
    } else {
      res.writeHead(405).end()
    }
  }

  const http = createServer((req, res) => {
    handleHttp(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  // A large video over Wi-Fi may take longer than Node's default five minutes per request.
  http.requestTimeout = 0

  const wss = new WebSocketServer({ server: http, maxPayload: MAX_MESSAGE_BYTES })

  wss.on('connection', (socket, req) => {
    const remote = req.socket.remoteAddress ?? ''
    if (!isLocalAddress(remote)) {
      socket.close(1008, 'local network only')
      return
    }

    let client: Client | undefined
    const helloTimer = setTimeout(() => {
      if (!client) socket.terminate()
    }, HELLO_TIMEOUT_MS)

    socket.on('pong', () => {
      if (client) client.alive = true
    })

    socket.on('message', (raw) => {
      let msg: ClientMessage
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage
      } catch {
        return
      }

      if (!client) {
        if (msg.type !== 'hello') return
        if (msg.protocol !== PROTOCOL_VERSION) return reject(socket, 'version')

        const strike = strikes.get(remote)
        if (strike && strike.count >= MAX_BAD_CODES && Date.now() < strike.until) {
          return reject(socket, 'rate-limited')
        }
        if (!sameCode(options.code, String(msg.code ?? ''))) {
          const count = strike && Date.now() < strike.until ? strike.count + 1 : 1
          strikes.set(remote, { count, until: Date.now() + LOCKOUT_MS })
          log(`wrong access code from ${remote} (${count}/${MAX_BAD_CODES})`)
          return reject(socket, 'bad-code')
        }
        strikes.delete(remote)
        clearTimeout(helloTimer)

        const name = String(msg.name ?? '').trim().slice(0, 32) || 'Guest'
        const token = randomBytes(16).toString('hex')
        client = { info: { id: randomUUID(), name, muted: false, deafened: false }, socket, alive: true, token }
        send(socket, {
          type: 'welcome',
          id: client.info.id,
          peers: [...clients.values()].map((c) => c.info),
          token: store ? token : undefined
        })
        if (store) {
          tokens.set(token, client)
          send(socket, { type: 'chat-history', ...store.history() })
          send(socket, { type: 'notes', notes: store.notes() })
        }
        clients.set(client.info.id, client)
        broadcast({ type: 'peer-joined', peer: client.info }, client.info.id)
        log(`+ ${name} (${remote}) — ${clients.size} connected`)
        return
      }

      switch (msg.type) {
        case 'signal': {
          const target = clients.get(msg.to)
          if (target) send(target.socket, { type: 'signal', from: client.info.id, data: msg.data })
          break
        }
        case 'state': {
          client.info.muted = Boolean(msg.muted)
          client.info.deafened = Boolean(msg.deafened)
          broadcast(
            { type: 'peer-state', id: client.info.id, muted: client.info.muted, deafened: client.info.deafened },
            client.info.id
          )
          break
        }
        case 'chat-send': {
          if (!store) break
          const text = String(msg.text ?? '')
            .slice(0, MAX_TEXT_LENGTH)
            .trim()
          const files: FileRef[] = []
          for (const id of Array.isArray(msg.files) ? msg.files.slice(0, MAX_FILES_PER_MESSAGE) : []) {
            const upload = pending.get(String(id))
            if (!upload || upload.owner !== client.info.id) continue
            pending.delete(upload.ref.id)
            files.push(upload.ref)
          }
          if (!text && !files.length) break
          broadcast({ type: 'chat-message', message: store.addMessage(client.info.name, text, files) })
          break
        }
        case 'chat-delete': {
          if (store?.deleteMessage(String(msg.id), client.info.name)) {
            broadcast({ type: 'chat-deleted', id: String(msg.id) })
          }
          break
        }
        case 'chat-history': {
          if (!store) break
          const before = msg.before ? String(msg.before) : undefined
          send(socket, { type: 'chat-history', ...store.history(before), before })
          break
        }
        case 'note-save': {
          const note = store?.saveNote(msg.note, client.info.name)
          if (note) broadcast({ type: 'note-saved', note })
          break
        }
        case 'note-delete': {
          if (store?.deleteNote(String(msg.id))) broadcast({ type: 'note-deleted', id: String(msg.id) })
          break
        }
      }
    })

    socket.on('close', () => {
      clearTimeout(helloTimer)
      if (!client) return
      clients.delete(client.info.id)
      tokens.delete(client.token)
      broadcast({ type: 'peer-left', id: client.info.id })
      log(`- ${client.info.name} — ${clients.size} connected`)
    })

    socket.on('error', () => socket.terminate())
  })

  // Drops clients that vanished without closing (Wi-Fi loss, sleep…).
  const heartbeat = setInterval(() => {
    for (const client of clients.values()) {
      if (!client.alive) {
        client.socket.terminate()
        continue
      }
      client.alive = false
      client.socket.ping()
    }
    for (const [id, upload] of pending) {
      if (Date.now() - upload.at < PENDING_UPLOAD_MS) continue
      pending.delete(id)
      discardUpload(upload)
    }
  }, HEARTBEAT_MS)

  // Discovery: clients broadcast DISCOVERY_REQUEST over UDP, we answer with our port.
  const discovery = createSocket({ type: 'udp4', reuseAddr: true })
  discovery.on('message', (data, rinfo) => {
    if (data.toString() !== DISCOVERY_REQUEST || !isLocalAddress(rinfo.address)) return
    const reply: DiscoveryReply = { service: 'duo', port, host: hostname() }
    discovery.send(JSON.stringify(reply), rinfo.port, rinfo.address)
  })
  discovery.on('error', (err) => log(`UDP discovery unavailable: ${err.message}`))

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      clearInterval(heartbeat)
      try {
        discovery.close()
      } catch {
        /* never bound */
      }
      for (const client of clients.values()) client.socket.terminate()
      wss.close()
      http.closeAllConnections()
      const done = (): void => void (store ? store.flush() : Promise.resolve()).then(resolve)
      http.close(done)
      setTimeout(done, 500).unref()
    })

  return new Promise((resolve, reject) => {
    http.once('error', (err) => {
      clearInterval(heartbeat)
      reject(err)
    })
    http.listen(port, host, () => {
      discovery.bind(port, host)
      log(`Duo server ready on port ${port} (local network only)`)
      resolve({ port, close })
    })
  })
}
