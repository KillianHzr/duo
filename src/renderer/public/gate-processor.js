/**
 * Microphone level meter and sensitivity gate, running on the audio thread.
 * It only listens: it tells the app when the voice goes above or below the threshold,
 * and the app switches the outgoing track on or off. Nothing is added to the audio path,
 * so the gate costs no delay.
 *
 * Messages in:  { enabled, threshold (dBFS), meter }
 * Messages out: { open } on every change, { level (dBFS) } about 20 times a second while metering
 */
const HOLD_SECONDS = 0.3
const METER_SECONDS = 0.05
const SILENCE_DB = -100

class GateProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.enabled = false
    this.threshold = -45
    this.meter = false
    this.open = true
    this.holdLeft = 0
    this.peak = SILENCE_DB
    this.sinceMeter = 0
    this.port.onmessage = (event) => {
      const { enabled, threshold, meter } = event.data
      if (typeof enabled === 'boolean') this.enabled = enabled
      if (typeof threshold === 'number') this.threshold = threshold
      if (typeof meter === 'boolean') this.meter = meter
    }
  }

  process(inputs) {
    const samples = inputs[0] && inputs[0][0]
    const frames = samples ? samples.length : 128
    let level = SILENCE_DB
    if (samples) {
      let sum = 0
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
      const rms = Math.sqrt(sum / samples.length)
      if (rms > 0) level = Math.max(SILENCE_DB, 20 * Math.log10(rms))
    }

    // Opens at once when the voice passes the threshold; stays open a moment after it
    // drops, so word endings and short pauses are not chopped.
    let open = true
    if (this.enabled) {
      if (level >= this.threshold) this.holdLeft = HOLD_SECONDS * sampleRate
      else this.holdLeft = Math.max(0, this.holdLeft - frames)
      open = this.holdLeft > 0
    }
    if (open !== this.open) {
      this.open = open
      this.port.postMessage({ open })
    }

    if (this.meter) {
      if (level > this.peak) this.peak = level
      this.sinceMeter += frames
      if (this.sinceMeter >= METER_SECONDS * sampleRate) {
        this.port.postMessage({ level: this.peak })
        this.peak = SILENCE_DB
        this.sinceMeter = 0
      }
    }
    return true
  }
}

registerProcessor('duo-gate', GateProcessor)
