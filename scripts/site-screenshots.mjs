/**
 * Captures the website's product screenshots (F-15.10) from the built app.
 *
 *   npm run build            # or any run that leaves out/
 *   xvfb-run -a -s "-screen 0 1600x1000x24" node scripts/site-screenshots.mjs [--out <dir>]
 *
 * It builds a short demo novel ("The Lantern Ferry", `lantern-ferry.mjs`) in a throwaway project
 * through the IPC bridge, answers every AI request from a fake OpenAI server on loopback (the same
 * approach as `e2e/smoke.spec.ts`; no request leaves the machine and no key is real), drives the real UI to
 * each view, and writes `shot-<name>.webp` and `.png` into `site/public/img/` (or `--out`, for a
 * trial run that leaves the live images alone). Recapture when the UI changes. Nothing here is
 * part of the gate suite.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import {
  LORE,
  LORE_FILE,
  REVIEW_REQUEST,
  demoEnv,
  dismissToasts,
  seedLanternFerry,
  showSection,
  startFakeOpenAi
} from './lantern-ferry.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outFlag = process.argv.indexOf('--out')
const OUT_DIR =
  outFlag > 0 && process.argv[outFlag + 1]
    ? path.resolve(process.argv[outFlag + 1])
    : path.join(ROOT, 'site/public/img')
const WIDTH = 1440
const HEIGHT = 900
/** Exported widths: the full shot and a smaller one for phones (`srcset`). */
const EXPORT_WIDTHS = [1600, 800]

/** Writes `<name>.webp` and `<name>.png` at each export width, resized in the app's own Chromium. */
async function exportShot(page, name, png) {
  const base64 = png.toString('base64')
  for (const width of EXPORT_WIDTHS) {
    const encoded = await page.evaluate(
      async ([data, w]) => {
        const img = new Image()
        img.src = `data:image/png;base64,${data}`
        await img.decode()
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = Math.round((img.height * w) / img.width)
        const ctx = canvas.getContext('2d')
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        return {
          webp: canvas.toDataURL('image/webp', 0.8).split(',')[1],
          png: canvas.toDataURL('image/png').split(',')[1],
          height: canvas.height
        }
      },
      [base64, width]
    )
    const suffix = width === EXPORT_WIDTHS[0] ? '' : `-${width}`
    fs.writeFileSync(
      path.join(OUT_DIR, `${name}${suffix}.webp`),
      Buffer.from(encoded.webp, 'base64')
    )
    // The PNG fallback only at the full width; browsers that take `srcset` take WebP.
    if (!suffix)
      fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), Buffer.from(encoded.png, 'base64'))
  }
}

