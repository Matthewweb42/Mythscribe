import { setupIpcHandlers, closeDatabase, setMainWindow } from './ipcHandlers'
import { app, shell, BrowserWindow, ipcMain, Menu, protocol } from 'electron'
import { join } from 'path'
import { readFile } from 'fs/promises'
import icon from '../../resources/icon.png?asset'
import dotenv from 'dotenv'

// Load environment variables
dotenv.config()

// Simple dev check - use environment variable or process check
const isDev = process.env.NODE_ENV === 'development' || process.defaultApp || /[\\/]electron-prebuilt[\\/]/.test(process.execPath) || /[\\/]electron[\\/]/.test(process.execPath)

// Register custom protocol BEFORE app ready (this is required for custom protocols)
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'mythscribe-asset',
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      bypassCSP: true  // Allow loading images from custom protocol
    }
  }
])

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    autoHideMenuBar: true, // Hide the native menu bar
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // Remove the native application menu
  Menu.setApplicationMenu(null);

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Pass mainWindow reference to IPC handlers
  setMainWindow(mainWindow)

  // Add keyboard shortcut for DevTools (F12 or Ctrl+Shift+I)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
      mainWindow.webContents.toggleDevTools()
      event.preventDefault()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  setupIpcHandlers()
  app.setAppUserModelId('com.electron')

  // Register custom protocol handler for project assets
  protocol.handle('mythscribe-asset', async (request) => {
    try {
      // Extract the file path from the URL
      // Format: mythscribe-asset://path/to/file
      const url = request.url.replace('mythscribe-asset://', '')
      const filePath = decodeURIComponent(url)

      console.log('Loading asset:', filePath)

      // Read the file
      const data = await readFile(filePath)

      // Determine MIME type based on extension
      let mimeType = 'application/octet-stream'
      if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) {
        mimeType = 'image/jpeg'
      } else if (filePath.endsWith('.png')) {
        mimeType = 'image/png'
      } else if (filePath.endsWith('.webp')) {
        mimeType = 'image/webp'
      } else if (filePath.endsWith('.gif')) {
        mimeType = 'image/gif'
      }

      return new Response(data, {
        headers: { 'Content-Type': mimeType }
      })
    } catch (error) {
      console.error('Error loading asset:', error)
      return new Response('File not found', { status: 404 })
    }
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Move before-quit OUTSIDE of whenReady, at the top level
app.on('before-quit', () => {
  closeDatabase()
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
