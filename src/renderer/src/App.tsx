import { useCallback, useEffect, useState, useSyncExternalStore, type FormEvent } from 'react'
import { bindingFromKey, bindingFromMouse, type PttBinding } from '../../shared/keys'
import { CODE_LENGTH, DUO_PORT, normalizeCode } from '../../shared/protocol'
import type { AppState, CloseAction, UpdateStatus } from '../../preload/index'
import { t, type MessageKey } from './i18n'
import { Chat } from './Chat'
import { Notes } from './Notes'
import { Avatar, Icon } from './icons'
import type { Space } from './space'
import type { Levels, PeerStats, PeerView, VoiceEngine, VoiceError } from './voice'

type Tab = 'voice' | 'chat' | 'notes'

const GATE_MIN_DB = -80
const GATE_MAX_DB = -10
const WIDE = '(min-width: 720px)'

/** Maps a level in dBFS onto the 0..1 width of a meter that spans the gate slider's range. */
const dbToLevel = (db: number): number => Math.max(0, Math.min(1, (db - GATE_MIN_DB) / (GATE_MAX_DB - GATE_MIN_DB)))

function toUrl(input: string): string {
  const host = input.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '')
  return `ws://${host.includes(':') ? host : `${host}:${DUO_PORT}`}`
}

function errorText(error: VoiceError): string {
  if (error.kind === 'microphone') return `${t('micError')} — ${error.detail}`
  const byReason: Record<typeof error.reason, MessageKey> = {
    'bad-code': 'codeWrong',
    'rate-limited': 'codeLocked',
    version: 'versionMismatch'
  }
  return t(byReason[error.reason])
}

export function App({ engine, space }: { engine: VoiceEngine; space: Space }) {
  return (
    <>
      <div className="titlebar">
        <span className="logo" />
        Duo
      </div>
      <Main engine={engine} space={space} />
      <ClosePrompt />
    </>
  )
}

/** Asks what the close button should do, until the user picks a default. */
function ClosePrompt() {
  const [open, setOpen] = useState(false)
  const [remember, setRemember] = useState(false)

  useEffect(() => window.duo.onCloseRequested(() => setOpen(true)), [])
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null
  const choose = (action: 'tray' | 'quit'): void => {
    setOpen(false)
    window.duo.closeChoice(action, remember)
  }
  return (
    <div className="overlay" onClick={() => setOpen(false)}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="close-title" onClick={(e) => e.stopPropagation()}>
        <h1 id="close-title">{t('closeTitle')}</h1>
        <button className="choice" autoFocus onClick={() => choose('tray')}>
          <strong>{t('closeToTray')}</strong>
          <span className="muted small">{t('closeToTrayHint')}</span>
        </button>
        <button className="choice" onClick={() => choose('quit')}>
          <strong>{t('closeQuit')}</strong>
          <span className="muted small">{t('closeQuitHint')}</span>
        </button>
        <Toggle label={t('closeRemember')} checked={remember} onChange={setRemember} />
        <button className="ghost" onClick={() => setOpen(false)}>
          {t('cancel')}
        </button>
      </div>
    </div>
  )
}

