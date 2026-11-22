/**
 * Draws the app icon (two overlapping speech circles) and writes build/icon.png.
 * Pure Node, no image library: run `npm run icon` after changing the design.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'

const SIZE = 512
const pixels = Buffer.alloc(SIZE * SIZE * 4)

/** Coverage (0..1) of a disc at pixel (x, y), with a one-pixel soft edge. */
const disc = (x, y, cx, cy, r) => Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5))

function blend(i, [r, g, b], alpha) {
  const a = pixels[i + 3] / 255
  const out = alpha + a * (1 - alpha)
  if (out === 0) return
  pixels[i] = Math.round((r * alpha + pixels[i] * a * (1 - alpha)) / out)
  pixels[i + 1] = Math.round((g * alpha + pixels[i + 1] * a * (1 - alpha)) / out)
  pixels[i + 2] = Math.round((b * alpha + pixels[i + 2] * a * (1 - alpha)) / out)
  pixels[i + 3] = Math.round(out * 255)
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4
    blend(i, [0x16, 0x17, 0x1d], disc(x, y, 255.5, 255.5, 250)) // dark backdrop
    blend(i, [0x58, 0x65, 0xf2], disc(x, y, 200, 255.5, 120)) // left circle
    blend(i, [0x3b, 0xa5, 0x5d], disc(x, y, 312, 255.5, 120) * 0.88) // right circle
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(body))
  return Buffer.concat([head, body, tail])
}

const header = Buffer.alloc(13)
header.writeUInt32BE(SIZE, 0)
header.writeUInt32BE(SIZE, 4)
header.set([8, 6, 0, 0, 0], 8) // 8-bit RGBA

const rows = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  pixels.copy(rows, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}

mkdirSync('build', { recursive: true })
writeFileSync(
  'build/icon.png',
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
)
console.log('build/icon.png written')
