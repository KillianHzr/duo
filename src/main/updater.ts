import { app, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000
/** The first check waits a little: starting up and joining the call come first. */
const FIRST_CHECK_DELAY_MS = 30_000
/** After this many installs that left the version unchanged, Windows is clearly refusing them. */
const MAX_INSTALL_ATTEMPTS = 2

export interface UpdateStatus {
  /** Version downloaded and ready to install, or null. */
  ready: string | null
  /** Version that exists but that this computer refuses to install, or null. */
  blocked: string | null
}

const status: UpdateStatus = { ready: null, blocked: null }

export const getUpdateStatus = (): UpdateStatus => status

/** Remembers which version we tried to install and how many times, across restarts. */
interface Attempts {
  version: string
  count: number
}

const attemptsFile = (): string => join(app.getPath('userData'), 'update-attempts.json')

function readAttempts(): Attempts | null {
  try {
    const data = JSON.parse(readFileSync(attemptsFile(), 'utf8')) as Attempts
    return typeof data.version === 'string' && Number.isInteger(data.count) ? data : null
  } catch {
    return null
  }
}

function writeAttempts(attempts: Attempts | null): void {
  try {
    writeFileSync(attemptsFile(), JSON.stringify(attempts))
  } catch {
    /* not being able to remember only means one more try */
  }
}

/** Called right before the installer of a downloaded update is run. */
export function noteInstallAttempt(): void {
  if (!status.ready) return
  const previous = readAttempts()
  writeAttempts({ version: status.ready, count: previous?.version === status.ready ? previous.count + 1 : 1 })
}

/**
 * Checks GitHub Releases for a newer version, downloads it in the background and
 * installs it when the app quits (or right away if the user asks).
 *
 * Some computers refuse the installer (Windows Smart App Control blocks unsigned apps). There,
 * downloading the same 100 MB again at every start would only waste power: after two failed
 * installs the app stops downloading and tells the user instead.
 */
export function startAutoUpdate(getWindow: () => BrowserWindow | null): void {
  // The Microsoft Store updates its own packages; our updater must stay out of the way there.
  if (!app.isPackaged || process.windowsStore) return

  const attempts = readAttempts()
  // Still running a version other than the one we installed: those installs did not go through.
  const refused = attempts !== null && attempts.version !== app.getVersion() && attempts.count >= MAX_INSTALL_ATTEMPTS
  if (attempts && attempts.version === app.getVersion()) writeAttempts(null)

  autoUpdater.autoDownload = !refused
  autoUpdater.autoInstallOnAppQuit = !refused
  autoUpdater.on('update-available', (info) => {
    if (!refused) return
    status.blocked = info.version
    getWindow()?.webContents.send('duo:update-status', status)
  })
  autoUpdater.on('update-downloaded', (info) => {
    status.ready = info.version
    getWindow()?.webContents.send('duo:update-status', status)
  })
  autoUpdater.on('error', (err) => console.error('update check failed:', err.message))

  const check = (): void => void autoUpdater.checkForUpdates().catch(() => {})
  setTimeout(check, FIRST_CHECK_DELAY_MS).unref()
  setInterval(check, CHECK_EVERY_MS).unref()
}

export function installUpdateNow(): void {
  if (!status.ready) return
  noteInstallAttempt()
  autoUpdater.quitAndInstall(true, true)
}

/** Test hook: asks the release feed whether a newer version exists, without downloading. */
export async function probeUpdate(): Promise<{ current: string; latest: string | null; error?: string }> {
  autoUpdater.autoDownload = false
  try {
    const result = await autoUpdater.checkForUpdates()
    return { current: app.getVersion(), latest: result?.updateInfo.version ?? null }
  } catch (err) {
    return { current: app.getVersion(), latest: null, error: err instanceof Error ? err.message : String(err) }
  }
}
