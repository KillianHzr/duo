/**
 * Draws the app icon (two overlapping speech circles) and writes it in every size the
 * installers need: build/icon.png, plus the tile images of the Microsoft Store package.
 * Pure Node, no image library: run `npm run icon` after changing the design.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'

/** The design is drawn on a 512-unit square, then scaled and centered into the image. */
const DESIGN = 512
const SHAPES = [
  { cx: 255.5, cy: 255.5, r: 250, color: [0x16, 0x17, 0x1d], alpha: 1 }, // dark backdrop
  { cx: 200, cy: 255.5, r: 120, color: [0x58, 0x65, 0xf2], alpha: 1 }, // left circle
  { cx: 312, cy: 255.5, r: 120, color: [0x3b, 0xa5, 0x5d], alpha: 0.88 } // right circle
]

function render(width, height) {
  const pixels = Buffer.alloc(width * height * 4)
  const scale = Math.min(width, height) / DESIGN
  const offsetX = (width - DESIGN * scale) / 2
  const offsetY = (height - DESIGN * scale) / 2

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      for (const shape of SHAPES) {
        const distance = Math.hypot(x - (offsetX + shape.cx * scale), y - (offsetY + shape.cy * scale))
        // Coverage of the disc at this pixel, with a one-pixel soft edge.
        const alpha = Math.max(0, Math.min(1, shape.r * scale - distance + 0.5)) * shape.alpha
        const under = pixels[i + 3] / 255
        const out = alpha + under * (1 - alpha)
        if (out === 0) continue
        for (let c = 0; c < 3; c++) {
          pixels[i + c] = Math.round((shape.color[c] * alpha + pixels[i + c] * under * (1 - alpha)) / out)
        }
        pixels[i + 3] = Math.round(out * 255)
      }
    }
  }
  return encodePng(pixels, width, height)
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

function encodePng(pixels, width, height) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8) // 8-bit RGBA

  const stride = width * 4 + 1
  const rows = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) pixels.copy(rows, y * stride + 1, y * width * 4, (y + 1) * width * 4)

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const outputs = [
  ['build/icon.png', 512, 512],
  // File names expected by the Microsoft Store package (appx) builder.
  ['build/appx/StoreLogo.png', 50, 50],
  ['build/appx/Square44x44Logo.png', 44, 44],
  ['build/appx/Square150x150Logo.png', 150, 150],
  ['build/appx/Wide310x150Logo.png', 310, 150]
]

mkdirSync('build/appx', { recursive: true })
for (const [file, width, height] of outputs) {
  writeFileSync(file, render(width, height))
  console.log(`${file} (${width}x${height})`)
}
