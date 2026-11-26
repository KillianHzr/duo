import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface DuoConfig {
  /** 'host' runs the server inside this app; 'guest' joins one found on the network. */
  role: 'host' | 'guest' | null
  /** Access code: generated when hosting, typed in when joining. */
  code: string
  /** What the window's close button does: ask each time, hide to the tray, or quit. */
  closeAction: CloseAction
  /** Host only: folder for messages, notes and media. Empty means the app's own data folder. */
  dataDir: string
  /** Host only: folder that receives a daily copy of the data. Empty means no backup. */
  backupDir: string
  lastBackup: BackupResult | null
  /** Colours of the window behind the page and of its system buttons, following the chosen theme. */
  windowColors: WindowColors
}

export interface WindowColors {
  background: string
  symbols: string
}

export type CloseAction = 'ask' | 'tray' | 'quit'

export interface BackupResult {
  at: number
  /** Null when the backup went through. */
  error: string | null
}

export const DEFAULTS: DuoConfig = {
  role: null,
  code: '',
  closeAction: 'ask',
  dataDir: '',
  backupDir: '',
  lastBackup: null,
  windowColors: { background: '#1c1d20', symbols: '#9c9da6' }
}

const file = (): string => join(app.getPath('userData'), 'config.json')

export function loadConfig(): DuoConfig {
  try {
    if (existsSync(file())) return { ...DEFAULTS, ...JSON.parse(readFileSync(file(), 'utf8')) }
  } catch {
    /* unreadable config: start fresh */
  }
  return { ...DEFAULTS }
}

export function saveConfig(config: DuoConfig): void {
  mkdirSync(dirname(file()), { recursive: true })
  writeFileSync(file(), JSON.stringify(config, null, 2))
}
