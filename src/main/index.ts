import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell, Tray } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { moveData, runBackup } from './backup'
import { discoverServers } from './discovery'
import { DEFAULTS, loadConfig, saveConfig, type BackupResult, type CloseAction, type DuoConfig } from './config'
import { getUpdateStatus, installUpdateNow, probeUpdate, startAutoUpdate } from './updater'
import { generateCode, startDuoServer, type DuoServer } from '../server/duo-server'
import { DUO_PORT, normalizeCode } from '../shared/protocol'

/** Automated test mode: fake microphone, hidden window, report on stdout. */
const e2e = process.env.DUO_E2E_NAME
  ? {
      name: process.env.DUO_E2E_NAME,
      server: process.env.DUO_E2E_SERVER ?? '',
      code: process.env.DUO_E2E_CODE ?? '',
      enhanced: Boolean(process.env.DUO_E2E_ENHANCED),
      gateDb: process.env.DUO_E2E_GATE ? Number(process.env.DUO_E2E_GATE) : null,
      durationMs: Number(process.env.DUO_E2E_DURATION ?? 8000),
      say: process.env.DUO_E2E_SAY ?? ''
    }
  : null

if (e2e) {
  if (process.env.DUO_E2E_USERDATA) app.setPath('userData', process.env.DUO_E2E_USERDATA)
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
  app.commandLine.appendSwitch('mute-audio')
}

// Never pop up Electron's error dialog: it would steal focus from a full-screen game.
// Errors go to the console instead; a test instance exits so the test fails cleanly.
const onFatal = (err: unknown): void => {
  console.error('unexpected error in main process:', err)
  if (e2e) app.exit(1)
}
process.on('uncaughtException', onFatal)
process.on('unhandledRejection', onFatal)

// The other person's voice must start playing without a click in the window first.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

/** True when installed from the Microsoft Store, which handles updates and startup itself. */
const isStore = process.windowsStore === true

/** Set when launched at login: start straight in the tray. */
const startHidden = process.argv.includes('--hidden')

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let config: DuoConfig = { ...DEFAULTS }
let server: DuoServer | null = null
let hostError: string | null = null

export interface AppState {
  role: DuoConfig['role']
  code: string
  closeAction: CloseAction
  /** Why hosting failed ('port-in-use' or a raw message), or null. */
  hostError: string | null
  version: string
  autostart: boolean
  /** Store builds hide what the Store manages: updates and start with the computer. */
  store: boolean
  /** Host only: where messages, notes and media are kept. */
  dataDir: string
  /** Host only: folder receiving the daily copy, or '' when backups are off. */
  backupDir: string
  lastBackup: BackupResult | null
}

const dataDir = (): string => config.dataDir || join(app.getPath('userData'), 'data')

function appState(): AppState {
  return {
    dataDir: dataDir(),
    backupDir: config.backupDir,
    lastBackup: config.lastBackup,
    role: config.role,
    code: config.code,
    closeAction: config.closeAction,
    hostError,
    version: app.getVersion(),
    autostart: app.isPackaged && !isStore && app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin,
    store: isStore
  }
}

async function startHosting(): Promise<void> {
  if (server) return
  hostError = null
  try {
    mkdirSync(dataDir(), { recursive: true })
    server = await startDuoServer({ code: config.code, port: DUO_PORT, dataDir: dataDir() })
  } catch (err) {
    const error = err as NodeJS.ErrnoException
    hostError = error.code === 'EADDRINUSE' ? 'port-in-use' : error.message
  }
}

let backingUp = false

