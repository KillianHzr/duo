import { app, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000

export interface UpdateStatus {
  /** Version downloaded and ready to install, or null. */
  ready: string | null
}

const status: UpdateStatus = { ready: null }

export const getUpdateStatus = (): UpdateStatus => status

/**
 * Checks GitHub Releases for a newer version, downloads it in the background and
 * installs it when the app quits (or right away if the user asks).
 */
export function startAutoUpdate(getWindow: () => BrowserWindow | null): void {
  // The Microsoft Store updates its own packages; our updater must stay out of the way there.
  if (!app.isPackaged || process.windowsStore) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', (info) => {
    status.ready = info.version
    getWindow()?.webContents.send('duo:update-status', status)
  })
  autoUpdater.on('error', (err) => console.error('update check failed:', err.message))

  const check = (): void => void autoUpdater.checkForUpdates().catch(() => {})
  check()
  setInterval(check, CHECK_EVERY_MS).unref()
}

export function installUpdateNow(): void {
  if (status.ready) autoUpdater.quitAndInstall(true, true)
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
