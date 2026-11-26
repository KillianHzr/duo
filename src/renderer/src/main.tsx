import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Space } from './space'
import { DEFAULT_SETTINGS, VoiceEngine, type VoiceSettings } from './voice'
import '@fontsource-variable/manrope'
import './styles.css'
import './theme'

function loadSettings(): VoiceSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('duo.settings') ?? '{}') }
  } catch {
    return DEFAULT_SETTINGS
  }
}

const e2e = window.duo.e2e
const engine = new VoiceEngine(
  e2e
    ? {
        ...DEFAULT_SETTINGS,
        enhancedSuppression: e2e.enhanced,
        gateEnabled: e2e.gateDb !== null,
        gateThresholdDb: e2e.gateDb ?? DEFAULT_SETTINGS.gateThresholdDb
      }
    : loadSettings()
)
engine.subscribe(() => {
  localStorage.setItem('duo.settings', JSON.stringify(engine.getSnapshot().settings))
})

// Chat and notes share the voice connection to the host.
const space = new Space({ send: (message) => engine.sendToServer(message), httpBase: () => engine.httpBase() })
engine.onServerMessage = (message) => space.handle(message)
engine.onDisconnected = () => space.disconnected()

/** Test helper: a photo large enough to get a separate preview. */
async function fakePhoto(): Promise<File> {
  const canvas = new OffscreenCanvas(1200, 900)
  const context = canvas.getContext('2d')!
  const pixels = context.createImageData(1200, 900)
  for (let i = 0; i < pixels.data.length; i++) pixels.data[i] = i % 4 === 3 ? 255 : Math.random() * 255
  context.putImageData(pixels, 0, 0)
  return new File([await canvas.convertToBlob({ type: 'image/png' })], 'photo.png', { type: 'image/png' })
}

/** Test helper: true if the window is allowed to display the image at this address. */
const canShow = (url: string): Promise<boolean> =>
  new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve(image.naturalWidth > 0)
    image.onerror = () => resolve(false)
    image.src = url
  })

// Load measurement: the real interface, in a call, with a fake microphone.
if (e2e?.ui) localStorage.setItem('duo.name', e2e.name)

if (e2e && !e2e.ui) {
  // Automated test: connect straight away, then report the latest measurements to the main process.
  // The fake microphone beeps on and off, so keep the loudest level seen, not the last one.
  let micPeakDb = -100
  let heardPeak = 0
  engine.setStatsEnabled(true)
  engine.subscribeLevels(() => {
    const levels = engine.getLevels()
    micPeakDb = Math.max(micPeakDb, levels.micDb)
    heardPeak = Math.max(heardPeak, ...Object.values(levels.peers))
  })
  void (async () => {
    await engine.start(e2e.server, e2e.name, e2e.code)
    let sent: boolean | null = null
    if (e2e.say) {
      // Sent once everyone had time to join.
      setTimeout(async () => {
        sent = await space.sendMessage(e2e.say, [await fakePhoto()])
        space.saveNote({ id: `note-${e2e.name}`, title: e2e.say, text: 'shared', color: 1, pinned: false }, e2e.name)
      }, e2e.durationMs / 2)
    }
    await new Promise((resolve) => setTimeout(resolve, e2e.durationMs))
    const snapshot = engine.refresh()
    const shared = space.getSnapshot()
    const photo = shared.messages.at(-1)?.files[0]
    window.duo.e2eReport({
      name: e2e.name,
      status: snapshot.status,
      error: snapshot.error,
      visibility: document.visibilityState,
      micPeakDb,
      heardPeak,
      gateOpen: snapshot.gateOpen,
      chat: {
        available: shared.available,
        sent,
        messages: shared.messages.map((m) => ({ from: m.from, text: m.text, files: m.files })),
        notes: shared.notes.map((n) => ({ title: n.title, by: n.updatedBy })),
        photoShown: photo ? await canShow(space.mediaUrl(photo.id)) : false,
        previewShown: photo?.thumb ? await canShow(space.mediaUrl(photo.thumb)) : false
      },
      peers: snapshot.peers
    })
  })()
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App engine={engine} space={space} />
    </StrictMode>
  )
}
