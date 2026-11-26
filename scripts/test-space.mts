/**
 * Chat, notes and media test: starts a server with a temporary data folder and checks
 * messages, file upload and download, notes, and that everything survives a restart.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { startDuoServer } from '../src/server/duo-server'
import { PROTOCOL_VERSION, type ClientMessage, type FileRef, type ServerMessage } from '../src/shared/protocol'

const PORT = 47902
const CODE = 'TEST42'
const BASE = `http://127.0.0.1:${PORT}`
const failures: string[] = []
const check = (ok: boolean, label: string): void => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures.push(label)
}
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface TestClient {
  ws: WebSocket
  inbox: ServerMessage[]
  token: string
  send(message: ClientMessage): void
  last<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> | undefined
}

async function connect(name: string): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
  const inbox: ServerMessage[] = []
  ws.on('message', (raw) => inbox.push(JSON.parse(raw.toString())))
  await new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  ws.send(JSON.stringify({ type: 'hello', name, code: CODE, protocol: PROTOCOL_VERSION }))
  await wait(250)
  const client: TestClient = {
    ws,
    inbox,
    token: '',
    send: (message) => ws.send(JSON.stringify(message)),
    last: (type) => inbox.findLast((m) => m.type === type) as never
  }
  client.token = client.last('welcome')?.token ?? ''
  return client
}

async function upload(client: TestClient, name: string, type: string, body: Buffer, extra = ''): Promise<FileRef> {
  const url = `${BASE}/media?t=${client.token}&name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}${extra}`
  const res = await fetch(url, { method: 'POST', body: new Uint8Array(body) })
  if (!res.ok) throw new Error(`upload failed: ${res.status}`)
  return (await res.json()) as FileRef
}

const dir = mkdtempSync(join(tmpdir(), 'duo-space-'))
let server = await startDuoServer({ code: CODE, port: PORT, host: '127.0.0.1', dataDir: dir })

try {
  const a = await connect('Alice')
  const b = await connect('Bob')
  check(a.token.length === 32 && a.token !== b.token, 'each client gets its own media token')
  check(a.last('chat-history')?.messages.length === 0, 'the chat starts empty')
  check(a.last('notes')?.notes.length === 0, 'the notes start empty')

  // ----- Text -----
  a.send({ type: 'chat-send', text: '  hello https://example.com  ', files: [] })
  a.send({ type: 'chat-send', text: '   ', files: [] })
  await wait(250)
  const first = b.last('chat-message')?.message
  check(first?.text === 'hello https://example.com' && first.from === 'Alice', 'a message reaches the other person')
  check(a.inbox.filter((m) => m.type === 'chat-message').length === 1, 'the sender gets it back once; empty messages are dropped')

  // ----- Files -----
  const photo = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251))
  const thumb = await upload(a, 'preview.jpg', 'image/jpeg', Buffer.from('thumb'))
  const ref = await upload(a, '../ph:oto.png', 'image/png', photo, `&thumb=${thumb.id}&w=640&h=480`)
  check(ref.size === 5000 && ref.name === '.._ph_oto.png', 'an upload is stored with a safe name')
  check(ref.thumb === thumb.id && ref.width === 640 && ref.height === 480, 'a photo keeps its preview and its size')

  check((await fetch(`${BASE}/media/${ref.id}?t=${a.token}`)).status === 404, 'a file not yet in a message cannot be fetched')

  // Bob cannot attach a file Alice uploaded.
  b.send({ type: 'chat-send', text: 'stolen', files: [ref.id] })
  await wait(200)
  check(b.last('chat-message')?.message.files.length === 0, 'a file can only be attached by whoever uploaded it')

  a.send({ type: 'chat-send', text: '', files: [ref.id] })
  await wait(250)
  const withFile = b.last('chat-message')?.message
  check(withFile?.files[0]?.id === ref.id && withFile.text === '', 'a message can carry a file and no text')

  const got = await fetch(`${BASE}/media/${ref.id}?t=${b.token}`)
  check(got.status === 200 && got.headers.get('content-type') === 'image/png', 'the other person can fetch the file')
  check(Buffer.from(await got.arrayBuffer()).equals(photo), 'the file comes back identical')

  const part = await fetch(`${BASE}/media/${ref.id}?t=${b.token}`, { headers: { range: 'bytes=100-199' } })
  check(
    part.status === 206 &&
      part.headers.get('content-range') === 'bytes 100-199/5000' &&
      Buffer.from(await part.arrayBuffer()).equals(photo.subarray(100, 200)),
    'byte ranges work (video seeking)'
  )
  const tail = await fetch(`${BASE}/media/${ref.id}?t=${b.token}`, { headers: { range: 'bytes=-10' } })
  check(tail.status === 206 && (await tail.arrayBuffer()).byteLength === 10, 'suffix byte ranges work')
  check(
    (await fetch(`${BASE}/media/${ref.id}?t=${b.token}`, { headers: { range: 'bytes=9000-' } })).status === 416,
    'a range past the end is refused'
  )
  check((await fetch(`${BASE}/media/${thumb.id}?t=${b.token}`)).status === 200, 'the preview can be fetched too')

  check((await fetch(`${BASE}/media/${ref.id}?t=wrong`)).status === 401, 'a wrong token is refused')
  check((await fetch(`${BASE}/media/${ref.id}`)).status === 401, 'no token is refused')
  check((await fetch(`${BASE}/media/..%2Fmessages.jsonl?t=${b.token}`)).status === 404, 'paths outside the media folder are refused')
  check((await fetch(`${BASE}/media?t=wrong`, { method: 'POST', body: 'x' })).status === 401, 'uploading needs a token')

  const page = await upload(a, 'page.html', 'text/html', Buffer.from('<script>alert(1)</script>'))
  a.send({ type: 'chat-send', text: '', files: [page.id] })
  await wait(200)
  const html = await fetch(`${BASE}/media/${page.id}?t=${b.token}`)
  check(
    html.headers.get('content-type') === 'application/octet-stream' &&
      (html.headers.get('content-disposition') ?? '').startsWith('attachment'),
    'a web page is only ever offered as a download'
  )

  // ----- Deleting -----
  b.send({ type: 'chat-delete', id: withFile!.id })
  await wait(200)
  check(!a.inbox.some((m) => m.type === 'chat-deleted'), "nobody can delete someone else's message")
  a.send({ type: 'chat-delete', id: withFile!.id })
  await wait(300)
  check(b.last('chat-deleted')?.id === withFile!.id, 'deleting a message is announced')
  check((await fetch(`${BASE}/media/${ref.id}?t=${b.token}`)).status === 404, 'its file is gone')
  check(!existsSync(join(dir, 'media', ref.id)) && !existsSync(join(dir, 'media', thumb.id)), 'file and preview are removed from disk')

  // ----- History pages -----
  for (let i = 0; i < 60; i++) b.send({ type: 'chat-send', text: `n${i}`, files: [] })
  await wait(400)
  a.send({ type: 'chat-history' })
  await wait(200)
  const latest = a.last('chat-history')!
  check(latest.messages.length === 50 && latest.more && latest.messages.at(-1)?.text === 'n59', 'history comes one page at a time')
  a.send({ type: 'chat-history', before: latest.messages[0].id })
  await wait(200)
  const older = a.last('chat-history')!
  check(older.messages.at(-1)?.text === 'n9' && !older.more && older.messages[0].text === 'hello https://example.com', 'older pages follow')
  check(latest.newer === false && older.newer === true, 'a page says whether newer messages follow it')
  const n30 = latest.messages.find((m) => m.text === 'n30')!
  a.send({ type: 'chat-history', around: n30.id })
  await wait(200)
  const around = a.last('chat-history')!
  check(around.around === n30.id && around.messages.some((m) => m.id === n30.id) && around.newer === true, 'a page can be asked around a message')
  a.send({ type: 'chat-history', after: around.messages.at(-1)!.id })
  await wait(200)
  const after = a.last('chat-history')!
  check(after.messages.at(-1)?.text === 'n59' && after.newer === false, 'newer pages follow')

  // ----- Replies, edits, reactions, pins, search -----
  const target = latest.messages.at(-1)!
  a.send({ type: 'chat-send', text: 'je réponds', files: [], replyTo: target.id })
  await wait(200)
  const reply = b.last('chat-message')!.message
  check(reply.replyTo?.id === target.id && reply.replyTo.from === 'Bob' && reply.replyTo.text === 'n59', 'a reply quotes the message it answers')
  a.send({ type: 'chat-edit', id: reply.id, text: 'je réponds, modifié' })
  b.send({ type: 'chat-edit', id: reply.id, text: 'pas à moi' })
  await wait(200)
  const updates = b.inbox.filter((m) => m.type === 'chat-updated')
  check(updates.length === 1 && updates[0].type === 'chat-updated' && updates[0].message.text === 'je réponds, modifié' && Boolean(updates[0].message.editedAt), 'only the author can change a message')
  b.send({ type: 'chat-react', id: reply.id, emoji: '👍' })
  a.send({ type: 'chat-react', id: reply.id, emoji: '👍' })
  a.send({ type: 'chat-react', id: reply.id, emoji: '👍🏽' })
  a.send({ type: 'chat-react', id: reply.id, emoji: 'hello' })
  await wait(200)
  let reacted = a.last('chat-updated')!.message
  check(JSON.stringify(reacted.reactions) === JSON.stringify({ '👍': ['Bob', 'Alice'], '👍🏽': ['Alice'] }), 'reactions add up per emoji; text is refused')
  a.send({ type: 'chat-react', id: reply.id, emoji: '👍🏽' })
  await wait(200)
  reacted = a.last('chat-updated')!.message
  check(!('👍🏽' in (reacted.reactions ?? {})), 'reacting again takes it back')
  b.send({ type: 'chat-pin', id: reply.id, pinned: true })
  await wait(200)
  check(a.last('chat-pins')?.messages[0]?.id === reply.id && a.last('chat-updated')!.message.pinned?.by === 'Bob', 'pinning is shared with everyone')
  a.send({ type: 'chat-search', query: 'REPONDS modifie' })
  await wait(200)
  const found = a.last('chat-search')!
  check(found.total === 1 && found.messages[0].id === reply.id, 'search ignores case and accents and needs every word')
  a.send({ type: 'chat-search', query: 'n5' })
  await wait(200)
  check(a.last('chat-search')!.messages[0].text === 'n59', 'search shows the newest matches first')
  const pinnedId = reply.id
  const now = Date.now()
  a.send({ type: 'chat-search', query: '', from: now - 60_000, to: now + 60_000 })
  await wait(200)
  const spanned = a.last('chat-search')!
  check(spanned.total > 60 && spanned.messages.every((m) => m.at >= now - 60_000), 'a search can be only a span of dates')
  a.send({ type: 'chat-search', query: 'n5', from: now + 60_000 })
  await wait(200)
  check(a.last('chat-search')!.total === 0, 'words and dates combine')
  a.send({ type: 'chat-history', date: reply.at })
  await wait(200)
  const day = a.last('chat-history')!
  check(day.date === reply.at && day.messages.at(-1)?.id === reply.id && day.messages.length === 6 && day.more, 'a page can start at a date, with a few messages before it')

  // ----- Notes -----
  a.send({ type: 'note-save', note: { id: 'note-1', title: 'Courses', text: 'lait\npain', color: 2, pinned: true } })
  await wait(200)
  const saved = b.last('note-saved')?.note
  check(saved?.title === 'Courses' && saved.updatedBy === 'Alice' && saved.pinned, 'a note reaches the other person')
  b.send({ type: 'note-save', note: { id: 'note-1', title: 'Courses', text: 'lait\npain\noeufs', color: 99, pinned: false } })
  b.send({ type: 'note-save', note: { id: '../bad id', title: 'x', text: '', color: 0, pinned: false } })
  b.send({ type: 'note-save', note: { id: 'note-2', title: 'Temp', text: '', color: 0, pinned: false } })
  await wait(200)
  const edited = a.inbox.filter((m) => m.type === 'note-saved')
  check(edited.length === 3, 'a note with an invalid id is refused')
  const second = edited[1].type === 'note-saved' ? edited[1].note : null
  check(second?.text.endsWith('oeufs') === true && second.color === 0, 'the other person can edit it; an unknown colour falls back')
  a.send({ type: 'note-delete', id: 'note-2' })
  await wait(200)
  check(b.last('note-deleted')?.id === 'note-2', 'deleting a note is announced')

  // ----- Restart -----
  a.ws.close()
  b.ws.close()
  await server.close()
  server = await startDuoServer({ code: CODE, port: PORT, host: '127.0.0.1', dataDir: dir })
  const c = await connect('Carol')
  const history = c.last('chat-history')!
  check(history.messages.length === 50 && history.messages.at(-1)?.text === 'je réponds, modifié', 'messages survive a restart')
  c.send({ type: 'chat-history', before: history.messages[0].id })
  await wait(200)
  check(!c.last('chat-history')!.messages.some((m) => m.id === withFile!.id), 'a deleted message stays deleted')
  const kept = history.messages.find((m) => m.id === pinnedId)
  check(kept?.text === 'je réponds, modifié' && kept.reactions?.['👍']?.length === 2 && Boolean(kept.pinned), 'edits, reactions and pins survive a restart')
  check(c.last('chat-pins')?.messages[0]?.id === pinnedId, 'pinned messages are sent on arrival')
  const notes = c.last('notes')!.notes
  check(notes.length === 1 && notes[0].text.endsWith('oeufs'), 'notes survive a restart')
  check((await fetch(`${BASE}/media/${page.id}?t=${c.token}`)).status === 200, 'files survive a restart')
  check(!readdirSync(join(dir, 'media')).some((f) => f.endsWith('.part')), 'no partial upload is left behind')
  c.ws.close()

  // ----- Voice-only server -----
  await server.close()
  server = await startDuoServer({ code: CODE, port: PORT, host: '127.0.0.1' })
  const d = await connect('Dave')
  check(d.token === '' && !d.last('chat-history'), 'without a data folder the server only does voice')
  d.ws.close()
} finally {
  await server.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures.length ? `\n${failures.length} failure(s)` : '\nAll tests pass')
process.exit(failures.length ? 1 : 0)
