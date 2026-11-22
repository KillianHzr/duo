import { contextBridge, ipcRenderer } from 'electron'
import type { AppState } from '../main/index'
import type { UpdateStatus } from '../main/updater'

export interface E2EConfig {
  name: string
  server: string
  code: string
  enhanced: boolean
  gateDb: number | null
  durationMs: number
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

  getUpdateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('duo:update-status'),
  onUpdateStatus: (listener: (status: UpdateStatus) => void): (() => void) => {
    const handler = (_event: unknown, status: UpdateStatus): void => listener(status)
    ipcRenderer.on('duo:update-status', handler)
    return () => ipcRenderer.removeListener('duo:update-status', handler)
  },
  installUpdate: (): void => ipcRenderer.send('duo:install-update'),

  e2e: ipcRenderer.sendSync('duo:e2e-config') as E2EConfig | null,
  e2eReport: (report: unknown): void => ipcRenderer.send('duo:e2e-report', report)
}

export type DuoApi = typeof api
export type { AppState, UpdateStatus }

contextBridge.exposeInMainWorld('duo', api)
