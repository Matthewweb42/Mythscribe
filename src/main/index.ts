import { app, BrowserWindow, Menu, shell } from 'electron'
import icon from '../../resources/icon.png?asset'
import { join } from 'node:path'
import { AppStateStore } from './appState/appStateStore'
import { createDialogs } from './dialogs'
import { registerHandlers } from './ipc/handlers'
import { emit } from './ipc/registry'
import { installSingleInstance } from './lifecycle'
import { ProjectManager } from './project/manager'

const isDev = !app.isPackaged
const manager = new ProjectManager()

/** Lets e2e tests isolate app-wide state (recents) from the developer's own. */
if (process.env.MYTHSCRIBE_USER_DATA) app.setPath('userData', process.env.MYTHSCRIBE_USER_DATA)

/** The lock lives in userData, so it must be requested after the override above. */
const primaryInstance = installSingleInstance(app, () => BrowserWindow.getAllWindows()[0] ?? null)

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1b1b1f',
    // macOS takes the icon from the bundle; Windows and Linux windows need it here.
    ...(process.platform === 'darwin' ? {} : { icon }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  win.once('ready-to-show', () => win.show())

  // F-1.4: with a project open, the renderer flushes pending saves first and then invokes
  // `window:close`, which closes the project so this guard lets the second close through.
  win.on('close', (e) => {
    if (!manager.current()) return
    e.preventDefault()
    emit([win], 'window:close-requested', null)
  })
  // A dead renderer can never flush, so do not let it wedge the window.
  win.webContents.on('render-process-gone', () => manager.close())

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12') {
        win.webContents.toggleDevTools()
        event.preventDefault()
      }
    })
  }

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (isDev && devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

if (!primaryInstance) {
  app.quit()
} else {
  void app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    const appState = new AppStateStore(join(app.getPath('userData'), 'app-state.json'))
    registerHandlers({
      manager,
      appState,
      dialogs: createDialogs(
        () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
      ),
      windows: () => BrowserWindow.getAllWindows(),
      onCloseCancelled: () => {
        quitRequested = false
      }
    })
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

// A prevented window close (project open, renderer still flushing) cancels the in-flight quit.
// Remember that a quit was asked for so macOS exits once the flushed window finally closes;
// `window:close-cancelled` (flush failed, author kept working) forgets it again, so a later
// plain window close does not quit the app.
let quitRequested = false
app.on('before-quit', () => {
  quitRequested = true
})

/** `will-quit`, not `before-quit`: the renderer must flush before the DB closes. */
app.on('will-quit', () => manager.close())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || quitRequested) app.quit()
})