function Main({ engine, space }: { engine: VoiceEngine; space: Space }) {
  const voice = useSyncExternalStore(engine.subscribe, engine.getSnapshot)
  const shared = useSyncExternalStore(space.subscribe, space.getSnapshot)
  const [tab, setTab] = useState<Tab>('voice')
  // Wide windows show the voice room beside the rest, so it is not a tab of its own there.
  const wide = useWide()
  const view: Tab = wide && tab === 'voice' ? 'chat' : tab
  const [app, setApp] = useState<AppState | null>(null)
  const [name, setName] = useState(() => localStorage.getItem('duo.name') ?? '')
  const [notFound, setNotFound] = useState(false)
  const [manual, setManual] = useState(() => localStorage.getItem('duo.server') ?? '')
  const [showSettings, setShowSettings] = useState(false)
  const [showStats, setShowStats] = useState(false)
  const [update, setUpdate] = useState<UpdateStatus>({ ready: null, blocked: null })
  /** Bumped to force a new connection attempt even when nothing else changed. */
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    void window.duo.getState().then(setApp)
    void window.duo.getUpdateStatus().then(setUpdate)
    const stopUpdates = window.duo.onUpdateStatus(setUpdate)
    const stopState = window.duo.onStateChanged(setApp)
    return () => {
      stopUpdates()
      stopState()
    }
  }, [])

  // Push-to-talk: the main process watches the key, even while a game has the focus.
  const [pttFailed, setPttFailed] = useState(false)
  const { pttEnabled, pttBinding } = voice.settings
  useEffect(() => window.duo.onPtt((down) => engine.setPttDown(down)), [engine])
  useEffect(() => {
    const binding = pttEnabled && pttBinding ? { kind: pttBinding.kind, code: pttBinding.code } : null
    void window.duo.setPtt(binding).then((ok) => {
      setPttFailed(!ok)
      if (!ok) void engine.updateSettings({ pttEnabled: false })
    })
  }, [engine, pttEnabled, pttBinding?.kind, pttBinding?.code]) // eslint-disable-line react-hooks/exhaustive-deps

  // Network measurements are only taken while they are on screen.
  useEffect(() => {
    engine.setStatsEnabled(showStats && (wide || tab === 'voice'))
    return () => engine.setStatsEnabled(false)
  }, [engine, showStats, tab, wide])

  const role = app?.role ?? null
  const code = app?.code ?? ''
  const hostFailed = Boolean(app?.hostError)

  const connect = useCallback(
    async (forcedUrl?: string) => {
      setNotFound(false)
      let url = forcedUrl
      if (!url) url = role === 'host' ? `ws://127.0.0.1:${DUO_PORT}` : (await window.duo.discover())[0]
      if (!url) {
        setNotFound(true)
        return
      }
      await engine.start(url, name, code)
    },
    [engine, name, role, code]
  )

  // Connect as soon as we know who we are, which side we are on and (for guests) the code.
  const ready = Boolean(name && role && code && !hostFailed)
  useEffect(() => {
    if (!ready) return
    void connect()
    return () => engine.stop()
  }, [ready, connect, engine, attempt])

  if (!app) return null
  if (!name) return <NameForm onSubmit={setName} />

  if (!role) {
    return (
      <div className="screen center">
        <Brand />
        <h1>{t('chooseRole')}</h1>
        <button className="choice" onClick={() => void window.duo.host().then(setApp)}>
          <strong>{t('hostTitle')}</strong>
          <span className="muted small">{t('hostHint')}</span>
        </button>
        <button className="choice" onClick={() => void window.duo.join('').then(setApp)}>
          <strong>{t('joinTitle')}</strong>
          <span className="muted small">{t('joinHint')}</span>
        </button>
      </div>
    )
  }

  const changeRole = (): void => void window.duo.resetRole().then(setApp)
  const rejected = voice.error?.kind === 'rejected' ? voice.error.reason : null

  if (role === 'host' && hostFailed) {
    return (
      <div className="screen center">
        <Brand />
        <h1>{t('error')}</h1>
        <p className="muted">{app.hostError === 'port-in-use' ? t('portInUse') : app.hostError}</p>
        <button className="primary" onClick={() => void window.duo.host().then(setApp)}>
          {t('retry')}
        </button>
        <button className="ghost" onClick={changeRole}>
          {t('back')}
        </button>
      </div>
    )
  }

  if (role === 'guest' && (!code || rejected === 'bad-code' || rejected === 'rate-limited')) {
    return (
      <CodeForm
        error={rejected ? errorText(voice.error!) : null}
        onSubmit={(value) => {
          engine.stop()
          void window.duo.join(value).then((next) => {
            setApp(next)
            setAttempt((n) => n + 1)
          })
        }}
        onBack={changeRole}
      />
    )
  }

  if (notFound) {
    return (
      <div className="screen center">
        <Brand />
        <h1>{t('notFoundTitle')}</h1>
        <p className="muted">{t('notFoundHint')}</p>
        <button className="primary" onClick={() => void connect()}>
          {t('retry')}
        </button>
        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault()
            if (!manual.trim()) return
            localStorage.setItem('duo.server', manual.trim())
            void connect(toUrl(manual))
          }}
        >
          <input
            value={manual}
            onChange={(event) => setManual(event.target.value)}
            placeholder={t('hostAddress')}
            aria-label={t('hostAddress')}
          />
          <button type="submit">{t('connect')}</button>
        </form>
        <button className="ghost" onClick={changeRole}>
          {t('back')}
        </button>
      </div>
    )
  }

  /** False while the sensitivity gate keeps the microphone shut. */
  const sending = (!voice.settings.gateEnabled || voice.gateOpen) && (!pttEnabled || voice.pttDown)

  const statusLabel: Record<typeof voice.status, string> = {
    idle: t('searching'),
    connecting: t('connecting'),
    connected: voice.peers.length ? t('inCall') : t('waiting'),
    reconnecting: t('reconnecting'),
    error: t('error')
  }

  const selfStatus = voice.deafened ? t('deafened') : voice.muted ? t('muted') : statusLabel[voice.status]

  return (
    <div className={`app view-${view}`}>
      <aside className="side">
        <div className="side-head">
          <span className="label">{t('voiceRoom')}</span>
          <span className={`status ${voice.status}`}>{statusLabel[voice.status]}</span>
        </div>
        <section className="people">
          <SelfPerson engine={engine} name={name} silent={voice.muted || !sending} muted={voice.muted} deafened={voice.deafened} />
          {voice.peers.map((peer) => (
            <PeerRow key={peer.id} peer={peer} engine={engine} showStats={showStats} />
          ))}
          {voice.status === 'connected' && voice.peers.length === 0 && (
            <div className="empty">
              <p className="muted small">{t('alone')}</p>
              {role === 'host' && <AccessCode code={code} />}
            </div>
          )}
        </section>
      </aside>

      <nav className="tabs">
        {(['voice', 'chat', 'notes'] as const).map((id) => (
          <button
            key={id}
            className={`tab${view === id ? ' active' : ''}${id === 'voice' ? ' narrow-only' : ''}`}
            aria-pressed={view === id}
            onClick={() => setTab(id)}
          >
            <Icon name={id} size={18} />
            {t(id === 'voice' ? 'tabVoice' : id === 'chat' ? 'tabChat' : 'tabNotes')}
            {id === 'chat' && shared.unread > 0 && <span className="badge">{shared.unread}</span>}
          </button>
        ))}
      </nav>

      <div className="notices">
        {update.ready && (
          <div className="notice">
            <span>{t('updateReady', { version: update.ready })}</span>
            <button className="primary" onClick={() => window.duo.installUpdate()}>
              {t('restart')}
            </button>
          </div>
        )}
        {update.blocked && !update.ready && (
          <div className="notice">
            <span>{t('updateBlocked', { version: update.blocked })}</span>
            <button className="primary" onClick={() => window.duo.openReleases()}>
              {t('download')}
            </button>
          </div>
        )}
        {voice.error && <div className="error">{errorText(voice.error)}</div>}
      </div>

      <main className="main">
        {view === 'chat' && <Chat space={space} self={name} />}
        {view === 'notes' && <Notes space={space} self={name} />}
      </main>

      <div className="userbar">
        <Avatar name={name} />
        <div className="who">
          <strong>{name}</strong>
          <span className="muted small">{selfStatus}</span>
        </div>
        <button
          className={voice.muted ? 'icon-btn on' : 'icon-btn'}
          onClick={() => engine.setMuted(!voice.muted)}
          aria-pressed={voice.muted}
          aria-label={voice.muted ? t('muted') : t('mute')}
          title={voice.muted ? t('muted') : t('mute')}
        >
          <Icon name={voice.muted ? 'micOff' : 'mic'} />
        </button>
        <button
          className={voice.deafened ? 'icon-btn on' : 'icon-btn'}
          onClick={() => engine.setDeafened(!voice.deafened)}
          aria-pressed={voice.deafened}
          aria-label={voice.deafened ? t('deafened') : t('deafen')}
          title={voice.deafened ? t('deafened') : t('deafen')}
        >
          <Icon name={voice.deafened ? 'headphonesOff' : 'headphones'} />
        </button>
        <button className="icon-btn" onClick={() => setShowSettings(true)} aria-label={t('settings')} title={t('settings')}>
          <Icon name="settings" />
        </button>
      </div>

      {showSettings && (
        <Settings
          engine={engine}
          voice={voice}
          app={app}
          setApp={setApp}
          sending={sending}
          pttFailed={pttFailed}
          showStats={showStats}
          setShowStats={setShowStats}
          onChangeName={() => {
            localStorage.removeItem('duo.name')
            setShowSettings(false)
            setName('')
          }}
          onChangeRole={() => {
            setShowSettings(false)
            changeRole()
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}

/** True when the window is wide enough to show the voice room next to the chat. */
function useWide(): boolean {
  const [wide, setWide] = useState(() => matchMedia(WIDE).matches)
  useEffect(() => {
    const query = matchMedia(WIDE)
    const onChange = (): void => setWide(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return wide
}

type SettingsSection = 'voice' | 'app' | 'host'

function Settings(props: {
  engine: VoiceEngine
  voice: ReturnType<VoiceEngine['getSnapshot']>
  app: AppState
  setApp: (state: AppState) => void
  sending: boolean
  pttFailed: boolean
  showStats: boolean
  setShowStats: (value: boolean) => void
  onChangeName: () => void
  onChangeRole: () => void
  onClose: () => void
}) {
  const { engine, voice, app, setApp } = props
  const [section, setSection] = useState<SettingsSection>('voice')
  const isHost = app.role === 'host'
  const sections: [SettingsSection, MessageKey][] = [
    ['voice', 'settingsVoice'],
    ['app', 'settingsApp'],
    ...(isHost ? ([['host', 'settingsHost']] as [SettingsSection, MessageKey][]) : [])
  ]

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="overlay" onClick={props.onClose}>
      <div className="dialog settings" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
        <div className="settings-nav">
          <h1 id="settings-title">{t('settings')}</h1>
          {sections.map(([id, label]) => (
            <button key={id} className={section === id ? 'nav-item active' : 'nav-item'} aria-pressed={section === id} onClick={() => setSection(id)}>
              {t(label)}
            </button>
          ))}
          <span className="muted small version">
            {t('version')} {app.version}
          </span>
        </div>
        <div className="settings-body">
          <button className="icon-btn settings-close" onClick={props.onClose} aria-label={t('close')} title={t('close')}>
            <Icon name="close" />
          </button>

          {section === 'voice' && (
            <>
              <h2>{t('devices')}</h2>
              <label className="field">
                {t('microphone')}
                <select value={voice.settings.inputId} onChange={(event) => void engine.updateSettings({ inputId: event.target.value })}>
                  {voice.inputs.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || t('microphone')}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                {t('output')}
                <select value={voice.settings.outputId} onChange={(event) => void engine.updateSettings({ outputId: event.target.value })}>
                  {voice.outputs.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || t('output')}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                {t('outputVolume')}
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(voice.settings.outputVolume * 100)}
                  onChange={(event) => void engine.updateSettings({ outputVolume: Number(event.target.value) / 100 })}
                />
              </label>
              <button className={voice.testing ? 'toggle on' : 'toggle'} onClick={() => engine.setTesting(!voice.testing)}>
                {voice.testing ? t('micTestStop') : t('micTest')}
              </button>

              <h2>{t('micActivation')}</h2>
              <Toggle
                label={t('gate')}
                hint={t('gateHint')}
                checked={voice.settings.gateEnabled}
                onChange={(gateEnabled) => void engine.updateSettings({ gateEnabled })}
              />
              <div className="threshold">
                <ThresholdMeter engine={engine} sending={props.sending} />
                <input
                  type="range"
                  min={GATE_MIN_DB}
                  max={GATE_MAX_DB}
                  value={voice.settings.gateThresholdDb}
                  disabled={!voice.settings.gateEnabled}
                  aria-label={t('gateThreshold')}
                  onChange={(event) => void engine.updateSettings({ gateThresholdDb: Number(event.target.value) })}
                />
                <span className="muted small">
                  {voice.settings.gateEnabled ? `${t('gateThreshold')} ${voice.settings.gateThresholdDb} dB` : t('gateOff')}
                </span>
              </div>
              <PushToTalk
                enabled={voice.settings.pttEnabled}
                binding={voice.settings.pttBinding}
                failed={props.pttFailed}
                onChange={(patch) => void engine.updateSettings(patch)}
              />

              <h2>{t('processing')}</h2>
              <Toggle
                label={t('enhancedSuppression')}
                hint={t('enhancedHint')}
                checked={voice.settings.enhancedSuppression}
                onChange={(enhancedSuppression) => void engine.updateSettings({ enhancedSuppression })}
              />
              <Toggle
                label={t('noiseSuppression')}
                checked={voice.settings.noiseSuppression || voice.settings.enhancedSuppression}
                disabled={voice.settings.enhancedSuppression}
                onChange={(noiseSuppression) => void engine.updateSettings({ noiseSuppression })}
              />
              <Toggle
                label={t('echoCancellation')}
                hint={t('echoHint')}
                checked={voice.settings.echoCancellation}
                onChange={(echoCancellation) => void engine.updateSettings({ echoCancellation })}
              />
              <Toggle
                label={t('autoGain')}
                checked={voice.settings.autoGainControl}
                onChange={(autoGainControl) => void engine.updateSettings({ autoGainControl })}
              />
            </>
          )}

          {section === 'app' && (
            <>
              <h2>{t('settingsApp')}</h2>
              {app.store ? (
                <label className="field">
                  {t('autostartStore')}
                  <button onClick={() => window.duo.openStartupSettings()}>{t('autostartOpen')}</button>
                </label>
              ) : (
                <Toggle
                  label={t('autostart')}
                  checked={app.autostart}
                  onChange={(enabled) => void window.duo.setAutostart(enabled).then(setApp)}
                />
              )}
              <Toggle label={t('showStats')} checked={props.showStats} onChange={props.setShowStats} />
              <label className="field">
                {t('closeSetting')}
                <select
                  value={app.closeAction}
                  onChange={(event) => void window.duo.setCloseAction(event.target.value as CloseAction).then(setApp)}
                >
                  <option value="ask">{t('closeAsk')}</option>
                  <option value="tray">{t('closeToTray')}</option>
                  <option value="quit">{t('closeQuit')}</option>
                </select>
              </label>
              <div className="row wrap">
                <button onClick={props.onChangeName}>{t('changeName')}</button>
                <button onClick={props.onChangeRole}>{t('changeRole')}</button>
              </div>
            </>
          )}

          {section === 'host' && isHost && (
            <>
              <h2>{t('settingsHost')}</h2>
              <AccessCode code={app.code} />
              <Storage app={app} onChange={setApp} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Brand() {
  return <div className="brand" aria-hidden />
}

function NameForm({ onSubmit }: { onSubmit: (name: string) => void }) {
  const [value, setValue] = useState('')
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const name = value.trim().slice(0, 32)
    if (!name) return
    localStorage.setItem('duo.name', name)
    onSubmit(name)
  }
  return (
    <form className="screen center" onSubmit={submit}>
      <Brand />
      <h1>{t('welcome')}</h1>
      <p className="muted">{t('askName')}</p>
      <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} placeholder={t('namePlaceholder')} />
      <button className="primary" type="submit">
        {t('continue')}
      </button>
    </form>
  )
}

function CodeForm(props: { error: string | null; onSubmit: (code: string) => void; onBack: () => void }) {
  const [value, setValue] = useState('')
  const code = normalizeCode(value).slice(0, CODE_LENGTH)
  return (
    <form
      className="screen center"
      onSubmit={(event) => {
        event.preventDefault()
        if (code.length === CODE_LENGTH) props.onSubmit(code)
      }}
    >
      <Brand />
      <h1>{t('codeTitle')}</h1>
      <p className="muted">{t('codeHint')}</p>
      {props.error && <div className="error">{props.error}</div>}
      <input
        autoFocus
        className="code-input"
        value={code}
        onChange={(event) => setValue(event.target.value)}
        aria-label={t('codeTitle')}
        spellCheck={false}
      />
      <button className="primary" type="submit" disabled={code.length !== CODE_LENGTH}>
        {t('connect')}
      </button>
      <button className="ghost" type="button" onClick={props.onBack}>
        {t('back')}
      </button>
    </form>
  )
}

/** Push-to-talk switch and the key it uses. Turning it on without a key asks for one first. */
function PushToTalk(props: {
  enabled: boolean
  binding: PttBinding | null
  failed: boolean
  onChange: (patch: { pttEnabled?: boolean; pttBinding?: PttBinding }) => void
}) {
  const [capturing, setCapturing] = useState(false)

  useEffect(() => {
    if (!capturing) return
    const pick = (binding: PttBinding | null): void => {
      setCapturing(false)
      if (binding) props.onChange({ pttBinding: binding, pttEnabled: true })
    }
    const onKey = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.code === 'Escape') return setCapturing(false)
      const binding = bindingFromKey(event)
      if (binding) pick(binding)
    }
    const onMouse = (event: MouseEvent): void => {
      const binding = bindingFromMouse(event.button)
      if (!binding) return setCapturing(false)
      event.preventDefault()
      pick(binding)
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onMouse, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onMouse, true)
    }
  }, [capturing]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="storage">
      <Toggle
        label={t('ptt')}
        hint={t('pttHint')}
        checked={props.enabled}
        onChange={(enabled) => {
          if (enabled && !props.binding) setCapturing(true)
          else props.onChange({ pttEnabled: enabled })
        }}
      />
      {(props.enabled || capturing) && (
        <button className={capturing ? 'toggle on-accent' : 'toggle'} onClick={() => setCapturing((value) => !value)}>
          {capturing ? t('pttPress') : t('pttKey', { key: props.binding?.label ?? '—' })}
        </button>
      )}
      {props.failed && <span className="small warn">{t('pttUnavailable')}</span>}
    </div>
  )
}

/** Host only: where the shared data lives, and its daily copy. */
function Storage({ app, onChange }: { app: AppState; onChange: (state: AppState) => void }) {
  const [busy, setBusy] = useState(false)
  const run = (action: () => Promise<AppState>): void => {
    setBusy(true)
    void action()
      .then(onChange)
      .finally(() => setBusy(false))
  }
  const last = app.lastBackup
  const status = !last
    ? t('backupNever')
    : last.error
      ? t('backupFailed', { error: last.error })
      : t('backupLast', { date: new Date(last.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) })
  return (
    <div className="storage">
      <span className="muted small">{t('dataFolder')}</span>
      <div className="row">
        <code className="path">{app.dataDir}</code>
        <button disabled={busy} onClick={() => run(window.duo.chooseDataDir)}>
          {t('change')}
        </button>
      </div>
      <span className="muted small">
        {t('backup')} — {t('backupHint')}
      </span>
      {app.backupDir ? (
        <>
          <div className="row">
            <code className="path">{app.backupDir}</code>
            <button disabled={busy} onClick={() => run(window.duo.chooseBackupDir)}>
              {t('change')}
            </button>
          </div>
          <span className={last?.error ? 'small warn' : 'muted small'}>{status}</span>
          <div className="row">
            <button disabled={busy} onClick={() => run(window.duo.backupNow)}>
              {t('backupNow')}
            </button>
            <button className="ghost" disabled={busy} onClick={() => run(window.duo.disableBackup)}>
              {t('backupDisable')}
            </button>
          </div>
        </>
      ) : (
        <button disabled={busy} onClick={() => run(window.duo.chooseBackupDir)}>
          {t('backupChoose')}
        </button>
      )}
    </div>
  )
}

function AccessCode({ code }: { code: string }) {
  return (
    <div className="access-code">
      <span className="muted small">{t('shareCode')}</span>
      <code>{code}</code>
    </div>
  )
}

function Person(props: { name: string; self?: boolean; level: number; muted: boolean; deafened: boolean; note?: string }) {
  const speaking = props.level > 0.08 && !props.muted
  return (
    <div className="person">
      <Avatar name={props.name} speaking={speaking} />
      <div className="who">
        <strong>
          {props.name}
          {props.self && <span className="muted"> ({t('you')})</span>}
        </strong>
        {props.note && <span className="muted small">{props.note}</span>}
      </div>
      {props.muted && (
        <span className="flag" title={t('micOff')}>
          <Icon name="micOff" size={16} />
        </span>
      )}
      {props.deafened && (
        <span className="flag" title={t('soundOff')}>
          <Icon name="headphonesOff" size={16} />
        </span>
      )}
    </div>
  )
}

const CONNECTION_NOTE: Partial<Record<RTCPeerConnectionState, MessageKey>> = {
  new: 'linkConnecting',
  connecting: 'linkConnecting',
  disconnected: 'linkUnstable',
  failed: 'linkLost'
}

// Sound levels change many times a second. Only these small components follow them, so the
// rest of the window is not redrawn each time.
const useLevels = (engine: VoiceEngine): Levels => useSyncExternalStore(engine.subscribeLevels, engine.getLevels)

function SelfPerson(props: { engine: VoiceEngine; name: string; silent: boolean; muted: boolean; deafened: boolean }) {
  const { micDb } = useLevels(props.engine)
  return <Person self name={props.name} level={props.silent ? 0 : dbToLevel(micDb)} muted={props.muted} deafened={props.deafened} />
}

function ThresholdMeter({ engine, sending }: { engine: VoiceEngine; sending: boolean }) {
  const { micDb } = useLevels(engine)
  return (
    <div className="threshold-meter" aria-hidden>
      <div className={sending ? 'fill' : 'fill closed'} style={{ transform: `scaleX(${dbToLevel(micDb)})` }} />
    </div>
  )
}

function PeerLevel({ peer, engine, note }: { peer: PeerView; engine: VoiceEngine; note?: string }) {
  const level = useLevels(engine).peers[peer.id] ?? 0
  return <Person name={peer.name} level={level} muted={peer.muted} deafened={peer.deafened} note={note} />
}

function PeerRow({ peer, engine, showStats }: { peer: PeerView; engine: VoiceEngine; showStats: boolean }) {
  const note = CONNECTION_NOTE[peer.connection]
  return (
    <div className="peer">
      <PeerLevel peer={peer} engine={engine} note={note && t(note)} />
      <label className="volume" title={t('volume')}>
        <Icon name="voice" size={16} />
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(peer.volume * 100)}
          onChange={(event) => engine.setPeerVolume(peer.id, Number(event.target.value) / 100)}
        />
      </label>
      {showStats && <Stats stats={peer.stats} />}
    </div>
  )
}

const fmt = (value: number | null, digits = 0, unit = ''): string =>
  value === null ? '—' : `${value.toFixed(digits)}${unit}`

function Stats({ stats }: { stats: PeerStats }) {
  // One-way network trip plus receive buffer. Sound card and headset are not included.
  const delay = stats.rttMs !== null && stats.bufferMs !== null ? stats.rttMs / 2 + stats.bufferMs : null
  return (
    <dl className="stats">
      <dt>{t('statDelay')}</dt>
      <dd>{fmt(delay, 0, ' ms')}</dd>
      <dt>{t('statRtt')}</dt>
      <dd>{fmt(stats.rttMs, 1, ' ms')}</dd>
      <dt>{t('statBuffer')}</dt>
      <dd>{fmt(stats.bufferMs, 0, ' ms')}</dd>
      <dt>{t('statJitter')}</dt>
      <dd>{fmt(stats.jitterMs, 1, ' ms')}</dd>
      <dt>{t('statLoss')}</dt>
      <dd>{fmt(stats.lossPct, 1, ' %')}</dd>
      <dt>{t('statFrames')}</dt>
      <dd>{fmt(stats.frameMs, 0, ' ms')}</dd>
      <dt>{t('statBitrate')}</dt>
      <dd>{fmt(stats.sendKbps, 0, ' kb/s')}</dd>
      <dt>{t('statLink')}</dt>
      <dd>{stats.route === 'host ↔ host' ? t('direct') : (stats.route ?? '—')}</dd>
    </dl>
  )
}

function Toggle(props: {
  label: string
  hint?: string
  checked: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className="check">
      <span>
        {props.label}
        {props.hint && <span className="muted small hint">{props.hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
    </label>
  )
}
