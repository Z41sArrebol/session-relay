import { app, BrowserWindow, dialog, session } from 'electron'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { RelayStore } from './core/state'
import { ZcodeReader } from './core/zcode/reader'
import { Observer } from './core/observer'
import { SettingsService } from './core/settings'
import { Logger } from './core/log'
import { ConnectorService } from './core/connectors'
import { SummaryService } from './core/summary'
import { defaultZcodeDbPath } from './core/paths'
import { registerIpc } from './ipc'

let mainWindow: BrowserWindow | null = null
let observer: Observer | null = null
let store: RelayStore | null = null
let reader: ZcodeReader | null = null
let logger: Logger | null = null
let quitting = false

// Test/E2E isolation: never point this at a real user profile.
const userDataOverride = process.env.SESSION_RELAY_USER_DATA
if (userDataOverride && userDataOverride.trim()) {
  app.setPath('userData', path.resolve(userDataOverride.trim()))
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    title: '会话接力台',
    backgroundColor: '#f4f1ea',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL()
    if (url !== current) event.preventDefault()
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    void win.loadURL(rendererUrl)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  return win
}

async function start(): Promise<void> {
  logger = new Logger()
  const zcodeDbPath = defaultZcodeDbPath()
  const userDataDir = app.getPath('userData')
  reader = new ZcodeReader(zcodeDbPath)
  store = new RelayStore(path.join(userDataDir, 'relay.sqlite'))
  const settings = new SettingsService()
  const connectors = new ConnectorService({ store, logger, userDataDir })
  const summaries = new SummaryService(settings, logger)

  observer = new Observer({
    store,
    reader,
    logger,
    emit: (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('relay:event', event)
      }
    }
  })

  registerIpc({
    store,
    reader,
    observer,
    settings,
    logger,
    connectors,
    summaries,
    zcodeDbPath,
    getWindow: () => mainWindow
  })

  logger.info(`start version=${app.getVersion()} db=${zcodeDbPath} schema=${reader.getSchema().compatible}`)
  mainWindow = createWindow()
  observer.start()
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.zhangzhirui.sessionrelay')
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  try {
    await start()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger?.error(`startup-failed ${message}`)
    dialog.showErrorBox('会话接力台无法启动', message)
    app.quit()
    return
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  if (quitting) return
  quitting = true
  try {
    observer?.stop()
    reader?.close()
    store?.close()
  } catch {
    // best effort
  }
})

process.on('uncaughtException', (error) => {
  logger?.error(`uncaught ${error.message}`)
})

process.on('unhandledRejection', (reason) => {
  logger?.error(`unhandled-rejection ${String(reason).slice(0, 300)}`)
})

// Keep randomUUID imported in the bundle's dependency graph for pending dirs
// created by future IPC additions without changing the startup path.
void randomUUID
