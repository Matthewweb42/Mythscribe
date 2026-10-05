import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import type { ExportPageSize } from '@shared/bookExport'

/**
 * The PDF export's printer (F-12.1): Chromium's own `printToPDF` over the print page, in a hidden
 * window with no script and no Node, so nothing in the author's text can run. The page goes
 * through a temp file because a data URL caps out around 2 MB, too small for a novel. The window
 * and the file are removed whatever happens.
 */
export async function renderPdf(html: string, pageSize: ExportPageSize): Promise<Buffer> {
  const file = path.join(os.tmpdir(), `mythscribe-export-${randomUUID()}.html`)
  fs.writeFileSync(file, html, 'utf8')
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      javascript: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  try {
    await win.loadFile(file)
    return await win.webContents.printToPDF({
      pageSize: pageSize === 'a4' ? 'A4' : 'Letter',
      printBackground: false,
      // The page's `@page` rule sets the size and the 1 in margins.
      preferCSSPageSize: true
    })
  } finally {
    win.destroy()
    fs.rmSync(file, { force: true })
  }
}
