import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type PeerInfo,
  type RejectReason,
  type ServerMessage,
  type SignalData
} from '../../shared/protocol'
import { tuneOpus } from './sdp'

export interface VoiceSettings {
  inputId: string
  outputId: string
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
}

export const DEFAULT_SETTINGS: VoiceSettings = {
  inputId: 'default',
  outputId: 'default',
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
}

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
  micLevel: number
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
  route: null,
  codec: null
}

const LEVEL_INTERVAL_MS = 150
const STATS_EVERY_N_TICKS = 7 // ≈ 1 s

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
  private micLevel = 0
  private settings: VoiceSettings
  private stream: MediaStream | null = null
  private peers = new Map<string, Peer>()
  private inputs: MediaDeviceInfo[] = []
  private outputs: MediaDeviceInfo[] = []
  private ticker: number | null = null
  private tick = 0
  private audioContext: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private analyserSource: MediaStreamAudioSourceNode | null = null
  private analyserData: Float32Array<ArrayBuffer> | null = null

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
      micLevel: this.micLevel,
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
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.detachAnalyser()
  }

  private async acquireMic(): Promise<void> {
    const { inputId, echoCancellation, noiseSuppression, autoGainControl } = this.settings
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

    const track = stream.getAudioTracks()[0]
    track.enabled = !this.muted
    track.contentHint = 'speech'

    const previous = this.stream
    this.stream = stream
    await Promise.all(
      [...this.peers.values()].map(async (peer) => {
        const sender = peer.pc.getSenders().find((s) => s.track?.kind === 'audio' || s.track === null)
        if (sender) await sender.replaceTrack(track)
      })
    )
    previous?.getTracks().forEach((t) => t.stop())
    this.attachAnalyser()
  }

  async updateSettings(patch: Partial<VoiceSettings>): Promise<void> {
    const before = this.settings
    this.settings = { ...before, ...patch }
    this.emit()

    if (patch.outputId !== undefined && patch.outputId !== before.outputId) {
      for (const peer of this.peers.values()) this.applySink(peer.audio)
    }
    const micChanged =
      this.settings.inputId !== before.inputId ||
      this.settings.echoCancellation !== before.echoCancellation ||
      this.settings.noiseSuppression !== before.noiseSuppression ||
      this.settings.autoGainControl !== before.autoGainControl
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
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = !muted))
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
    peer.audio.volume = peer.volume
    this.emit()
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
    }

    ws.onclose = () => {
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

    const track = this.stream?.getAudioTracks()[0]
    if (track && this.stream) pc.addTrack(track, this.stream)

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

  private attachAnalyser(): void {
    this.detachAnalyser()
    if (!this.stream || document.visibilityState !== 'visible') return
    this.audioContext ??= new AudioContext({ latencyHint: 'playback' })
    if (this.audioContext.state === 'suspended') void this.audioContext.resume()
    this.analyser = this.audioContext.createAnalyser()
    this.analyser.fftSize = 512
    this.analyserData = new Float32Array(this.analyser.fftSize)
    this.analyserSource = this.audioContext.createMediaStreamSource(this.stream)
    this.analyserSource.connect(this.analyser)
  }

  private detachAnalyser(): void {
    this.analyserSource?.disconnect()
    this.analyserSource = null
    this.analyser = null
    if (this.audioContext && this.audioContext.state === 'running') void this.audioContext.suspend()
  }

  /** Measurements only run while the window is shown: nothing in the background. */
  private updateTicker(): void {
    const shouldRun = this.wanted && document.visibilityState === 'visible'
    if (shouldRun && this.ticker === null) {
      this.attachAnalyser()
      this.ticker = window.setInterval(() => void this.onTick(), LEVEL_INTERVAL_MS)
    } else if (!shouldRun && this.ticker !== null) {
      window.clearInterval(this.ticker)
      this.ticker = null
      this.detachAnalyser()
      this.micLevel = 0
    }
  }

  private async onTick(): Promise<void> {
    this.tick++
    if (this.analyser && this.analyserData && !this.muted) {
      this.analyser.getFloatTimeDomainData(this.analyserData)
      let sum = 0
      for (const sample of this.analyserData) sum += sample * sample
      this.micLevel = Math.min(1, Math.sqrt(sum / this.analyserData.length) * 4)
    } else {
      this.micLevel = 0
    }
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
        bytesSent: outbound.bytesSent ?? 0
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
        route: local && remote ? `${local.candidateType} ↔ ${remote.candidateType}` : null,
        codec: codec?.mimeType ? String(codec.mimeType).replace('audio/', '') : null
      }
    }
  }
}
