/**
 * End-to-end voice test on a single machine, without touching the real microphone or speakers:
 * launches one instance of the app hosting the server and two joining it, with a fake microphone and
 * muted output, then checks that voice flows directly with the expected settings.
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

/** `host: true` makes that instance run the server itself, like a real host. */
function runClient(name, { code = CODE, host = false } = {}) {
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
    if (host) env.DUO_E2E_HOST_PORT = String(PORT)
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(electron, ['.'], { env, stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    const timer = setTimeout(() => child.kill(), DURATION + 20000)
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

{
  const hosting = runClient('Alice', { host: true })
  await wait(2500)
  const [alice, bob, eve] = await Promise.all([hosting, runClient('Bob'), runClient('Eve', { code: 'WRONG1' })])

  for (const [who, report] of [
    ['Alice', alice],
    ['Bob', bob]
  ]) {
    if (!report) {
      check(false, `${who}: no report received`)
      continue
    }
    const peer = report.peers[0]
    const s = peer?.stats
    console.log(`\n${who}:`, JSON.stringify({ status: report.status, error: report.error, peer }, null, 1))
    check(report.status === 'connected', `${who}: connected to the server`)
    check(report.peers.length === 1, `${who}: sees exactly one other person`)
    check(peer?.connection === 'connected', `${who}: audio link established`)
    check(s?.route === 'host ↔ host', `${who}: direct link, no relay`)
    check(s?.codec === 'opus', `${who}: Opus codec`)
    check(s?.frameMs > 8 && s?.frameMs < 12, `${who}: 10 ms frames (measured ${s?.frameMs?.toFixed(1)})`)
    check(s?.sendKbps > 60, `${who}: bitrate above 64 kb/s (measured ${s?.sendKbps?.toFixed(0)})`)
    check(s?.lossPct === 0, `${who}: no packet lost`)
    check(s?.bufferMs !== null && s?.bufferMs < 80, `${who}: low receive buffer (measured ${s?.bufferMs?.toFixed(0)} ms)`)
    check(peer?.level > 0, `${who}: actually receives sound`)
  }

  console.log('\nEve (wrong code):', JSON.stringify(eve))
  check(
    eve?.status === 'error' && eve?.error?.kind === 'rejected' && eve?.error?.reason === 'bad-code',
    'Eve: rejected with a wrong access code'
  )
  check(eve?.peers.length === 0, 'Eve: gets no audio link')
}

console.log(failures.length ? `\n${failures.length} failure(s)` : '\nAll tests pass')
process.exit(failures.length ? 1 : 0)
