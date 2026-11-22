/** Target Opus bitrate in bit/s. */
export const OPUS_BITRATE = 96_000
/** Audio frame length in ms. 10 instead of the default 20 removes 10 ms of delay. */
export const OPUS_PTIME = 10

/**
 * Tunes Opus in the SDP received from the other side. Those parameters describe what
 * the remote accepts to receive, so they drive our own encoder:
 * short frames, high bitrate, forward error correction on, no cut-off during silence.
 */
export function tuneOpus(sdp: string): string {
  const match = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp)
  if (!match) return sdp
  const pt = match[1]

  const wanted: Record<string, string> = {
    minptime: String(OPUS_PTIME),
    useinbandfec: '1',
    usedtx: '0',
    maxaveragebitrate: String(OPUS_BITRATE)
  }

  const lines = sdp.split('\r\n')
  const fmtpPrefix = `a=fmtp:${pt} `
  const fmtpIndex = lines.findIndex((line) => line.startsWith(fmtpPrefix))
  const params = new Map<string, string>()
  if (fmtpIndex >= 0) {
    for (const part of lines[fmtpIndex].slice(fmtpPrefix.length).split(';')) {
      const [key, value = ''] = part.trim().split('=')
      if (key) params.set(key, value)
    }
  }
  for (const [key, value] of Object.entries(wanted)) params.set(key, value)
  const fmtp = fmtpPrefix + [...params].map(([k, v]) => `${k}=${v}`).join(';')

  if (fmtpIndex >= 0) {
    lines[fmtpIndex] = fmtp
  } else {
    const rtpmapIndex = lines.findIndex((line) => line.startsWith(`a=rtpmap:${pt} `))
    lines.splice(rtpmapIndex + 1, 0, fmtp)
  }

  // a=ptime applies to the whole audio section.
  const withoutPtime = lines.filter((line) => !/^a=(max)?ptime:/.test(line))
  const anchor = withoutPtime.findIndex((line) => line.startsWith(fmtpPrefix))
  withoutPtime.splice(anchor + 1, 0, `a=ptime:${OPUS_PTIME}`)
  return withoutPtime.join('\r\n')
}
