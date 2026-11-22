/**
 * Tests the microphone gate by running its audio-thread code in Node with a fake
 * AudioWorklet environment and synthetic sound.
 */
import { readFileSync } from 'node:fs'

const RATE = 48000
const BLOCK = 128
const sent = []
let Processor

globalThis.sampleRate = RATE
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { postMessage: (message) => sent.push(message), onmessage: null }
  }
}
globalThis.registerProcessor = (_name, cls) => (Processor = cls)
new Function(readFileSync('src/renderer/public/gate-processor.js', 'utf8'))()

const failures = []
const check = (ok, label) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures.push(label)
}

/** Feeds `seconds` of a sine at `db` dBFS (RMS); returns the messages produced. */
function feed(gate, seconds, db) {
  sent.length = 0
  const amplitude = db <= -100 ? 0 : Math.SQRT2 * 10 ** (db / 20)
  const blocks = Math.round((seconds * RATE) / BLOCK)
  for (let b = 0; b < blocks; b++) {
    const block = new Float32Array(BLOCK)
    for (let i = 0; i < BLOCK; i++) block[i] = amplitude * Math.sin((2 * Math.PI * 440 * (b * BLOCK + i)) / RATE)
    gate.process([[block]])
  }
  return [...sent]
}
const opens = (messages) => messages.filter((m) => 'open' in m).map((m) => m.open)

const gate = new Processor()
check(opens(feed(gate, 0.5, -70)).length === 0, 'gate off: quiet sound changes nothing (stays open)')

gate.port.onmessage({ data: { enabled: true, threshold: -45 } })
check(opens(feed(gate, 0.5, -60)).join() === 'false', 'gate on: sound under the threshold closes it')
check(opens(feed(gate, 0.5, -70)).length === 0, 'still closed on quieter sound')

const voice = feed(gate, 0.2, -20)
check(opens(voice).join() === 'true', 'voice above the threshold opens it')
check(voice.findIndex((m) => m.open === true) === 0, 'it opens on the very first audio block (under 3 ms)')

check(opens(feed(gate, 0.25, -70)).length === 0, 'a 250 ms pause does not close it')
check(opens(feed(gate, 0.2, -70)).join() === 'false', 'it closes once silence lasts beyond 300 ms')

gate.port.onmessage({ data: { threshold: -75 } })
check(opens(feed(gate, 0.1, -70)).join() === 'true', 'lowering the threshold lets quiet sound through')

gate.port.onmessage({ data: { meter: true } })
const levels = feed(gate, 0.5, -30).filter((m) => 'level' in m).map((m) => m.level)
check(levels.length >= 8 && levels.length <= 11, `meter reports about 20 times a second (${levels.length} in 0.5 s)`)
check(levels.every((l) => Math.abs(l + 30) < 1), 'meter reads the right level (-30 dB)')

gate.port.onmessage({ data: { enabled: false } })
feed(gate, 0.1, -20)
check(opens(feed(gate, 1, -100)).length === 0, 'gate off again: silence does not close it')

console.log(failures.length ? `\n${failures.length} failure(s)` : '\nAll tests pass')
process.exit(failures.length ? 1 : 0)
