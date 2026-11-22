/**
 * Server test: starts a server on a test port and checks discovery, the access code,
 * peer announcements and signal relaying.
 */
import { createSocket } from 'node:dgram'
import { WebSocket } from 'ws'
import { startDuoServer } from '../src/server/duo-server'
import { DISCOVERY_REQUEST, PROTOCOL_VERSION, type ServerMessage } from '../src/shared/protocol'

const PORT = 47901
const CODE = 'TEST42'
const failures: string[] = []
const check = (ok: boolean, label: string): void => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures.push(label)
}
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface TestClient {
  ws: WebSocket
  inbox: ServerMessage[]
}

function connect(name: string, code = CODE, protocol = PROTOCOL_VERSION): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
    const inbox: ServerMessage[] = []
    ws.on('message', (raw) => inbox.push(JSON.parse(raw.toString())))
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', name, code, protocol }))
      resolve({ ws, inbox })
    })
    ws.on('error', reject)
  })
}

function discover(): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = createSocket('udp4')
    const timer = setTimeout(() => {
      sock.close()
      resolve(null)
    }, 1000)
    sock.on('message', (data) => {
      clearTimeout(timer)
      sock.close()
      resolve(data.toString())
    })
    sock.send(DISCOVERY_REQUEST, PORT, '127.0.0.1')
  })
}

const rejection = (client: TestClient): string | undefined => {
  const msg = client.inbox.find((m) => m.type === 'rejected')
  return msg?.type === 'rejected' ? msg.reason : undefined
}

const server = await startDuoServer({ code: CODE, port: PORT })

try {
  const reply = await discover()
  check(reply !== null && JSON.parse(reply).port === PORT, 'UDP discovery answers with the right port')

  const old = await connect('Old', CODE, PROTOCOL_VERSION + 1)
  await wait(200)
  check(rejection(old) === 'version', 'a client with another protocol version is rejected')

  const a = await connect('Alice')
  await wait(200)
  const b = await connect('Bob', 'test-42') // lowercase and separators are tolerated
  await wait(300)

  const welcomeA = a.inbox.find((m) => m.type === 'welcome')
  const welcomeB = b.inbox.find((m) => m.type === 'welcome')
  check(welcomeA?.type === 'welcome' && welcomeA.peers.length === 0, 'Alice arrives alone')
  check(
    welcomeB?.type === 'welcome' && welcomeB.peers.length === 1 && welcomeB.peers[0].name === 'Alice',
    'Bob sees Alice when joining'
  )
  const joined = a.inbox.find((m) => m.type === 'peer-joined')
  check(joined?.type === 'peer-joined' && joined.peer.name === 'Bob', 'Alice is told Bob joined')

  if (welcomeA?.type === 'welcome' && welcomeB?.type === 'welcome') {
    b.ws.send(JSON.stringify({ type: 'signal', to: welcomeA.id, data: { kind: 'candidate', candidate: null } }))
    b.ws.send(JSON.stringify({ type: 'state', muted: true, deafened: false }))
    await wait(300)
    const signal = a.inbox.find((m) => m.type === 'signal')
    check(signal?.type === 'signal' && signal.from === welcomeB.id, "Bob's signal reaches Alice")
    const state = a.inbox.find((m) => m.type === 'peer-state')
    check(state?.type === 'peer-state' && state.muted === true, 'muted state is broadcast')

    b.ws.close()
    await wait(300)
    const left = a.inbox.find((m) => m.type === 'peer-left')
    check(left?.type === 'peer-left' && left.id === welcomeB.id, 'Alice is told Bob left')
  }

  // Wrong codes: rejected, never announced to others, then locked out.
  const before = a.inbox.length
  const reasons: (string | undefined)[] = []
  for (let i = 0; i < 6; i++) {
    const intruder = await connect('Eve', 'WRONG1')
    await wait(150)
    reasons.push(rejection(intruder))
  }
  check(reasons.slice(0, 5).every((r) => r === 'bad-code'), 'a wrong access code is rejected')
  check(reasons[5] === 'rate-limited', 'repeated wrong codes get locked out')
  check(a.inbox.length === before, 'rejected clients are never announced to others')

  const locked = await connect('Carol')
  await wait(200)
  check(rejection(locked) === 'rate-limited', 'the lockout also blocks the right code for a while')

  a.ws.close()
} finally {
  await server.close()
}

console.log(failures.length ? `\n${failures.length} failure(s)` : '\nAll tests pass')
process.exit(failures.length ? 1 : 0)