/** Copies the data folder to the backup folder and remembers how it went. */
async function backupNow(): Promise<void> {
  if (backingUp || !config.backupDir) return
  backingUp = true
  let error: string | null = null
  try {
    await runBackup(dataDir(), config.backupDir)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  backingUp = false
  config = { ...config, lastBackup: { at: Date.now(), error } }
  saveConfig(config)
  mainWindow?.webContents.send('duo:state-changed', appState())
}

const BACKUP_HOUR = 3

/** Once a day, at night if the computer is on, otherwise the next time the app runs. */
function backupIfDue(): void {
  if (config.role !== 'host' || !config.backupDir) return
  const now = new Date()
  // The "backup day" starts at 3 in the morning.
  const day = (date: Date): string => new Date(date.getTime() - BACKUP_HOUR * 3_600_000).toDateString()
  if (config.lastBackup && day(new Date(config.lastBackup.at)) === day(now)) return
  void backupNow()
}

async function stopHosting(): Promise<void> {
  await server?.close()
  server = null
  hostError = null
}

/** Round icon drawn in memory, so the tray needs no image file. */
function makeIcon(size: number): Electron.NativeImage {
  const buffer = Buffer.alloc(size * size * 4)
  const center = (size - 1) / 2
  const radius = size / 2 - 1
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const alpha = Math.max(0, Math.min(1, radius - Math.hypot(x - center, y - center) + 0.5))
      const i = (y * size + x) * 4
      buffer[i] = 0xf2 // B
      buffer[i + 1] = 0x65 // G
      buffer[i + 2] = 0x58 // R
      buffer[i + 3] = Math.round(alpha * 255)
    }
  }
  return nativeImage.createFromBitmap(buffer, { width: size, height: size })
}

function showWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function quit(): void {
  quitting = true
  app.quit()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 660,
    minWidth: 360,
    minHeight: 480,
    show: false,
    title: 'Duo',
    icon: makeIcon(64),
    backgroundColor: '#16171d',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => {
    if (!e2e) {
      if (!startHidden) mainWindow?.show()
    } else if (process.env.DUO_E2E_HIDE) {
      // Mimics the app sitting in the tray, to measure its load.
      mainWindow?.showInactive()
      setTimeout(() => mainWindow?.hide(), 1500)
    }
  })

  // The close button either hides the window to the tray (the call goes on, and a hidden
  // window draws nothing), quits for good, or asks which of the two the user wants.
  mainWindow.on('close', (event) => {
    if (quitting || e2e) return
    if (config.closeAction === 'quit') return quit()
    event.preventDefault()
    // If the page cannot show the question (still loading, crashed), hiding is the safe default.
    const canAsk = mainWindow && !mainWindow.webContents.isLoading() && !mainWindow.webContents.isCrashed()
    if (config.closeAction === 'tray' || !canAsk) mainWindow?.hide()
    else mainWindow?.webContents.send('duo:close-requested')
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // The window only ever shows the app itself.
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createTray(): void {
  tray = new Tray(makeIcon(32))
  tray.setToolTip('Duo')
  const french = app.getLocale().startsWith('fr')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: french ? 'Ouvrir Duo' : 'Open Duo', click: showWindow },
      { type: 'separator' },
      { label: french ? 'Quitter' : 'Quit', click: quit }
    ])
  )
  tray.on('click', showWindow)
}

