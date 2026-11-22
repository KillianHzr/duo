# Duo

Low-latency private voice chat for people on the same local network.

Duo is for when you sit in the same home (or office) and voice chat through the Internet adds a delay
you can hear. One computer hosts, the others join with a code, and the audio flows **directly** between
the computers — it never leaves your network.

- **Direct audio**: WebRTC peer-to-peer on the LAN, no relay server, no account, no cloud.
- **Tuned for delay**: Opus at 96 kb/s with 10 ms frames and a minimal receive buffer.
- **Voice processing you are used to**: echo cancellation, noise suppression and automatic gain.
- **Microphone controls**: a sensitivity threshold that cuts clicks and breathing while you are not
  talking (it adds no delay), optional enhanced noise suppression (RNNoise), a microphone test and an
  output volume.
- **Stays out of the way**: lives in the tray and does no drawing or measuring while hidden.
- **Private by default**: only accepts local-network addresses, and joining requires an access code.
- **Updates itself** from GitHub Releases.
- English and French interface, following the system language.

> Status: early. Voice works; text chat, media sharing and shared notes are planned.

## Install

Download the latest installer from the [Releases page](https://github.com/KillianHzr/duo/releases/latest):

- **Windows**: `Duo-<version>-win-x64.exe`. The app is not code-signed yet, so Windows SmartScreen shows a
  warning: choose *More info → Run anyway*.
- **Linux**: `Duo-<version>-linux-x86_64.AppImage`. Make it executable, then run it.

On Windows 11 computers where **Smart App Control** is on, Windows blocks unsigned apps, including this
installer and its updates, and offers no per-app exception. A Microsoft Store version, which Windows
trusts, is in preparation.

## Use

1. On the computer that stays on, open Duo and choose **Host on this computer**. Duo shows a 6-character
   access code. The first time, your firewall asks whether Duo may accept connections: allow it on
   private networks.
2. On the other computers, open Duo, choose **Join someone** and type the code. Duo finds the host by
   itself; if it does not, type the host's address (for example `192.168.1.16`).

Wired headsets (or 2.4 GHz dongles) keep the delay low; Bluetooth headsets add 150–250 ms on their own.
*Settings → Show delay measurements* displays the real figures during a call.

## How it works

```
 host computer                      other computer
┌───────────────────────┐          ┌───────────────────────┐
│ Duo app               │  signal  │ Duo app               │
│  ├─ server (ws + udp) │◄────────►│                       │
│  └─ voice engine      │◄════════►│  └─ voice engine      │
└───────────────────────┘  audio   └───────────────────────┘
                          (direct)
```

- `src/server/` — the introduction server: UDP discovery, access code, WebRTC signaling over WebSocket
  (port 47800, TCP and UDP). It runs inside the app in host mode, or standalone with `npm run server`.
- `src/main/` — Electron main process: window, tray, discovery, hosting, auto-update.
- `src/renderer/` — React interface and the voice engine (`voice.ts`, Opus tuning in `sdp.ts`,
  microphone gate in `public/gate-processor.js`).
- `src/shared/protocol.ts` — messages exchanged between app and server.

## Develop

Requires Node.js 20 or later.

```sh
npm install
npm run dev          # run the app with hot reload
npm test             # type check, server tests, microphone gate tests
npm run build && npm run test:voice   # five hidden app instances, fake microphone, muted output
npm run dist         # build an installer into dist/
npm run dist:store   # build the Microsoft Store package (Windows only)
```

Releases are built by GitHub Actions when a `v*` tag is pushed.

## Privacy

Duo collects nothing and your voice never leaves your network. See the [privacy policy](PRIVACY.md).

## License

[MIT](LICENSE)
