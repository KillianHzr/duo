import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type PeerInfo,
  type RejectReason,
  type ServerMessage,
  type SignalData
} from '../../shared/protocol'
import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor'
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'
import type { PttBinding } from '../../shared/keys'
import { tuneOpus } from './sdp'

export interface VoiceSettings {
  inputId: string
  outputId: string
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
  /** RNNoise: removes more noise (clicks, breathing, fans) but adds a little delay. */
  enhancedSuppression: boolean
  /** Sensitivity gate: nothing is sent while the microphone stays under the threshold. */
  gateEnabled: boolean
  /** Gate threshold in dBFS, from -80 (lets everything through) to -10. */
  gateThresholdDb: number
  /** Master volume for everyone else, 0 to 1. */
  outputVolume: number
  /** Push-to-talk: nothing is sent unless the chosen key is held down. */
  pttEnabled: boolean
  pttBinding: PttBinding | null
}

export const DEFAULT_SETTINGS: VoiceSettings = {
  inputId: 'default',
  outputId: 'default',
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  enhancedSuppression: false,
  gateEnabled: false,
  gateThresholdDb: -45,
  outputVolume: 1,
  pttEnabled: false,
  pttBinding: null
}

/** The microphone stays open this long after the push-to-talk key is released, so word endings are not cut. */
const PTT_RELEASE_MS = 200

export const SILENCE_DB = -100

export interface PeerStats {
  /** Network round trip, in ms. */
  rttMs: number | null
  /** Variation in packet arrival time, in ms. */
  jitterMs: number | null
  /** Average time spent in the receive buffer, in ms. */
  bufferMs: number | null
  /** Packets lost over the last second, in %. */
  lossPct: number | null
  /** Audio rebuilt because a packet was missing, over the last second, in %. */
  concealedPct: number | null
  /** Length of the frames we send, in ms (10 expected). */
  frameMs: number | null
  /** Audio bitrate sent, in kb/s. */
  sendKbps: number | null
  /** Sound energy received over the last second (0 means pure silence). */
  energy: number | null
  /** 'host' on both sides means a direct link on the local network. */
  route: string | null
  codec: string | null
}

export interface PeerView extends PeerInfo {
  connection: RTCPeerConnectionState
  volume: number
  level: number
  stats: PeerStats
}

export type Status = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export type VoiceError = { kind: 'microphone'; detail: string } | { kind: 'rejected'; reason: RejectReason }

export interface VoiceSnapshot {
  status: Status
  error: VoiceError | null
  selfId: string | null
  muted: boolean
  deafened: boolean
  /** Microphone level in dBFS, after noise suppression (SILENCE_DB when unknown). */
  micDb: number
  /** False while the sensitivity gate is holding the microphone shut. */
  gateOpen: boolean
  /** True while the user is listening to their own microphone. */
  testing: boolean
  /** True while the push-to-talk key is held (or was just released). */
  pttDown: boolean
  peers: PeerView[]
  inputs: MediaDeviceInfo[]
  outputs: MediaDeviceInfo[]
  settings: VoiceSettings
}

interface Counters {
  at: number
  packetsLost: number
  packetsReceived: number
  jitterBufferDelay: number
  jitterBufferEmittedCount: number
  concealedSamples: number
  totalSamplesReceived: number
  packetsSent: number
  bytesSent: number
  audioEnergy: number
}

interface Peer {
  info: PeerInfo
  pc: RTCPeerConnection
  /** Only one side ever makes offers, which rules out collisions. */
  offerer: boolean
  audio: HTMLAudioElement
  pendingCandidates: RTCIceCandidateInit[]
  remoteReady: boolean
  volume: number
  level: number
  stats: PeerStats
  counters: Counters | null
}

const EMPTY_STATS: PeerStats = {
  rttMs: null,
  jitterMs: null,
  bufferMs: null,
  lossPct: null,
  concealedPct: null,
  frameMs: null,
  sendKbps: null,
  energy: null,
  route: null,
  codec: null
}

