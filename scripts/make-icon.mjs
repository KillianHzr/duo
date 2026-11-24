/**
 * Draws the app icon — Mousse, the moss character, dozing — and writes it in every size the
 * app and its installers need: build/icon.png, the image the window and the tray use, and the
 * images of the Microsoft Store package. Run `npm run icon` after changing the design.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { Resvg } from '@resvg/resvg-js'

const INK = '#1c1d20'
const CREAM = '#f3ead9'
const BODY = '#6e916d'
const MOSS = '#93b38b'

const eye = (x) => `<path d="M${x - 11} 63 A11 11 0 0 0 ${x + 11} 63" fill="none" stroke="${INK}" stroke-width="6.5" stroke-linecap="round"/>`
const daisy = `<g fill="${CREAM}"><circle cx="76" cy="12" r="6.6"/><circle cx="67.8" cy="18" r="6.6"/><circle cx="70.9" cy="27.6" r="6.6"/><circle cx="81.1" cy="27.6" r="6.6"/><circle cx="84.2" cy="18" r="6.6"/></g><circle cx="76" cy="20.5" r="5.4" fill="#f2b866"/>`

/** The face on a 100×100 canvas. Below 24 px the daisy is only noise, so it is left out. */
const face = (size) =>
  `<defs><clipPath id="tile"><rect width="100" height="100" rx="24"/></clipPath></defs>` +
  `<g clip-path="url(#tile)"><rect width="100" height="100" fill="${BODY}"/>` +
  `<path d="M-2 -2 H102 V44 Q88 29 75 42 Q63 54 50 42 Q37 30 25 42 Q12 54 -2 44 Z" fill="${MOSS}"/>` +
  `${eye(34)}${eye(66)}${size >= 24 ? daisy : ''}</g>`

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