async function shoot(page, name, clip) {
  await dismissToasts(page)
  await page.mouse.move(0, HEIGHT - 1)
  await page.waitForTimeout(400)
  await exportShot(page, name, await page.screenshot(clip ? { clip } : {}))
  process.stdout.write(`captured ${name}\n`)
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const { server, url } = await startFakeOpenAi()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-site-'))
  const env = demoEnv(tmp, url)
  const app = await electron.launch({
    args: [ROOT, '--force-device-scale-factor=2'],
    env,
    cwd: ROOT
  })
  try {
    const page = await app.firstWindow()
    await app.evaluate(
      ({ BrowserWindow }, [w, h]) => {
        const win = BrowserWindow.getAllWindows()[0]
        win.unmaximize()
        win.setContentSize(w, h)
      },
      [WIDTH, HEIGHT]
    )
    await page.getByRole('button', { name: 'New project' }).waitFor()

    await seedLanternFerry(page, tmp)

    // 1. The writing view: the binder, the open scene, its metadata.
    const tree = page.getByRole('tree').first()
    await tree.getByRole('treeitem', { name: 'The Last Ferry', exact: true }).click()
    await page.getByRole('textbox', { name: 'Document' }).waitFor()
    await page.waitForTimeout(800)
    await shoot(page, 'shot-writing')

    // 2. The assistant in Ask: live lookups, a cited answer, an edit waiting for Apply.
    await page.keyboard.press('Control+k')
    const assistant = page.getByTestId('assistant-panel')
    await assistant.waitFor()
    await assistant.getByRole('radio', { name: 'Ask', exact: true }).click()
    const messageBox = assistant.getByRole('textbox', { name: 'Message' })
    await messageBox.fill('Does Tomas’s warning on the ferry sound like him? Tighten it if not.')
    await messageBox.press('Enter')
    const card = assistant.getByTestId('agent-change')
    await card.waitFor({ timeout: 30_000 })
    await assistant.getByText(/Looked up \d+ things/).click()
    await shoot(page, 'shot-assistant')

    // 3. The Edits tab: a line-edit pass, then its tracked changes in the scene. The setup shot
    // stops above the estimate and the report is not captured: both compare the cost with a
    // professional editor's rates, which the website does not do (the author's copy rule,
    // 2026-10-07).
    await page.keyboard.press('Control+k')
    await dismissToasts(page)
    await showSection(page, 'Edits')
    await page.getByTestId('edit-pass-new').click()
    const workspace = page.getByTestId('edit-pass-workspace')
    await workspace.getByRole('radio', { name: 'Line edit' }).check()
    const estimate = workspace.getByTestId('edit-pass-estimate')
    await estimate.waitFor()
    const estimateTop = (await estimate.boundingBox())?.y ?? HEIGHT
    await shoot(page, 'shot-edit-setup', {
      x: 0,
      y: 0,
      width: WIDTH,
      height: Math.round(estimateTop)
    })
    await workspace.getByTestId('edit-pass-start').click()
    await page.getByTestId('edit-report-diff').first().waitFor({ timeout: 30_000 })
    await showSection(page, 'Manuscript')
    await tree.getByRole('treeitem', { name: 'The Last Ferry', exact: true }).click()
    await page.getByTestId('tracked-changes-count').waitFor()
    await shoot(page, 'shot-edit-review')

    // 4. The story bible: Tomas's sheet.
    const characters = await showSection(page, 'Characters')
    await characters
      .getByRole('button', { name: /^Tomas Reed/ })
      .first()
      .click()
    await page.getByTestId('entity-editor').waitFor()
    await page.waitForTimeout(500)
    await shoot(page, 'shot-story-bible')

    // 5. The context library: the author's worldbuilding notes sorted into sheets, names and
    // titles merged under one entry, a conflict with an existing sheet, and the review chat.
    // Nothing is written until Apply.
    const loreFile = path.join(tmp, LORE_FILE)
    fs.writeFileSync(loreFile, LORE)
    await app.evaluate(
      ({ dialog }, chosen) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: chosen })
      },
      [loreFile]
    )
    const libraryPanel = await showSection(page, 'Library')
    await libraryPanel.getByTestId('library-add').click()
    const library = page.getByTestId('library-dialog')
    await library.getByTestId('library-estimate').waitFor()
    await library.getByTestId('library-confirm').click()
    const review = library.getByTestId('library-review')
    await review.waitFor({ timeout: 30_000 })
    const reviewChat = library.getByTestId('review-chat')
    await reviewChat.getByTestId('review-chat-input').fill(REVIEW_REQUEST)
    await reviewChat.getByTestId('review-chat-send').click()
    await review
      .locator('[data-item-name="Marta Varrow"]')
      .getByTestId('library-item-changed')
      .waitFor({ timeout: 30_000 })
    await shoot(page, 'shot-library-review')
    await library.getByTestId('library-apply').click()
    await library.waitFor({ state: 'detached' })

    // 6. Compile: the paperback format with its live page preview, from File › Compile….
    await showSection(page, 'Manuscript')
    await page
      .getByRole('menubar', { name: 'Application menu' })
      .getByRole('menuitem', { name: 'File' })
      .click()
    await page
      .getByRole('menu', { name: 'File' })
      .getByRole('menuitem', { name: 'Compile…' })
      .click()
    const compile = page.getByRole('dialog', { name: 'Compile' })
    await compile
      .getByRole('navigation', { name: 'Formats' })
      .getByRole('button', { name: 'Paperback 6 × 9', exact: true })
      .click()
    const preview = compile.getByTestId('compile-window-preview')
    const ready = preview.and(page.locator('[data-state="ready"]'))
    await ready.waitFor({ timeout: 60_000 })
    // Start the preview at the first chapter, so the shot shows body pages, not the title page.
    const from = compile.getByRole('combobox', { name: 'Preview from' })
    const harbour = await from
      .locator('option')
      .filter({ hasText: 'The Harbour' })
      .first()
      .getAttribute('value')
    if (harbour !== null) await from.selectOption(harbour)
    await page.waitForTimeout(500)
    await ready.waitFor({ timeout: 60_000 })
    await page.waitForTimeout(1_000)
    await shoot(page, 'shot-compile')
    await page.keyboard.press('Escape')
  } catch (error) {
    // The window as it was when a step gave up: the quickest way to see what changed in the UI.
    const failure = path.join(os.tmpdir(), 'mythscribe-site-failure.png')
    const shot = await app
      .firstWindow()
      .then((page) => page.screenshot({ path: failure }))
      .catch(() => null)
    if (shot) process.stderr.write(`window at the failure: ${failure}\n`)
    throw error
  } finally {
    await app.close()
    server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

await main()