const LEVEL_INTERVAL_MS = 150
const STATS_EVERY_N_TICKS = 7 // ≈ 1 s

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }
type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
type TunableReceiver = RTCRtpReceiver & { jitterBufferTarget?: number | null; playoutDelayHint?: number }

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export class VoiceEngine {
  private listeners = new Set<() => void>()
  private snapshot: VoiceSnapshot
  private ws: WebSocket | null = null
  private url = ''
  private name = ''
  private code = ''
  private wanted = false
  private reconnectTimer: number | null = null
  private reconnectDelay = 500
  private selfId: string | null = null
  private status: Status = 'idle'
  private error: VoiceError | null = null
  private muted = false
  private deafened = false
  private micDb = SILENCE_DB
  private gateOpen = true
  private testing = false
  private pttDown = false
  private pttTimer: number | null = null
  private settings: VoiceSettings
  /** Raw microphone capture. */
  private stream: MediaStream | null = null
  /** What peers receive: the raw track, or the RNNoise output when enhanced suppression is on. */
  private sendTrack: MediaStreamTrack | null = null
  private sendStream: MediaStream | null = null
  private peers = new Map<string, Peer>()
  private inputs: MediaDeviceInfo[] = []
  private outputs: MediaDeviceInfo[] = []
  private ticker: number | null = null
  private tick = 0
  private audioContext: AudioContext | null = null
  private contextReady: Promise<AudioContext> | null = null
  private rnnoiseBinary: Promise<ArrayBuffer> | null = null
  /** Nodes of the current microphone graph, torn down whenever the microphone changes. */
  private graph: { nodes: AudioNode[]; gate: AudioWorkletNode; monitor: GainNode; rnnoise: RnnoiseWorkletNode | null } | null =
    null

  /** The chat and the notes travel over the same connection: they get every message from the host. */
  onServerMessage: ((message: ServerMessage) => void) | null = null
  onDisconnected: (() => void) | null = null

  /** HTTP address of the host we are connected to (media files are fetched from it). */
  httpBase(): string {
    return this.url.replace(/^ws/, 'http').replace(/\/+$/, '')
  }

  sendToServer(message: ClientMessage): void {
    this.send(message)
  }

  constructor(settings: VoiceSettings) {
    this.settings = { ...settings }
    this.snapshot = this.buildSnapshot()
    navigator.mediaDevices.addEventListener('devicechange', () => void this.refreshDevices())
    document.addEventListener('visibilitychange', () => this.updateTicker())
  }

  // ----- Subscription (useSyncExternalStore) -----

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): VoiceSnapshot => this.snapshot

  /** Rebuilds and returns the current state (used by the automated test). */
  refresh(): VoiceSnapshot {
    this.emit()
    return this.snapshot
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot()
    for (const listener of this.listeners) listener()
  }

  private buildSnapshot(): VoiceSnapshot {
    return {
      status: this.status,
      error: this.error,
      selfId: this.selfId,
      muted: this.muted,
      deafened: this.deafened,
      micDb: this.micDb,
      gateOpen: this.gateOpen,
      testing: this.testing,
      pttDown: this.pttDown,
      peers: [...this.peers.values()].map((p) => ({
        ...p.info,
        connection: p.pc.connectionState,
        volume: p.volume,
        level: p.level,
        stats: p.stats
      })),
      inputs: this.inputs,
      outputs: this.outputs,
      settings: this.settings
    }
  }

  // ----- Lifecycle -----

  async start(url: string, name: string, code: string): Promise<void> {
    this.url = url
    this.name = name
    this.code = code
    this.wanted = true
    this.status = 'connecting'
    this.error = null
    this.emit()
    try {
      await this.acquireMic()
    } catch (err) {
      this.wanted = false
      this.status = 'error'
      this.error = { kind: 'microphone', detail: describe(err) }
      this.emit()
      return
    }
    // stop() may have been called while the microphone was opening.
    if (!this.wanted) {
      this.releaseMic()
      return
    }
    await this.refreshDevices()
    this.openSocket()
    this.updateTicker()
  }

  stop(): void {
    this.wanted = false
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.ws?.close()
    this.ws = null
    this.dropAllPeers()
    this.releaseMic()
    this.status = 'idle'
    this.error = null
    this.selfId = null
    this.updateTicker()
    this.emit()
  }

  // ----- Microphone -----

  private releaseMic(): void {
    this.teardownGraph()
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.sendTrack?.stop()
    this.sendTrack = null
    this.sendStream = null
    this.testing = false
    this.micDb = SILENCE_DB
    this.gateOpen = true
    if (this.audioContext?.state === 'running') void this.audioContext.suspend()
  }

  /** One 48 kHz context for the whole app, with the gate worklet loaded. */
  private ensureContext(): Promise<AudioContext> {
    this.contextReady ??= (async () => {
      const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
      await context.audioWorklet.addModule(new URL('gate-processor.js', document.baseURI).href)
      this.audioContext = context
      this.applyContextSink()
      return context
    })()
    return this.contextReady.then(async (context) => {
      if (context.state === 'suspended') await context.resume()
      return context
    })
  }

  private async createRnnoise(context: AudioContext): Promise<RnnoiseWorkletNode> {
    this.rnnoiseBinary ??= (async () => {
      await context.audioWorklet.addModule(rnnoiseWorkletUrl)
      return loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl })
    })()
    return new RnnoiseWorkletNode(context, { maxChannels: 1, wasmBinary: await this.rnnoiseBinary })
  }

  private teardownGraph(): void {
    if (!this.graph) return
    this.graph.gate.port.onmessage = null
    this.graph.rnnoise?.destroy()
    for (const node of this.graph.nodes) node.disconnect()
    this.graph = null
  }

  /**
   * Builds the audio graph around the microphone:
   *   mic ─► [RNNoise] ─► gate (listens only) and monitor (mic test)
   * Without enhanced suppression the raw track is sent as is, so the graph adds no delay.
   * With it, peers receive the RNNoise output instead.
   */
  private async buildGraph(stream: MediaStream): Promise<MediaStreamTrack> {
    const context = await this.ensureContext()
    this.teardownGraph()

    const source = context.createMediaStreamSource(stream)
    const nodes: AudioNode[] = [source]
    let processed: AudioNode = source
    // A clone goes out to peers. Switching the original off would also silence the gate that
    // listens to it, and the gate could then never open again.
    let track = stream.getAudioTracks()[0].clone()
    let rnnoise: RnnoiseWorkletNode | null = null

    if (this.settings.enhancedSuppression) {
      try {
        rnnoise = await this.createRnnoise(context)
        const output = context.createMediaStreamDestination()
        output.channelCount = 1
        source.connect(rnnoise)
        rnnoise.connect(output)
        nodes.push(rnnoise, output)
        processed = rnnoise
        track.stop()
        track = output.stream.getAudioTracks()[0]
      } catch (err) {
        // Never lose the microphone over an optional filter: fall back to the raw track.
        console.error('enhanced noise suppression unavailable', err)
        rnnoise = null
      }
    }

    const gate = new AudioWorkletNode(context, 'duo-gate', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit'
    })
    // The gate outputs nothing; routing it to a silent gain just keeps it processing.
    const silent = context.createGain()
    silent.gain.value = 0
    const monitor = context.createGain()
    monitor.gain.value = 0
    processed.connect(gate)
    gate.connect(silent)
    silent.connect(context.destination)
    processed.connect(monitor)
    monitor.connect(context.destination)
    nodes.push(gate, silent, monitor)

    gate.port.onmessage = (event: MessageEvent<{ open?: boolean; level?: number }>) => {
      if (typeof event.data.open === 'boolean') {
        this.gateOpen = event.data.open
        this.applySendState()
      }
      if (typeof event.data.level === 'number') this.micDb = event.data.level
      this.emit()
    }

    this.graph = { nodes, gate, monitor, rnnoise }
    this.gateOpen = true
    this.configureGate()
    return track
  }

  private configureGate(): void {
    this.graph?.gate.port.postMessage({
      enabled: this.settings.gateEnabled,
      threshold: this.settings.gateThresholdDb,
      meter: this.wanted && document.visibilityState === 'visible'
    })
    if (!this.settings.gateEnabled) this.gateOpen = true
  }

  /** The outgoing track carries sound only when unmuted and the gate is open. */
  private applySendState(): void {
    const talking = !this.settings.pttEnabled || this.pttDown
    const open = talking && (!this.settings.gateEnabled || this.gateOpen)
    if (this.sendTrack) this.sendTrack.enabled = !this.muted && open
    if (this.graph) this.graph.monitor.gain.value = this.testing && open ? 1 : 0
  }

  /** Called when the push-to-talk key goes down or up. */
  setPttDown(down: boolean): void {
    if (this.pttTimer !== null) window.clearTimeout(this.pttTimer)
    this.pttTimer = null
    if (down) {
      this.pttDown = true
    } else if (this.pttDown) {
      this.pttTimer = window.setTimeout(() => {
        this.pttTimer = null
        this.pttDown = false
        this.applySendState()
        this.emit()
      }, PTT_RELEASE_MS)
      return
    }
    this.applySendState()
    this.emit()
  }

  /** Lets the user hear their own microphone, exactly as others would. */
  setTesting(testing: boolean): void {
    this.testing = testing && this.graph !== null
    this.applySendState()
    this.emit()
  }

  private applyContextSink(): void {
    const context = this.audioContext as SinkContext | null
    const id = this.settings.outputId
    context?.setSinkId?.(id === 'default' ? '' : id).catch(() => {
      /* output unplugged: stay on the default one */
    })
  }

  private async acquireMic(): Promise<void> {
    const { inputId, echoCancellation, autoGainControl } = this.settings
    // RNNoise replaces the built-in suppression; running both only degrades the voice.
    const noiseSuppression = this.settings.noiseSuppression && !this.settings.enhancedSuppression
    const audio: MediaTrackConstraints = {
      echoCancellation,
      noiseSuppression,
      autoGainControl,
      channelCount: 1,
      sampleRate: 48000
    }
    if (inputId && inputId !== 'default') audio.deviceId = { exact: inputId }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio, video: false })
    } catch (err) {
      // The remembered microphone may have been unplugged: fall back to the default one.
      if (!audio.deviceId) throw err
      delete audio.deviceId
      this.settings = { ...this.settings, inputId: 'default' }
      stream = await navigator.mediaDevices.getUserMedia({ audio, video: false })
    }

    const previous = this.stream
    const previousSend = this.sendTrack
    this.stream = stream
    const track = await this.buildGraph(stream)
    track.contentHint = 'speech'
    this.sendTrack = track
    this.sendStream = new MediaStream([track])
    this.applySendState()

    await Promise.all(
      [...this.peers.values()].map(async (peer) => {
        const sender = peer.pc.getSenders().find((s) => s.track?.kind === 'audio' || s.track === null)
        if (sender) await sender.replaceTrack(track)
      })
    )
    previous?.getTracks().forEach((t) => t.stop())
    previousSend?.stop()
  }

  async updateSettings(patch: Partial<VoiceSettings>): Promise<void> {
    const before = this.settings
    this.settings = { ...before, ...patch }
    this.emit()

    if (patch.outputId !== undefined && patch.outputId !== before.outputId) {
      for (const peer of this.peers.values()) this.applySink(peer.audio)
      this.applyContextSink()
    }
    if (patch.outputVolume !== undefined) {
      for (const peer of this.peers.values()) this.applyVolume(peer)
    }
    if (patch.pttEnabled !== undefined) this.applySendState()
    if (patch.gateEnabled !== undefined || patch.gateThresholdDb !== undefined) {
      this.configureGate()
      this.applySendState()
    }
    const micChanged =
      this.settings.inputId !== before.inputId ||
      this.settings.echoCancellation !== before.echoCancellation ||
      this.settings.noiseSuppression !== before.noiseSuppression ||
      this.settings.autoGainControl !== before.autoGainControl ||
      this.settings.enhancedSuppression !== before.enhancedSuppression
    if (micChanged && this.stream) {
      try {
        await this.acquireMic()
      } catch (err) {
        this.error = { kind: 'microphone', detail: describe(err) }
      }
      this.emit()
    }
  }

  private async refreshDevices(): Promise<void> {
    const devices = await navigator.mediaDevices.enumerateDevices()
    this.inputs = devices.filter((d) => d.kind === 'audioinput')
    this.outputs = devices.filter((d) => d.kind === 'audiooutput')
    this.emit()
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    this.applySendState()
    this.sendState()
    this.emit()
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened
    for (const peer of this.peers.values()) peer.audio.muted = deafened
    this.sendState()
    this.emit()
  }

  setPeerVolume(id: string, volume: number): void {
    const peer = this.peers.get(id)
    if (!peer) return
    peer.volume = Math.max(0, Math.min(1, volume))
    this.applyVolume(peer)
    this.emit()
  }

  private applyVolume(peer: Peer): void {
    peer.audio.volume = Math.max(0, Math.min(1, peer.volume * this.settings.outputVolume))
  }

  private applySink(audio: HTMLAudioElement): void {
    const id = this.settings.outputId
    const sink = audio as SinkAudio
    if (!sink.setSinkId) return
    sink.setSinkId(id === 'default' ? '' : id).catch(() => {
      /* output unplugged: stay on the default one */
    })
  }

  // ----- Signaling -----

  private send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message))
  }

  private sendState(): void {
    this.send({ type: 'state', muted: this.muted, deafened: this.deafened })
  }

  private openSocket(): void {
    const ws = new WebSocket(this.url)
    this.ws = ws

    ws.onopen = () => {
      this.send({ type: 'hello', name: this.name, code: this.code, protocol: PROTOCOL_VERSION })
    }

    ws.onmessage = (event) => {
      let message: ServerMessage
      try {
        message = JSON.parse(String(event.data)) as ServerMessage
      } catch {
        return
      }
      void this.handleMessage(message)
      this.onServerMessage?.(message)
    }

    ws.onclose = () => {
      // A socket replaced by a newer one must not make the chat believe the new one dropped.
      if (this.ws === ws || this.ws === null) this.onDisconnected?.()
      if (this.ws !== ws) return
      this.ws = null
      this.selfId = null
      this.dropAllPeers()
      if (!this.wanted) return
      this.status = 'reconnecting'
      this.emit()
      this.reconnectTimer = window.setTimeout(() => this.openSocket(), this.reconnectDelay)
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 4000)
    }

    ws.onerror = () => ws.close()
  }

  private async handleMessage(message: ServerMessage): Promise<void> {
    switch (message.type) {
      case 'welcome':
        this.selfId = message.id
        this.status = 'connected'
        this.error = null
        this.reconnectDelay = 500
        for (const info of message.peers) this.addPeer(info)
        this.sendState()
        break
      case 'rejected':
        // Retrying with the same code or version cannot succeed: stop and let the UI ask.
        this.wanted = false
        this.status = 'error'
        this.error = { kind: 'rejected', reason: message.reason }
        this.releaseMic()
        this.updateTicker()
        break
      case 'peer-joined':
        this.addPeer(message.peer)
        break
      case 'peer-left':
        this.dropPeer(message.id)
        break
      case 'peer-state': {
        const peer = this.peers.get(message.id)
        if (peer) peer.info = { ...peer.info, muted: message.muted, deafened: message.deafened }
        break
      }
      case 'signal':
        await this.handleSignal(message.from, message.data)
        break
    }
    this.emit()
  }

  // ----- WebRTC -----

  private addPeer(info: PeerInfo): void {
    if (!this.selfId || this.peers.has(info.id)) return

    // Local network only: no STUN/TURN server, both computers talk to each other directly.
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' })
    const audio = new Audio()
    audio.autoplay = true
    audio.muted = this.deafened
    audio.volume = this.settings.outputVolume
    this.applySink(audio)

    const peer: Peer = {
      info,
      pc,
      offerer: this.selfId < info.id,
      audio,
      pendingCandidates: [],
      remoteReady: false,
      volume: 1,
      level: 0,
      stats: EMPTY_STATS,
      counters: null
    }
    this.peers.set(info.id, peer)

    if (this.sendTrack && this.sendStream) pc.addTrack(this.sendTrack, this.sendStream)

    pc.onicecandidate = (event) => {
      this.signal(info.id, { kind: 'candidate', candidate: event.candidate ? { ...event.candidate.toJSON() } : null })
    }

    pc.ontrack = (event) => {
      // Receive buffer at its minimum: it only grows when the network requires it.
      const receiver = event.receiver as TunableReceiver
      if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0
      if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = 0
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track])
      void audio.play().catch(() => {
        /* retried on the next ontrack */
      })
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && peer.offerer) pc.restartIce()
      this.emit()
    }

    pc.onnegotiationneeded = () => {
      if (peer.offerer) void this.makeOffer(peer)
    }
  }

  private signal(to: string, data: SignalData): void {
    this.send({ type: 'signal', to, data })
  }

  private async makeOffer(peer: Peer): Promise<void> {
    try {
      const offer = await peer.pc.createOffer()
      if (peer.pc.signalingState !== 'stable') return
      await peer.pc.setLocalDescription(offer)
      this.signal(peer.info.id, { kind: 'description', description: { type: 'offer', sdp: offer.sdp ?? '' } })
    } catch (err) {
      console.error('could not create offer', err)
    }
  }

  private async handleSignal(from: string, data: SignalData): Promise<void> {
    const peer = this.peers.get(from)
    if (!peer) return
    const { pc } = peer
    try {
      if (data.kind === 'description') {
        const description = { type: data.description.type, sdp: tuneOpus(data.description.sdp) }
        await pc.setRemoteDescription(description)
        peer.remoteReady = true
        for (const candidate of peer.pendingCandidates.splice(0)) await pc.addIceCandidate(candidate)
        if (description.type === 'offer') {
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          this.signal(from, { kind: 'description', description: { type: 'answer', sdp: answer.sdp ?? '' } })
        }
      } else if (data.candidate) {
        const candidate = data.candidate as RTCIceCandidateInit
        if (peer.remoteReady) await pc.addIceCandidate(candidate)
        else peer.pendingCandidates.push(candidate)
      }
    } catch (err) {
      console.error('signal rejected', err)
    }
  }

  private dropPeer(id: string): void {
    const peer = this.peers.get(id)
    if (!peer) return
    peer.pc.onconnectionstatechange = null
    peer.pc.close()
    peer.audio.srcObject = null
    this.peers.delete(id)
  }

  private dropAllPeers(): void {
    for (const id of [...this.peers.keys()]) this.dropPeer(id)
  }

  // ----- Levels and statistics (only while the window is visible) -----

  /**
   * Level meters and statistics only run while the window is shown. The gate itself
   * keeps working in the background: it lives on the audio thread.
   */
  private updateTicker(): void {
    const shouldRun = this.wanted && document.visibilityState === 'visible'
    this.configureGate()
    if (shouldRun && this.ticker === null) {
      this.ticker = window.setInterval(() => void this.onTick(), LEVEL_INTERVAL_MS)
    } else if (!shouldRun && this.ticker !== null) {
      window.clearInterval(this.ticker)
      this.ticker = null
      this.micDb = SILENCE_DB
    }
  }

  private async onTick(): Promise<void> {
    this.tick++
    await this.collectStats(this.tick % STATS_EVERY_N_TICKS === 0)
    this.emit()
  }

  /** Reads levels; with `full`, also computes network figures over the elapsed interval. */
  private async collectStats(full: boolean): Promise<void> {
    for (const peer of this.peers.values()) {
      if (peer.pc.connectionState !== 'connected') {
        peer.level = 0
        continue
      }
      const report = await peer.pc.getStats()
      type Stat = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
      let inbound: Stat | undefined
      let outbound: Stat | undefined
      let pair: Stat | undefined
      const byId = new Map<string, Stat>()
      report.forEach((stat: Stat) => {
        byId.set(stat.id, stat)
        if (stat.type === 'inbound-rtp' && stat.kind === 'audio') inbound = stat
        else if (stat.type === 'outbound-rtp' && stat.kind === 'audio') outbound = stat
        else if (stat.type === 'candidate-pair' && stat.nominated && stat.state === 'succeeded') pair = stat
      })
      peer.level = Math.min(1, (inbound?.audioLevel ?? 0) * 4)
      if (!full || !inbound || !outbound) continue

      const now: Counters = {
        at: performance.now(),
        packetsLost: inbound.packetsLost ?? 0,
        packetsReceived: inbound.packetsReceived ?? 0,
        jitterBufferDelay: inbound.jitterBufferDelay ?? 0,
        jitterBufferEmittedCount: inbound.jitterBufferEmittedCount ?? 0,
        concealedSamples: inbound.concealedSamples ?? 0,
        totalSamplesReceived: inbound.totalSamplesReceived ?? 0,
        packetsSent: outbound.packetsSent ?? 0,
        bytesSent: outbound.bytesSent ?? 0,
        audioEnergy: inbound.totalAudioEnergy ?? 0
      }
      const prev = peer.counters
      peer.counters = now
      if (!prev) continue

      const seconds = (now.at - prev.at) / 1000
      const received = now.packetsReceived - prev.packetsReceived
      const lost = Math.max(0, now.packetsLost - prev.packetsLost)
      const emitted = now.jitterBufferEmittedCount - prev.jitterBufferEmittedCount
      const samples = now.totalSamplesReceived - prev.totalSamplesReceived
      const sent = now.packetsSent - prev.packetsSent
      const local = pair ? byId.get(pair.localCandidateId) : undefined
      const remote = pair ? byId.get(pair.remoteCandidateId) : undefined
      const codec = inbound.codecId ? byId.get(inbound.codecId) : undefined

      peer.stats = {
        rttMs: pair?.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
        jitterMs: inbound.jitter != null ? inbound.jitter * 1000 : null,
        bufferMs: emitted > 0 ? ((now.jitterBufferDelay - prev.jitterBufferDelay) / emitted) * 1000 : null,
        lossPct: received + lost > 0 ? (lost / (received + lost)) * 100 : null,
        concealedPct: samples > 0 ? ((now.concealedSamples - prev.concealedSamples) / samples) * 100 : null,
        frameMs: sent > 0 ? (seconds * 1000) / sent : null,
        sendKbps: seconds > 0 ? ((now.bytesSent - prev.bytesSent) * 8) / seconds / 1000 : null,
        energy: seconds > 0 ? (now.audioEnergy - prev.audioEnergy) / seconds : null,
        route: local && remote ? `${local.candidateType} ↔ ${remote.candidateType}` : null,
        codec: codec?.mimeType ? String(codec.mimeType).replace('audio/', '') : null
      }
    }
  }
}
