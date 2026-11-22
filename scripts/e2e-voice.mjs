/**
 * End-to-end voice test on a single machine, without touching the real microphone or speakers.
 * Launches hidden instances of the app with a fake microphone and muted output, all on loopback:
 *   Alice  hosts the server, default settings
 *   Bob    joins with enhanced noise suppression (RNNoise)
 *   Carol  joins with the sensitivity gate set under her microphone level, so she is heard
 *   Dave   joins with the gate set above his microphone level, so he stays silent
 *   Eve    tries to join with a wrong access code
 * Bob also posts a chat message with a photo and saves a shared note, kept by Alice.
 * Requires `npm run build` first.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electron = require('electron')
const PORT = 47902
const CODE = 'E2E234'
const DURATION = Number(process.env.DUO_E2E_DURATION ?? 9000)

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function runClient(name, { code = CODE, host = false, enhanced = false, gateDb = null, say = '' } = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'duo-e2e-'))
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      DUO_E2E_NAME: name,
      DUO_E2E_SERVER: `ws://127.0.0.1:${PORT}`,
      DUO_E2E_CODE: code,
      // The host starts first and must still be up when the others take their reading.
      DUO_E2E_DURATION: String(host ? DURATION + 4000 : DURATION),
      DUO_E2E_USERDATA: userData
    }
    if (host) {
      env.DUO_E2E_HOST_PORT = String(PORT)
      env.DUO_E2E_DATA = join(userData, 'data')
    }
    if (say) env.DUO_E2E_SAY = say
    if (enhanced) env.DUO_E2E_ENHANCED = '1'
    if (gateDb !== null) env.DUO_E2E_GATE = String(gateDb)
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(electron, ['.'], { env, stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    const timer = setTimeout(() => child.kill(), DURATION + 24000)
    child.on('exit', () => {
      clearTimeout(timer)
      try {
        rmSync(userData, { recursive: true, force: true })
      } catch {
        /* folder still locked: harmless */
      }
      const line = output.split('\n').find((l) => l.startsWith('E2E_REPORT '))
      resolve(line ? JSON.parse(line.slice('E2E_REPORT '.length)) : null)
    })
  })
}

const failures = []
const check = (ok, label) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures.push(label)
}
const num = (value, digits = 0) => (typeof value === 'number' ? value.toFixed(digits) : String(value))

const hosting = runClient('Alice', { host: true })
await wait(2500)
const [alice, bob, carol, dave, eve] = await Promise.all([
  hosting,
  runClient('Bob', { enhanced: true, say: 'hello from Bob' }),
  runClient('Carol', { gateDb: -60 }),
  runClient('Dave', { gateDb: -5 }),
  runClient('Eve', { code: 'WRONG1' })
])
const reports = { Alice: alice, Bob: bob, Carol: carol, Dave: dave }

for (const [who, report] of Object.entries(reports)) {
  console.log(`\n${who}`)
  if (!report) {
    check(false, `${who}: no report received`)
    continue
  }
  check(report.status === 'connected', `${who}: connected to the server`)
  check(report.peers.length === 3, `${who}: sees the three other people`)
  for (const peer of report.peers) {
    const s = peer.stats
    const link = `${who} ↔ ${peer.name}`
    check(peer.connection === 'connected', `${link}: audio link established`)
    check(s.route === 'host ↔ host' && s.codec === 'opus', `${link}: direct link, Opus`)
    check(s.frameMs > 8 && s.frameMs < 12, `${link}: 10 ms frames (measured ${num(s.frameMs, 1)})`)
    check(s.lossPct === 0, `${link}: no packet lost`)
    // Generous bound: five instances share this machine. A real two-person call measures 20-30 ms.
    check(s.bufferMs !== null && s.bufferMs < 200, `${link}: receive buffer stays bounded (${num(s.bufferMs)} ms)`)
  }
}

const heard = (listener, speaker) => reports[listener]?.peers.find((p) => p.name === speaker)?.stats.energy
console.log('\nSound actually received')
check(heard('Bob', 'Alice') > 0, `Bob hears Alice, default settings (energy ${num(heard('Bob', 'Alice'), 5)})`)
check(heard('Alice', 'Bob') > 0, `Alice hears Bob through enhanced suppression (energy ${num(heard('Alice', 'Bob'), 5)})`)
check(bob?.micPeakDb > -100, `Bob: his level is measured after the filter (peak ${num(bob?.micPeakDb)} dB)`)
check(carol?.micPeakDb > -60, `Carol: her peak level ${num(carol?.micPeakDb)} dB is above the -60 dB threshold`)
check(heard('Alice', 'Carol') > 0, `Alice hears Carol through the open gate (energy ${num(heard('Alice', 'Carol'), 5)})`)
check(dave?.micPeakDb > -60, `Dave: the gate still measures his microphone while closed (peak ${num(dave?.micPeakDb)} dB)`)
check(dave?.gateOpen === false, 'Dave: gate closed, his level is under the -5 dB threshold')
check(heard('Alice', 'Dave') === 0, `Alice hears pure silence from Dave (energy ${num(heard('Alice', 'Dave'), 5)})`)
check(heard('Dave', 'Alice') > 0, `Dave still hears Alice (energy ${num(heard('Dave', 'Alice'), 5)})`)

console.log('\nChat and notes')
check(bob?.chat?.sent === true, 'Bob: message and photo sent to the host')
for (const [who, report] of Object.entries(reports)) {
  const message = report?.chat?.messages.at(-1)
  const file = message?.files[0]
  check(report?.chat?.available === true, `${who}: chat available`)
  check(message?.from === 'Bob' && message?.text === 'hello from Bob', `${who}: has Bob's message`)
  check(file?.mime === 'image/png' && file?.width === 1200 && Boolean(file?.thumb), `${who}: the photo comes with its size and a preview`)
  check(report?.chat?.photoShown === true && report?.chat?.previewShown === true, `${who}: photo and preview can be displayed`)
  check(report?.chat?.notes[0]?.title === 'hello from Bob' && report?.chat?.notes[0]?.by === 'Bob', `${who}: has Bob's note`)
}

console.log('\nEve (wrong code):', JSON.stringify(eve))
check(
  eve?.status === 'error' && eve?.error?.kind === 'rejected' && eve?.error?.reason === 'bad-code',
  'Eve: rejected with a wrong access code'
)
check(eve?.peers.length === 0, 'Eve: gets no audio link')

console.log(failures.length ? `\n${failures.length} failure(s)` : '\nAll tests pass')
process.exit(failures.length ? 1 : 0)
