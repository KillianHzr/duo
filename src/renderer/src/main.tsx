import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { DEFAULT_SETTINGS, VoiceEngine, type VoiceSettings } from './voice'
import './styles.css'

function loadSettings(): VoiceSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('duo.settings') ?? '{}') }
  } catch {
    return DEFAULT_SETTINGS
  }
}

const engine = new VoiceEngine(loadSettings())
engine.subscribe(() => {
  localStorage.setItem('duo.settings', JSON.stringify(engine.getSnapshot().settings))
})

const e2e = window.duo.e2e
if (e2e) {
  // Automated test: connect straight away, then report the latest measurements to the main process.
  void (async () => {
    await engine.start(e2e.server, e2e.name, e2e.code)
    await new Promise((resolve) => setTimeout(resolve, e2e.durationMs))
    const snapshot = engine.refresh()
    window.duo.e2eReport({
      name: e2e.name,
      status: snapshot.status,
      error: snapshot.error,
      visibility: document.visibilityState,
      peers: snapshot.peers
    })
  })()
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App engine={engine} />
    </StrictMode>
  )
}
