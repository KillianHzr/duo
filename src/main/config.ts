import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface DuoConfig {
  /** 'host' runs the server inside this app; 'guest' joins one found on the network. */
  role: 'host' | 'guest' | null
  /** Access code: generated when hosting, typed in when joining. */
  code: string
}

const DEFAULTS: DuoConfig = { role: null, code: '' }

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
