import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'node:path'
import { AppStateStore } from './appState/appStateStore'
import { createDialogs } from './dialogs'
import { registerHandlers } from './ipc/handlers'
import { ProjectManager } from './project/manager'

const isDev = !app.isPackaged
const manager = new ProjectManager()

/** Lets e2e tests isolate app-wide state (recents) from the developer's own. */
if (process.env.MYTHSCRIBE_USER_DATA) app.setPath('userData', process.env.MYTHSCRIBE_USER_DATA)

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1b1b1f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  win.once('ready-to-show', () => win.show())

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

void app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  const appState = new AppStateStore(join(app.getPath('userData'), 'app-state.json'))
  registerHandlers({
    manager,
    appState,
    dialogs: createDialogs(
      () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    ),
    windows: () => BrowserWindow.getAllWindows()
  })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => manager.close())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
