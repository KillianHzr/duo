/**
 * Draws the app icon — the p of peinard lying on its back, leaning back as if rocking on a chair —
 * and writes it in every size the app and its installers need: build/icon.png, the image the
 * window and the tray use, and the images of the Microsoft Store package. Run `npm run icon`
 * after changing the design. The same drawing lives in AppIcon, in src/renderer/src/icons.tsx.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { Resvg } from '@resvg/resvg-js'

const INK = '#1c1d20'
const CREAM = '#ffe9d6'
const TOP = '#c3304f'
const BOTTOM = '#7a1530'

/**
 * The icon on a 100×100 canvas: a bordeaux disc with a soft light rim, and the p tilted back 12°,
 * its leg running off the right edge. At 24 px and below the strokes get heavier so the bowl stays open.
 */
const face = (size) => {
  const w = size <= 24 ? 17 : 13
  const tilt = 'transform="rotate(12 50 54)"'
  return (
    `<defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${TOP}"/><stop offset="1" stop-color="${BOTTOM}"/></linearGradient>` +
    `<clipPath id="disc"><circle cx="50" cy="50" r="46"/></clipPath></defs>` +
    `<circle cx="50" cy="50" r="46" fill="url(#fill)"/>` +
    `<g clip-path="url(#disc)"><circle cx="50" cy="50.8" r="45.4" fill="none" stroke="#ffffff" stroke-opacity="0.18" stroke-width="1.6"/>` +
    `<path d="M31 72 H130" ${tilt} stroke="${CREAM}" stroke-width="${w}" stroke-linecap="round"/></g>` +
    `<circle cx="48" cy="${72 - 17.5 - w / 2}" r="17.5" ${tilt} fill="none" stroke="${CREAM}" stroke-width="${w}"/>`
  )
}

function png(svg, width) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng()
}

/** The icon alone, on a transparent ground. */
const square = (size) => png(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${face(size)}</svg>`, size)

/** The icon centred on a wide dark ground, for the Store's wide tile. */
const wide = (width, height) => {
  const side = height * 0.7
  return png(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${INK}"/>` +
      `<svg x="${(width - side) / 2}" y="${(height - side) / 2}" width="${side}" height="${side}" viewBox="0 0 100 100">${face(side)}</svg></svg>`,
    width
  )
}

mkdirSync('build/appx', { recursive: true })
// Start from a clean folder: a size dropped from the lists below must not linger in the package.
for (const file of readdirSync('build/appx')) rmSync(`build/appx/${file}`)

const files = [
  ['build/icon.png', square(512)],
  // Loaded by the app itself, for its window and its tray icon.
  ['build/app-icon.png', square(256)]
]

// Names the Microsoft Store package builder expects, at the scales Windows asks for.
for (const [scale, factor] of [[100, 1], [200, 2], [400, 4]]) {
  const suffix = scale === 100 ? '' : `.scale-${scale}`
  files.push([`build/appx/StoreLogo${suffix}.png`, square(50 * factor)])
  files.push([`build/appx/Square44x44Logo${suffix}.png`, square(44 * factor)])
  files.push([`build/appx/Square150x150Logo${suffix}.png`, square(150 * factor)])
  files.push([`build/appx/Wide310x150Logo${suffix}.png`, wide(310 * factor, 150 * factor)])
}
// Exact sizes for the taskbar and Start. The "unplated" ones stop Windows drawing its own plate behind the icon.
for (const size of [16, 24, 32, 48, 256]) {
  for (const form of ['', '_altform-unplated', '_altform-lightunplated']) {
    files.push([`build/appx/Square44x44Logo.targetsize-${size}${form}.png`, square(size)])
  }
}

for (const [file, data] of files) writeFileSync(file, data)
console.log(`${files.length} images written`)
