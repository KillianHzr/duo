import { contextBridge, ipcRenderer } from 'electron'
import type { AppState } from '../main/index'
import type { CloseAction } from '../main/config'
import type { UpdateStatus } from '../main/updater'
import type { PttBinding } from '../shared/keys'

export interface E2EConfig {
  name: string
  server: string
  code: string
  enhanced: boolean
  gateDb: number | null
  durationMs: number
  /** When set, this instance posts that text with a photo, and saves a note. */
  say: string
}

const api = {
  /** WebSocket URLs of the Duo servers found on the local network. */
  discover: (): Promise<string[]> => ipcRenderer.invoke('duo:discover'),
  getState: (): Promise<AppState> => ipcRenderer.invoke('duo:state'),
  /** Runs the server inside this app and returns the access code to share. */
  host: (): Promise<AppState> => ipcRenderer.invoke('duo:host'),
  join: (code: string): Promise<AppState> => ipcRenderer.invoke('duo:join', code),
  resetRole: (): Promise<AppState> => ipcRenderer.invoke('duo:reset-role'),
  setAutostart: (enabled: boolean): Promise<AppState> => ipcRenderer.invoke('duo:set-autostart', enabled),

  /** Store builds: opens the Windows page where starting with the computer is switched on or off. */
  openStartupSettings: (): void => ipcRenderer.send('duo:open-startup-settings'),

  /** Fires when the user clicks the window's close button and has not picked a default yet. */
  onCloseRequested: (listener: () => void): (() => void) => {
    const handler = (): void => listener()
    ipcRenderer.on('duo:close-requested', handler)
    return () => ipcRenderer.removeListener('duo:close-requested', handler)
  },
  closeChoice: (action: 'tray' | 'quit', remember: boolean): void =>
    ipcRenderer.send('duo:close-choice', action, remember),
  setCloseAction: (action: CloseAction): Promise<AppState> => ipcRenderer.invoke('duo:set-close-action', action),

  /** Host only: pick the folder that holds messages, notes and media (existing data is copied over). */
  chooseDataDir: (): Promise<AppState> => ipcRenderer.invoke('duo:choose-data-dir'),
  chooseBackupDir: (): Promise<AppState> => ipcRenderer.invoke('duo:choose-backup-dir'),
  disableBackup: (): Promise<AppState> => ipcRenderer.invoke('duo:disable-backup'),
  backupNow: (): Promise<AppState> => ipcRenderer.invoke('duo:backup-now'),
  /** Fires when something changed in the background (a scheduled backup finished). */
  onStateChanged: (listener: (state: AppState) => void): (() => void) => {
    const handler = (_event: unknown, state: AppState): void => listener(state)
    ipcRenderer.on('duo:state-changed', handler)
    return () => ipcRenderer.removeListener('duo:state-changed', handler)
  },
  /** Saves a file from the chat to a place the user picks. */
  download: (url: string): void => ipcRenderer.send('duo:download', url),

  /** Watches a key system-wide for push-to-talk (null stops). False if the system refuses. */
  setPtt: (binding: Pick<PttBinding, 'kind' | 'code'> | null): Promise<boolean> => ipcRenderer.invoke('duo:set-ptt', binding),
  onPtt: (listener: (down: boolean) => void): (() => void) => {
    const handler = (_event: unknown, down: boolean): void => listener(down)
    ipcRenderer.on('duo:ptt', handler)
    return () => ipcRenderer.removeListener('duo:ptt', handler)
  },

  getUpdateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('duo:update-status'),
  onUpdateStatus: (listener: (status: UpdateStatus) => void): (() => void) => {
    const handler = (_event: unknown, status: UpdateStatus): void => listener(status)
    ipcRenderer.on('duo:update-status', handler)
    return () => ipcRenderer.removeListener('duo:update-status', handler)
  },
  installUpdate: (): void => ipcRenderer.send('duo:install-update'),
  /** Opens the download page, for computers that refuse automatic updates. */
  openReleases: (): void => ipcRenderer.send('duo:open-releases'),

  e2e: ipcRenderer.sendSync('duo:e2e-config') as E2EConfig | null,
  e2eReport: (report: unknown): void => ipcRenderer.send('duo:e2e-report', report)
}

export type DuoApi = typeof api
export type { AppState, CloseAction, UpdateStatus }

contextBridge.exposeInMainWorld('duo', api)
