import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, session } from 'electron'
import type { CompiledBook } from '@shared/compileModel'
import { printPageHtml } from './printPage'

/**
 * The PDF writer's printer (Compile v2, CV2): the print page laid out by Paged.js (CSS Paged
 * Media: page size, mirrored margins, running headers, page counters, recto starts, contents page
 * numbers) in a hidden window, then Chromium's own `printToPDF`, which embeds the bundled fonts.
 *
 * Paged.js needs script, so the window is locked down instead: sandboxed, no Node, context
 * isolation, its own in-memory session that refuses every request that is not a local file, no
 * navigation, no new windows. Everything from the author's text is escaped by the HTML writer, so
 * none of it can become script. The page goes through a temp file because a data URL caps out
 * around 2 MB, too small for a novel. The window and the file are removed whatever happens.
 */

/** Where the bundled fonts live: beside the app when packaged, under `resources/` in development. */
export function bookFontsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'fonts')
    : path.join(app.getAppPath(), 'resources', 'fonts')
}

const PARTITION = 'mythscribe-print'
/** A novel lays out in seconds; this only stops a hung page from hanging the compile. */
const LAYOUT_TIMEOUT_MS = 10 * 60 * 1000

let sessionReady = false

function printSession(): Electron.Session {
  const ses = session.fromPartition(PARTITION)
  if (!sessionReady) {
    ses.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') })
    })
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    sessionReady = true
  }
  return ses
}

async function loadPagedPolyfill(): Promise<string> {
  const module = await import('../../../node_modules/pagedjs/dist/paged.polyfill.min.js?raw')
  return module.default
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

export async function renderPdf(book: CompiledBook): Promise<Buffer> {
  const html = printPageHtml(book, bookFontsDir(), await loadPagedPolyfill())
  const file = path.join(os.tmpdir(), `mythscribe-compile-${randomUUID()}.html`)
  fs.writeFileSync(file, html, 'utf8')
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      session: printSession(),
      // Paged.js lays out a page per animation frame, and a hidden window gets about one frame a
      // second; rendered offscreen and unthrottled it gets every frame (108 pages: 105 s → 2 s).
      offscreen: true,
      backgroundThrottling: false
    }
  })
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  try {
    await win.loadFile(file)
    await withTimeout(
      win.webContents.executeJavaScript('window.PagedPolyfill.preview().then(() => true)'),
      LAYOUT_TIMEOUT_MS,
      'The PDF layout took too long'
    )
    return await win.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true })
  } finally {
    win.destroy()
    fs.rmSync(file, { force: true })
  }
}