function registerIpc(): void {
  ipcMain.handle('duo:discover', () => discoverServers())
  ipcMain.handle('duo:state', () => appState())

  ipcMain.handle('duo:host', async () => {
    config = { ...config, role: 'host', code: config.role === 'host' && config.code ? config.code : generateCode() }
    saveConfig(config)
    await startHosting()
    return appState()
  })

  ipcMain.handle('duo:join', async (_event, code: string) => {
    await stopHosting()
    config = { ...config, role: 'guest', code: normalizeCode(String(code ?? '')) }
    saveConfig(config)
    return appState()
  })

  ipcMain.handle('duo:reset-role', async () => {
    await stopHosting()
    config = { ...config, role: null, code: '' }
    saveConfig(config)
    return appState()
  })

  ipcMain.handle('duo:set-autostart', (_event, enabled: boolean) => {
    if (app.isPackaged && !isStore) app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: ['--hidden'] })
    return appState()
  })

  const isCloseAction = (value: unknown): value is CloseAction => value === 'ask' || value === 'tray' || value === 'quit'

  ipcMain.handle('duo:set-close-action', (_event, action: unknown) => {
    if (isCloseAction(action)) {
      config = { ...config, closeAction: action }
      saveConfig(config)
    }
    return appState()
  })

  // Answer to the "close or keep running?" question shown by the window.
  ipcMain.on('duo:close-choice', (_event, action: unknown, remember: unknown) => {
    if (action !== 'tray' && action !== 'quit') return
    if (remember === true) {
      config = { ...config, closeAction: action }
      saveConfig(config)
    }
    if (action === 'quit') quit()
    else mainWindow?.hide()
  })

  const chooseFolder = async (): Promise<string | null> => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  }

  ipcMain.handle('duo:choose-data-dir', async () => {
    const chosen = await chooseFolder()
    if (!chosen || chosen === dataDir()) return appState()
    const previous = dataDir()
    await stopHosting()
    await moveData(previous, chosen)
    config = { ...config, dataDir: chosen }
    saveConfig(config)
    if (config.role === 'host') await startHosting()
    return appState()
  })

  ipcMain.handle('duo:choose-backup-dir', async () => {
    const chosen = await chooseFolder()
    if (chosen) {
      config = { ...config, backupDir: chosen, lastBackup: null }
      saveConfig(config)
      await backupNow()
    }
    return appState()
  })

  ipcMain.handle('duo:disable-backup', () => {
    config = { ...config, backupDir: '', lastBackup: null }
    saveConfig(config)
    return appState()
  })

  ipcMain.handle('duo:backup-now', async () => {
    await backupNow()
    return appState()
  })

  // Saving a file from the chat: only ever from a host's media address.
  ipcMain.on('duo:download', (_event, url: unknown) => {
    if (typeof url === 'string' && /^http:\/\/[^/]+\/media\/[a-f0-9]{24}\?/.test(url)) {
      mainWindow?.webContents.downloadURL(url)
    }
  })

  ipcMain.handle('duo:update-status', () => getUpdateStatus())
  ipcMain.on('duo:install-update', () => {
    quitting = true
    installUpdateNow()
  })

  ipcMain.on('duo:e2e-config', (event) => {
    event.returnValue = e2e
  })
  ipcMain.on('duo:e2e-report', (_event, report: unknown) => {
    process.stdout.write(`E2E_REPORT ${JSON.stringify(report)}\n`)
    // Gives the other instance time to take its own reading before the link drops.
    setTimeout(quit, 2500)
  })
}

if (process.env.DUO_PROBE_UPDATE) {
  // Test hook: print what the release feed answers, then exit.
  void app.whenReady().then(async () => {
    process.stdout.write(`UPDATE_PROBE ${JSON.stringify(await probeUpdate())}\n`)
    app.exit(0)
  })
} else if (!e2e && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)

  void app.whenReady().then(async () => {
    // Only the microphone is allowed; any other permission request is denied.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'media')
    })
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
      return ['media', 'speaker-selection'].includes(permission as string)
    })

    if (!e2e) {
      config = loadConfig()
      if (config.role === 'host') await startHosting()
    } else if (process.env.DUO_E2E_HOST_PORT) {
      // Test: this instance hosts the server itself, like a real host would.
      // Loopback only, so no firewall prompt can appear during a test run.
      server = await startDuoServer({
        code: e2e.code,
        port: Number(process.env.DUO_E2E_HOST_PORT),
        host: '127.0.0.1',
        dataDir: process.env.DUO_E2E_DATA || undefined
      })
    }

    registerIpc()
    createWindow()
    if (!e2e) {
      createTray()
      startAutoUpdate(() => mainWindow)
      setTimeout(backupIfDue, 60_000)
      setInterval(backupIfDue, 10 * 60_000)
    }
  })

  app.on('before-quit', () => {
    quitting = true
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
