/**
 * Link previews for the chat: the title, description and picture a web page announces about itself
 * (its Open Graph tags). Fetched here rather than in the window, which may not reach the web, and
 * only for public addresses, so a link can never make the app probe the local network.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export interface LinkPreview {
  url: string
  site: string
  title: string
  description: string
  /** The page's picture as a data: URL, so the window never loads anything from the web itself. */
  image: string | null
}

const PAGE_BYTES = 512 * 1024
const IMAGE_BYTES = 1024 * 1024
const TIMEOUT_MS = 6000
const MAX_REDIRECTS = 4
const CACHE_SIZE = 200
const cache = new Map<string, Promise<LinkPreview | null>>()

function isPrivateIp(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
  }
  const lower = ip.toLowerCase()
  return lower === '::' || lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')
}

/** True when every address the host name points to is on the public Internet. */
async function isPublic(url: URL): Promise<boolean> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  if (url.username || url.password) return false
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost')) return false
  try {
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true })
    return addresses.length > 0 && addresses.every((a) => !isPrivateIp(a.address))
  } catch {
    return false
  }
}

/** Fetches a public address, following redirects by hand so each hop is checked too. */
async function fetchPublic(start: string, accept: string): Promise<Response | null> {
  let url = new URL(start)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await isPublic(url))) return null
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept, 'user-agent': 'Mozilla/5.0 (compatible; PeinardLinkPreview/1.0)', 'accept-language': 'fr,en;q=0.8' }
    })
    const next = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && next) {
      url = new URL(next, url)
      continue
    }
    return response.ok ? response : null
  }
  return null
}

async function readCapped(response: Response, max: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > max) return null
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > max) {
      // Pages are cut, not refused: the tags we need sit in the <head>.
      chunks.push(value.subarray(0, value.length - (size - max)))
      void reader.cancel()
      break
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' }
const decode = (text: string): string =>
  text
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, code: string) => {
      if (code[0] === '#') {
        const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole
      }
      return ENTITIES[code.toLowerCase()] ?? whole
    })
    .replace(/\s+/g, ' ')
    .trim()

function metaTags(html: string): Map<string, string> {
  const tags = new Map<string, string>()
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attr = (name: string): string | undefined =>
      new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)?.slice(2).find((v) => v !== undefined)
    const key = (attr('property') ?? attr('name'))?.toLowerCase()
    const content = attr('content')
    if (key && content && !tags.has(key)) tags.set(key, decode(content))
  }
  return tags
}

async function build(raw: string): Promise<LinkPreview | null> {
  const response = await fetchPublic(raw, 'text/html,application/xhtml+xml')
  if (!response || !/html/i.test(response.headers.get('content-type') ?? '')) return null
  const body = await readCapped(response, PAGE_BYTES)
  if (!body) return null
  const html = body.toString('utf8')
  const tags = metaTags(html)
  const pageTitle = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]
  const title = (tags.get('og:title') ?? tags.get('twitter:title') ?? decode(pageTitle ?? '')).slice(0, 200)
  const description = (tags.get('og:description') ?? tags.get('twitter:description') ?? tags.get('description') ?? '').slice(0, 300)
  const final = new URL(response.url || raw)
  const site = (tags.get('og:site_name') ?? final.hostname.replace(/^www\./, '')).slice(0, 80)
  if (!title && !description) return null

  let image: string | null = null
  const picture = tags.get('og:image:secure_url') ?? tags.get('og:image') ?? tags.get('twitter:image')
  if (picture) {
    try {
      const pic = await fetchPublic(new URL(picture, final).toString(), 'image/*')
      const type = pic?.headers.get('content-type')?.split(';')[0].trim() ?? ''
      if (pic && /^image\/(png|jpeg|gif|webp|avif)$/.test(type)) {
        const bytes = await readCapped(pic, IMAGE_BYTES)
        if (bytes && bytes.length < IMAGE_BYTES) image = `data:${type};base64,${bytes.toString('base64')}`
      }
    } catch {
      /* no picture */
    }
  }
  return { url: raw, site, title, description, image }
}

export function linkPreview(raw: unknown): Promise<LinkPreview | null> {
  if (typeof raw !== 'string' || raw.length > 2000 || !/^https?:\/\//i.test(raw)) return Promise.resolve(null)
  let entry = cache.get(raw)
  if (!entry) {
    entry = build(raw).catch(() => null)
    cache.set(raw, entry)
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
  }
  return entry
}
