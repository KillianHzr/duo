import { useCallback, useEffect, useState, useSyncExternalStore, type FormEvent } from 'react'
import { CODE_LENGTH, DUO_PORT, normalizeCode } from '../../shared/protocol'
import type { AppState, CloseAction, UpdateStatus } from '../../preload/index'
import { t, type MessageKey } from './i18n'
import type { PeerStats, PeerView, VoiceEngine, VoiceError } from './voice'

const GATE_MIN_DB = -80
const GATE_MAX_DB = -10

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

export function App({ engine }: { engine: VoiceEngine }) {
  return (
    <>
      <Main engine={engine} />
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

function Main({ engine }: { engine: VoiceEngine }) {
  const voice = useSyncExternalStore(engine.subscribe, engine.getSnapshot)
  const [app, setApp] = useState<AppState | null>(null)
  const [name, setName] = useState(() => localStorage.getItem('duo.name') ?? '')
  const [notFound, setNotFound] = useState(false)
  const [manual, setManual] = useState(() => localStorage.getItem('duo.server') ?? '')
  const [showSettings, setShowSettings] = useState(false)
  const [showStats, setShowStats] = useState(false)
  const [update, setUpdate] = useState<UpdateStatus>({ ready: null })
  /** Bumped to force a new connection attempt even when nothing else changed. */
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    void window.duo.getState().then(setApp)
    void window.duo.getUpdateStatus().then(setUpdate)
    return window.duo.onUpdateStatus(setUpdate)
  }, [])

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
  const sending = !voice.settings.gateEnabled || voice.gateOpen

  const statusLabel: Record<typeof voice.status, string> = {
    idle: t('searching'),
    connecting: t('connecting'),
    connected: voice.peers.length ? t('inCall') : t('waiting'),
    reconnecting: t('reconnecting'),
    error: t('error')
  }

  return (
    <div className="screen">
      <header>
        <div>
          <h1>Duo</h1>
          <span className={`status ${voice.status}`}>{statusLabel[voice.status]}</span>
        </div>
        <button className="ghost" onClick={() => setShowSettings((v) => !v)} aria-pressed={showSettings}>
          {t('settings')}
        </button>
      </header>

      {update.ready && (
        <div className="notice">
          <span>{t('updateReady', { version: update.ready })}</span>
          <button onClick={() => window.duo.installUpdate()}>{t('restart')}</button>
        </div>
      )}
      {voice.error && <div className="error">{errorText(voice.error)}</div>}

      <section className="people">
        <Person
          name={`${name} (${t('you')})`}
          level={voice.muted || !sending ? 0 : dbToLevel(voice.micDb)}
          muted={voice.muted}
          deafened={voice.deafened}
        />
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

      {showSettings && (
        <section className="panel">
          {role === 'host' && <AccessCode code={code} />}
          <label>
            {t('microphone')}
            <select
              value={voice.settings.inputId}
              onChange={(event) => void engine.updateSettings({ inputId: event.target.value })}
            >
              {voice.inputs.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || t('microphone')}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('output')}
            <select
              value={voice.settings.outputId}
              onChange={(event) => void engine.updateSettings({ outputId: event.target.value })}
            >
              {voice.outputs.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || t('output')}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('outputVolume')}
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(voice.settings.outputVolume * 100)}
              onChange={(event) => void engine.updateSettings({ outputVolume: Number(event.target.value) / 100 })}
            />
          </label>

          <Toggle
            label={t('gate')}
            hint={t('gateHint')}
            checked={voice.settings.gateEnabled}
            onChange={(gateEnabled) => void engine.updateSettings({ gateEnabled })}
          />
          <div className="threshold">
            <div className="threshold-meter" aria-hidden>
              <div className={sending ? 'fill' : 'fill closed'} style={{ width: `${dbToLevel(voice.micDb) * 100}%` }} />
            </div>
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
          <button className={voice.testing ? 'toggle on' : 'toggle'} onClick={() => engine.setTesting(!voice.testing)}>
            {voice.testing ? t('micTestStop') : t('micTest')}
          </button>

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
          <Toggle label={t('showStats')} checked={showStats} onChange={setShowStats} />
          {!app.store && (
            <Toggle
              label={t('autostart')}
              checked={app.autostart}
              onChange={(enabled) => void window.duo.setAutostart(enabled).then(setApp)}
            />
          )}
          <label>
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
          <div className="row">
            <button
              className="ghost"
              onClick={() => {
                localStorage.removeItem('duo.name')
                setName('')
              }}
            >
              {t('changeName')}
            </button>
            <button className="ghost" onClick={changeRole}>
              {t('changeRole')}
            </button>
          </div>
          <span className="muted small">
            {t('version')} {app.version}
          </span>
        </section>
      )}

      <footer>
        <button
          className={voice.muted ? 'toggle on' : 'toggle'}
          onClick={() => engine.setMuted(!voice.muted)}
          aria-pressed={voice.muted}
        >
          {voice.muted ? t('muted') : t('mute')}
        </button>
        <button
          className={voice.deafened ? 'toggle on' : 'toggle'}
          onClick={() => engine.setDeafened(!voice.deafened)}
          aria-pressed={voice.deafened}
        >
          {voice.deafened ? t('deafened') : t('deafen')}
        </button>
      </footer>
    </div>
  )
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

function AccessCode({ code }: { code: string }) {
  return (
    <div className="access-code">
      <span className="muted small">{t('shareCode')}</span>
      <code>{code}</code>
    </div>
  )
}

function Person(props: { name: string; level: number; muted: boolean; deafened: boolean; note?: string }) {
  const speaking = props.level > 0.08 && !props.muted
  return (
    <div className="person">
      <div className={speaking ? 'avatar speaking' : 'avatar'}>{props.name.slice(0, 1).toUpperCase()}</div>
      <div className="who">
        <strong>{props.name}</strong>
        <span className="muted small">
          {[props.muted && t('micOff'), props.deafened && t('soundOff'), props.note].filter(Boolean).join(' · ') ||
            ' '}
        </span>
      </div>
      <div className="meter" aria-hidden>
        <div style={{ width: `${Math.round(props.level * 100)}%` }} />
      </div>
    </div>
  )
}

const CONNECTION_NOTE: Partial<Record<RTCPeerConnectionState, MessageKey>> = {
  new: 'linkConnecting',
  connecting: 'linkConnecting',
  disconnected: 'linkUnstable',
  failed: 'linkLost'
}

function PeerRow({ peer, engine, showStats }: { peer: PeerView; engine: VoiceEngine; showStats: boolean }) {
  const note = CONNECTION_NOTE[peer.connection]
  return (
    <div className="peer">
      <Person
        name={peer.name}
        level={peer.level}
        muted={peer.muted}
        deafened={peer.deafened}
        note={note && t(note)}
      />
      <label className="volume">
        <span className="small muted">{t('volume')}</span>
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
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span>
        {props.label}
        {props.hint && <span className="muted small"> — {props.hint}</span>}
      </span>
    </label>
  )
}
