/**
 * Duo server: introduces clients to each other on the local network.
 * Audio never goes through it — it flows directly between clients over WebRTC.
 * Used both by the desktop app ("host" mode) and by the standalone CLI in /server.
 */
import { createServer } from 'node:http'
import { createSocket } from 'node:dgram'
import { hostname } from 'node:os'
import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  DISCOVERY_REQUEST,
  DUO_PORT,
  PROTOCOL_VERSION,
  normalizeCode,
  type ClientMessage,
  type DiscoveryReply,
  type PeerInfo,
  type RejectReason,
  type ServerMessage
} from '../shared/protocol'

const MAX_MESSAGE_BYTES = 64 * 1024
const HEARTBEAT_MS = 15_000
const HELLO_TIMEOUT_MS = 10_000
const MAX_BAD_CODES = 5
const LOCKOUT_MS = 60_000

export interface DuoServerOptions {
  /** Access code clients must present to join. */
  code: string
  port?: number
  /** Address to listen on. Defaults to every interface; tests use 127.0.0.1. */
  host?: string
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
}

export function startDuoServer(options: DuoServerOptions): Promise<DuoServer> {
  const port = options.port ?? DUO_PORT
  const host = options.host ?? '0.0.0.0'
  const log = options.log ?? (() => {})
  const clients = new Map<string, Client>()
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

  const http = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ service: 'duo', protocol: PROTOCOL_VERSION }))
      return
    }
    res.writeHead(404).end()
  })

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
        client = { info: { id: randomUUID(), name, muted: false, deafened: false }, socket, alive: true }
        send(socket, { type: 'welcome', id: client.info.id, peers: [...clients.values()].map((c) => c.info) })
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
      }
    })

    socket.on('close', () => {
      clearTimeout(helloTimer)
      if (!client) return
      clients.delete(client.info.id)
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
      http.close(() => resolve())
      setTimeout(resolve, 500).unref()
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
