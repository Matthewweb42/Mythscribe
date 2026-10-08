/**
 * Records the product demo video from the built app: about 90 seconds, silent, title cards
 * between the sections, the real app on screen and every AI answer scripted.
 *
 *   npm run demo:video -- [--out <dir>] [--skip-build | --edit-only]
 *
 * Writes `mythscribe-demo.mp4` (H.264, 1080p, title cards), `mythscribe-hero.webm` (a short
 * loop for the website hero, no cards), `stills/*.png` (six frames to review), and `raw/` (the
 * unedited recording and the cards) into `--out` (default: `mythscribe-demo/` in the OS temp
 * folder). Video files never go into the repository.
 *
 * Three steps, each Node-heavy one under `flock /tmp/mythscribe-heavy.lock` where `flock`
 * exists: `electron-vite build` (skip with `--skip-build`), the recording (this script again
 * with `--record`, under `xvfb-run` on a 1920×1080 screen), and the edit (ffmpeg: `MYTHSCRIBE_FFMPEG`,
 * else `ffmpeg-static` if installed with `npm i --no-save ffmpeg-static@5.3.0` (not a dependency:
 * it has no Windows on Arm build and broke the personal install), else `ffmpeg` on PATH; `--edit-only` redoes just this step from `raw/`). The recording builds "The Lantern Ferry" (`lantern-ferry.mjs`)
 * in a throwaway project over IPC, answers AI from a fake OpenAI on loopback (no key, no
 * network), and drives the UI like a person: a drawn cursor that glides to each control, a soft
 * highlight on what it points at, typing at a human pace, and a badge for each shortcut pressed.
 * Playwright records the window at 1280×720 CSS pixels ×1.5, so the video is a sharp 1920×1080.
 * Recapture when the UI changes. Nothing here is part of the gate suite.
 */
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright'

/** ffmpeg for the edit step; see the header for where it comes from. */
async function findFfmpeg() {
  if (process.env.MYTHSCRIBE_FFMPEG) return process.env.MYTHSCRIBE_FFMPEG
  const bundled = await import('ffmpeg-static').then(
    (m) => m.default,
    () => null
  )
  if (bundled) return bundled
  if (spawnSync('ffmpeg', ['-version']).status === 0) return 'ffmpeg'
  throw new Error(
    'No ffmpeg: set MYTHSCRIBE_FFMPEG, run `npm i --no-save ffmpeg-static@5.3.0`, or install ffmpeg'
  )
}
const ffmpegPath = process.argv.includes('--record') ? null : await findFfmpeg()
import {
  DRAFTING,
  LORE,
  LORE_FILE,
  REVIEW_REQUEST,
  askedIn,
  demoEnv,
  dismissToasts,
  lookupsIn,
  sceneRef,
  sectionPicker,
  seedLanternFerry,
  showSection,
  startFakeOpenAi
} from './lantern-ferry.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELF = fileURLToPath(import.meta.url)
const LOCK = '/tmp/mythscribe-heavy.lock'

const argValue = (name) => {
  const at = process.argv.indexOf(name)
  return at > 0 ? process.argv[at + 1] : undefined
}
const OUT_DIR = path.resolve(argValue('--out') ?? path.join(os.tmpdir(), 'mythscribe-demo'))
const RAW_DIR = path.join(OUT_DIR, 'raw')
const MANIFEST = path.join(RAW_DIR, 'manifest.json')

/** The window in CSS pixels, its scale, and the video it makes (1280 × 1.5 = 1920). */
const VIEW = { width: 1280, height: 720 }
const SCALE = 1.5
const VIDEO = { width: 1920, height: 1080 }
const FPS = 30
const CARD_SECONDS = 2.4
const FADE = 0.35
/** Seconds of each section the website loop takes, from its highlight mark. */
const HERO_SECONDS = 4.5
const HERO_XFADE = 0.5

// ---------------------------------------------------------------------------------------------
// The script: title cards and the scripted AI.

/** Title cards, in the website's style. Copy rules: assistance first, no "tokens", no stats. */
const CARDS = {
  intro: {
    brand: true,
    title: 'The novel-writing app that remembers your book.',
    sub: 'A quiet place to write, with an assistant that has read every page.'
  },
  write: {
    title: 'Write in a quiet editor, organised your way.',
    sub: 'Chapters and scenes in the binder, notes and a synopsis beside every scene, and a focus mode when it is just you and the page.'
  },
  ask: {
    title: 'Ask your book anything. It knows where you are.',
    sub: 'Answers come from your own scenes and notes, as of the scene you are writing, with the passages they rest on.'
  },
  draft: {
    title: 'Let it draft. You decide what stays.',
    sub: 'Suggestions arrive as grey ghost text in your scene. Tab keeps one; nothing enters your book until you say so.'
  },
  upload: {
    title: 'Upload your worldbuilding. It sorts it.',
    sub: 'Your notes become story-bible sheets, with names and aliases merged. Review every change before it is applied.'
  },
  compile: {
    title: 'Compile print-ready books and ebooks.',
    sub: 'Paperback PDF, EPUB, Word, and Markdown, with a live preview of every page.'
  },
  end: {
    brand: true,
    title: 'mythscribe.app',
    sub: 'Your book, your voice, with help when you want it.'
  }
}

/** The order of the finished video: a card, then the section it introduces. */
const SEQUENCE = [
  ['card', 'intro'],
  ['card', 'write'],
  ['clip', 'write'],
  ['card', 'ask'],
  ['clip', 'ask'],
  ['card', 'draft'],
  ['clip', 'draft'],
  ['card', 'upload'],
  ['clip', 'upload'],
  ['card', 'compile'],
  ['clip', 'compile'],
  ['card', 'end']
]

const ASK_QUESTION = 'What does Ilse know about the green light so far?'
const WRITE_REQUEST = 'Write the next beat: the Warden doesn’t believe her.'
const TYPED_LINE = ' Somewhere below her, something was counting back.'
const FOCUS_LINE = 'The water answered in green.'

/** The prose the drafting request streams into the scene as ghost text. */
const DRAFT = [
  'The Warden set her pen down without writing anything. “Yellow,” she said, as if trying the word for size. “Tomas Reed was waiting on my step at six this morning, Miss Varrow. He has not done that in eleven years.”',
  'She turned the ledger round so Ilse could read it. Under last night’s date, in the Warden’s small exact hand, one word was already written: green.'
].join('\n\n')

/** The chat agent's steps: lookups first, then the answer (or the insertion for a request). */
function demoAgent(messages) {
  const asked = askedIn(messages)
  const looked = lookupsIn(messages)
  const here = sceneRef(messages, 'Salt and Ledgers')
  if (asked === WRITE_REQUEST) {
    if (looked.length === 0)
      return { tool: 'search', args: { query: 'Warden Cassel ledger lantern colour' } }
    return {
      found: true,
      answer: 'Here is the next beat, at your cursor. Tab keeps it.',
      citations: [],
      edits: [
        {
          edit: 'insert',
          id: here,
          after: '',
          brief: 'Cassel lets the lie sit, then shows Ilse she already knows.',
          words: 70
        }
      ]
    }
  }
  if (looked.length === 0) return { tool: 'search', args: { query: 'green light lantern' } }
  if (looked.length === 1) return { tool: 'read_sheet', args: { name: 'Ilse Varrow' } }
  return {
    found: true,
    answer:
      'As of this scene, she has seen it once. Halfway across on the last ferry the lantern burned green, something passed under the boat, and Tomas counted until the flame went back to yellow. Nobody has told her what it means, and she has just told the Warden it was yellow.',
    citations: [
      {
        id: sceneRef(messages, 'The Last Ferry'),
        quote: 'for the space of a breath, it burned green'
      },
      {
        id: sceneRef(messages, 'Green Light'),
        quote: 'At ninety, the lantern guttered back to yellow'
      },
      { id: here, quote: 'watched the Warden’s pen stop above the page' }
    ]
  }
}

const demoProse = (request) =>
  (request.messages[0]?.content ?? '').startsWith(DRAFTING) ? DRAFT : ''

// ---------------------------------------------------------------------------------------------
// Acting like a person.

/** A small seeded random, so every run types and moves the same way. */
let seed = 7
const random = () => {
  seed = (seed * 16807) % 2147483647
  return (seed - 1) / 2147483646
}

/** The drawn cursor, the hover highlight, and the shortcut badge (recordings show no cursor). */
const OVERLAY_CSS = `
#demo-cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; z-index: 2147483647;
  pointer-events: none; transform: translate(-100px, -100px); filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.45)); }
#demo-cursor::after { content: ''; position: absolute; left: -9px; top: -9px; width: 18px; height: 18px;
  border-radius: 50%; background: rgb(52 211 153 / 0.45); transform: scale(0); opacity: 0;
  transition: transform 0.25s ease-out, opacity 0.45s ease-out; }
#demo-cursor.down::after { transform: scale(1.6); opacity: 1; transition: none; }
#demo-hover { position: fixed; z-index: 2147483646; pointer-events: none; border-radius: 8px;
  border: 2px solid rgb(52 211 153 / 0.55); background: rgb(52 211 153 / 0.07); opacity: 0;
  transition: opacity 0.2s ease, left 0.15s ease, top 0.15s ease, width 0.15s ease, height 0.15s ease; }
#demo-key { position: fixed; left: 50%; bottom: 36px; z-index: 2147483647; pointer-events: none;
  transform: translateX(-50%) translateY(8px); opacity: 0; transition: opacity 0.2s ease, transform 0.2s ease;
  font: 600 15px/1 Inter, system-ui, sans-serif; color: #e7efec; background: rgb(8 22 30 / 0.9);
  border: 1px solid rgb(110 231 183 / 0.6); border-radius: 8px; padding: 9px 14px; letter-spacing: 0.02em;
  box-shadow: 0 6px 24px rgb(0 0 0 / 0.35); display: flex; align-items: center; gap: 6px; }
#demo-key kbd { font: 600 14px/1 Inter, system-ui, sans-serif; color: #6ee7b7; background: rgb(52 211 153 / 0.12);
  border: 1px solid rgb(110 231 183 / 0.45); border-bottom-width: 2px; border-radius: 5px; padding: 4px 8px; }
#demo-key kbd:last-of-type { margin-right: 6px; }
#demo-key.on { opacity: 1; transform: translateX(-50%) translateY(0); }`

const CURSOR_SVG =
  '<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg"><path d="M3 2 L3 18 L7.5 13.8 L10.6 20.4 L13.4 19.1 L10.4 12.6 L16.6 12.6 Z" fill="#ffffff" stroke="#0b1d27" stroke-width="1.4" stroke-linejoin="round"/></svg>'

/** What the hover highlight outlines: small controls, never the editor or a whole panel. */
const HOVERABLE =
  'button, a, select, input:not([type="hidden"]), [role="treeitem"] > *:first-child, [role="tab"], [role="radio"], [role="menuitem"], [role="option"], label'

async function installOverlay(page) {
  await page.evaluate(
    ([css, svg]) => {
      if (document.getElementById('demo-cursor')) return
      const style = document.createElement('style')
      style.textContent = css
      document.head.append(style)
      const cursor = document.createElement('div')
      cursor.id = 'demo-cursor'
      cursor.innerHTML = svg
      const hover = document.createElement('div')
      hover.id = 'demo-hover'
      const key = document.createElement('div')
      key.id = 'demo-key'
      document.body.append(hover, cursor, key)
    },
    [OVERLAY_CSS, CURSOR_SVG]
  )
}

const pointer = { x: VIEW.width / 2, y: VIEW.height / 2 }

/** Moves the real mouse and the drawn cursor together, and outlines the control underneath. */
async function pointAt(page, x, y, hoverable) {
  await page.mouse.move(x, y)
  pointer.x = x
  pointer.y = y
  await page.evaluate(
    ([px, py, selector]) => {
      const cursor = document.getElementById('demo-cursor')
      const hover = document.getElementById('demo-hover')
      if (!cursor || !hover) return
      cursor.style.transform = `translate(${px - 3}px, ${py - 2}px)`
      const under = selector ? document.elementFromPoint(px, py)?.closest(selector) : null
      const box = under?.getBoundingClientRect()
      if (!box || box.width > 520 || box.height > 160) {
        hover.style.opacity = '0'
        return
      }
      hover.style.left = `${box.left - 3}px`
      hover.style.top = `${box.top - 3}px`
      hover.style.width = `${box.width + 6}px`
      hover.style.height = `${box.height + 6}px`
      hover.style.opacity = '1'
    },
    [x, y, hoverable ? HOVERABLE : '']
  )
}

/** Glides the cursor to a point along an eased path, at a hand's pace. */
async function glide(page, x, y) {
  const from = { ...pointer }
  const distance = Math.hypot(x - from.x, y - from.y)
  const steps = Math.max(8, Math.min(26, Math.round(distance / 28)))
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
    await pointAt(page, from.x + (x - from.x) * eased, from.y + (y - from.y) * eased, i === steps)
    await sleep(14)
  }
}

async function centerOf(locator, at) {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  if (!box) throw new Error(`no box for ${locator}`)
  return at === 'end'
    ? { x: box.x + box.width - 6, y: box.y + box.height - 10 }
    : { x: box.x + Math.min(box.width / 2, 120), y: box.y + box.height / 2 }
}

async function hoverOn(page, locator) {
  await locator.waitFor({ state: 'visible', timeout: 30_000 })
  const { x, y } = await centerOf(locator)
  await glide(page, x, y)
}

/** Glides to a control, rests a moment, and clicks it with a ripple. */
async function click(page, locator, options = {}) {
  await locator.waitFor({ state: 'visible', timeout: 30_000 })
  const { x, y } = await centerOf(locator, options.at)
  await glide(page, x, y)
  await sleep(220)
  await page.evaluate(() => document.getElementById('demo-cursor')?.classList.add('down'))
  await page.mouse.down()
  await page.mouse.up()
  await sleep(90)
  await page.evaluate(() => {
    document.getElementById('demo-cursor')?.classList.remove('down')
    const hover = document.getElementById('demo-hover')
    if (hover) hover.style.opacity = '0'
  })
}

/** Types at a human pace: a little uneven, slower after punctuation. */
async function type(page, text) {
  for (const char of text) {
    await page.keyboard.type(char)
    const base = /[.,!?:]/.test(char) ? 100 : char === ' ' ? 50 : 32
    await sleep(base + random() * 40)
  }
}

/** Presses a shortcut and shows it in a badge, since a silent video cannot show a keypress. */
async function press(page, key, chord, caption) {
  await page.evaluate(
    ([keys, text]) => {
      const badge = document.getElementById('demo-key')
      if (!badge) return
      badge.replaceChildren()
      for (const part of keys) {
        const kbd = document.createElement('kbd')
        kbd.textContent = part
        badge.append(kbd)
      }
      if (text) badge.append(text)
      badge.classList.add('on')
      window.clearTimeout(Number(badge.dataset.timer ?? 0))
      badge.dataset.timer = String(window.setTimeout(() => badge.classList.remove('on'), 1300))
    },
    [chord, caption]
  )
  await sleep(350)
  await page.keyboard.press(key)
}

/** Shows a sidebar section through the section picker, by hand; returns its panel. */
async function pickSection(page, name) {
  const picker = sectionPicker(page)
  await click(page, picker.button)
  await picker.list.waitFor()
  await sleep(500)
  if ((await picker.option(name).count()) === 0) {
    await click(page, picker.unused)
    await sleep(400)
  }
  await click(page, picker.option(name))
  await picker.list.waitFor({ state: 'detached' })
  return picker.panel(name)
}

// ---------------------------------------------------------------------------------------------
// The recording.

const marks = {}
const mark = (name) => {
  marks[name] = Date.now()
}

async function record() {
  fs.mkdirSync(RAW_DIR, { recursive: true })
  const { server, url } = await startFakeOpenAi({
    agent: demoAgent,
    prose: demoProse,
    delayMs: 450,
    proseChunkMs: 38
  })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-demo-'))
  const launchedAt = Date.now()
  const app = await electron.launch({
    args: [ROOT, `--force-device-scale-factor=${SCALE}`],
    env: demoEnv(tmp, url),
    cwd: ROOT,
    recordVideo: { dir: RAW_DIR, size: VIDEO }
  })
  let page
  try {
    page = await app.firstWindow()
    await app.evaluate(
      ({ BrowserWindow }, [w, h]) => {
        const win = BrowserWindow.getAllWindows()[0]
        win.unmaximize()
        win.setPosition(0, 0)
        win.setContentSize(w, h)
      },
      [VIEW.width, VIEW.height]
    )
    await page.getByRole('button', { name: 'New project' }).waitFor()
    const sceneIds = await seedLanternFerry(page, tmp)
    await installOverlay(page)
    const tree = page.getByRole('tree').first()
    const scene = (title) => tree.getByRole('treeitem', { name: title, exact: true })
    const editor = page.getByRole('textbox', { name: 'Document' })
    const notesToggle = page.getByRole('button', { name: 'Notes', exact: true })
    const notesPanel = page.getByTestId('notes-panel')

    // Off camera: open the first scene, close the notes so they open on camera, and let the
    // background indexing (summaries, five seconds after open) finish.
    await scene('The Last Ferry').click()
    await editor.waitFor()
    if ((await notesPanel.count()) > 0) await notesToggle.click()
    await sleep(7_000)
    await dismissToasts(page)
    await pointAt(page, VIEW.width * 0.62, VIEW.height * 0.55, false)

    // 1. Writing: the binder, typing, the notes and synopsis, focus mode.
    mark('write.start')
    await sleep(600)
    await click(page, scene('The Drowned Steps'))
    await sleep(700)
    await click(page, editor.locator('p').last(), { at: 'end' })
    await page.keyboard.press('End')
    mark('write.hl')
    await type(page, TYPED_LINE)
    await sleep(500)
    await click(page, notesToggle)
    await notesPanel.waitFor()
    await sleep(400)
    await hoverOn(page, notesPanel.getByRole('textbox', { name: 'Synopsis' }))
    mark('write.still')
    await sleep(1_400)
    await click(page, editor.locator('p').last(), { at: 'end' })
    await press(page, 'F11', ['F11'], 'Focus mode')
    await page.getByTestId('focus-control-bar').waitFor({ state: 'attached' })
    await sleep(1_000)
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await type(page, FOCUS_LINE)
    await sleep(1_000)
    await press(page, 'Escape', ['Esc'], 'Leave focus mode')
    await sleep(1_000)
    mark('write.end')

    // Off camera: back to a calm layout, with the scene the questions are about.
    if ((await notesPanel.count()) > 0) await notesToggle.click()
    await scene('Salt and Ledgers').click()
    await sleep(800)
    await dismissToasts(page)

    // 2. Ask: a question about the book, answered from it as of the open scene.
    mark('ask.start')
    await sleep(600)
    await press(page, 'Control+k', ['Ctrl', 'K'], 'Assistant')
    const assistant = page.getByTestId('assistant-panel')
    await assistant.waitFor()
    await sleep(300)
    await click(page, assistant.getByRole('radio', { name: 'Ask', exact: true }))
    const messageBox = assistant.getByRole('textbox', { name: 'Message' })
    await click(page, messageBox)
    await type(page, ASK_QUESTION)
    await sleep(400)
    await page.keyboard.press('Enter')
    mark('ask.hl')
    await assistant.getByText('As of this scene').waitFor({ timeout: 30_000 })
    await sleep(400)
    await pointAt(page, VIEW.width * 0.55, VIEW.height * 0.4, false)
    mark('ask.still')
    await sleep(2_800)
    mark('ask.end')

    // 3. Draft: the assistant writes the next beat; it lands as ghost text and Tab keeps it.
    await editor.click()
    await page.keyboard.press('Control+End')
    await dismissToasts(page)
    mark('draft.start')
    await sleep(400)
    await click(page, messageBox)
    await type(page, WRITE_REQUEST)
    await sleep(300)
    await page.keyboard.press('Enter')
    const ghost = editor.locator('.ghost-text')
    await ghost.first().waitFor({ timeout: 30_000 })
    mark('draft.hl')
    await assistant.getByTestId('agent-change').last().waitFor({ timeout: 30_000 })
    await page.waitForFunction(
      (tail) => document.querySelector('.ghost-text')?.textContent?.includes(tail),
      'already written: green.',
      { timeout: 30_000 }
    )
    await sleep(600)
    await hoverOn(page, ghost.last())
    mark('draft.still')
    await sleep(800)
    await editor.focus()
    await press(page, 'Tab', ['Tab'], 'Keep it')
    await ghost.first().waitFor({ state: 'detached', timeout: 10_000 })
    await sleep(1_500)
    mark('draft.end')

    // Off camera: close the assistant, stub the file dialog with the author's notes.
    await page.keyboard.press('Control+k')
    await dismissToasts(page)
    const loreFile = path.join(tmp, LORE_FILE)
    fs.writeFileSync(loreFile, LORE)
    await app.evaluate(
      ({ dialog }, chosen) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: chosen })
      },
      [loreFile]
    )

    // 4. Upload: worldbuilding notes sorted into sheets, a change asked in the review chat,
    // applied into the story bible.
    mark('upload.start')
    await sleep(400)
    const libraryPanel = await pickSection(page, 'Library')
    await sleep(300)
    await click(page, libraryPanel.getByTestId('library-add'))
    const library = page.getByTestId('library-dialog')
    await library.getByTestId('library-estimate').waitFor()
    await sleep(300)
    await click(page, library.getByTestId('library-confirm'))
    const review = library.getByTestId('library-review')
    await review.waitFor({ timeout: 30_000 })
    mark('upload.hl')
    await sleep(900)
    const reviewChat = library.getByTestId('review-chat')
    await click(page, reviewChat.getByTestId('review-chat-input'))
    await type(page, REVIEW_REQUEST)
    await sleep(300)
    await click(page, reviewChat.getByTestId('review-chat-send'))
    const marta = review.locator('[data-item-name="Marta Varrow"]')
    await marta.getByTestId('library-item-changed').waitFor({ timeout: 30_000 })
    await sleep(500)
    await hoverOn(page, marta)
    mark('upload.still')
    await sleep(1_100)
    await click(page, library.getByTestId('library-apply'))
    await library.waitFor({ state: 'detached' })
    await sleep(300)
    const characters = await pickSection(page, 'Characters')
    await click(page, characters.getByRole('button', { name: /^Marta Varrow/ }).first())
    await page.getByTestId('entity-editor').waitFor()
    await sleep(1_500)
    mark('upload.end')

    // Off camera: back to the manuscript, a save dialog that answers a throwaway file.
    await showSection(page, 'Manuscript')
    await scene('The Last Ferry').click()
    await dismissToasts(page)
    // A short, readable path for the "Compiled to" notice; the file is removed afterwards.
    const book = path.join(os.tmpdir(), 'Books', 'The Lantern Ferry.pdf')
    fs.mkdirSync(path.dirname(book), { recursive: true })
    await app.evaluate(({ dialog }, chosen) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: chosen })
    }, book)

    // 5. Compile: the Paperback 6 × 9 with its live page preview, then the PDF.
    mark('compile.start')
    await sleep(400)
    const menubar = page.getByRole('menubar', { name: 'Application menu' })
    await click(page, menubar.getByRole('menuitem', { name: 'File' }))
    await sleep(300)
    await click(
      page,
      page.getByRole('menu', { name: 'File' }).getByRole('menuitem', { name: 'Compile…' })
    )
    const compile = page.getByRole('dialog', { name: 'Compile' })
    await sleep(500)
    await click(
      page,
      compile
        .getByRole('navigation', { name: 'Formats' })
        .getByRole('button', { name: 'Paperback 6 × 9', exact: true })
    )
    const ready = compile
      .getByTestId('compile-window-preview')
      .and(page.locator('[data-state="ready"]'))
    await ready.waitFor({ timeout: 60_000 })
    const from = compile.getByRole('combobox', { name: 'Preview from' })
    const harbour = await from
      .locator('option')
      .filter({ hasText: 'The Harbour' })
      .first()
      .getAttribute('value')
    await hoverOn(page, from)
    if (harbour !== null) await from.selectOption(harbour)
    await sleep(500)
    await ready.waitFor({ timeout: 60_000 })
    mark('compile.hl')
    await pointAt(page, VIEW.width * 0.7, VIEW.height * 0.5, false)
    mark('compile.still')
    await sleep(1_800)
    await click(page, compile.getByRole('button', { name: 'Compile', exact: true }))
    await page.getByRole('status').filter({ hasText: 'Compiled to' }).waitFor({ timeout: 60_000 })
    await sleep(1_800)
    mark('compile.end')
    if (!fs.existsSync(book)) throw new Error('the compile wrote no PDF')
    fs.rmSync(book)
    if (!sceneIds['Salt and Ledgers']) throw new Error('the demo novel has no Salt and Ledgers')

    // The title cards, rendered in the app's own Chromium (a second window, after the takes).
    const cards = await renderCards(app)
    const closedAt = Date.now()
    const video = await page.video()?.path()
    await app.close()
    fs.writeFileSync(
      MANIFEST,
      JSON.stringify({ video, launchedAt, closedAt, marks, cards }, null, 2)
    )
  } catch (error) {
    const failure = path.join(RAW_DIR, 'failure.png')
    const shot = page ? await page.screenshot({ path: failure }).catch(() => null) : null
    if (shot) process.stderr.write(`window at the failure: ${failure}\n`)
    await app.close().catch(() => undefined)
    throw error
  } finally {
    server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------------------------
// Title cards.

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function cardHtml(card) {
  const fonts = pathToFileURL(path.join(ROOT, 'site/public/fonts')).href
  const icon = pathToFileURL(path.join(ROOT, 'resources/icon.png')).href
  const brand = card.brand
    ? `<div class="brand"><img src="${icon}" alt=""><span><span class="myth">Myth</span><span class="scribe">Scribe</span></span></div>`
    : `<div class="mark"><img src="${icon}" alt=""><span>MythScribe</span></div>`
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Fraunces; font-weight: 400 700; src: url('${fonts}/fraunces-latin.woff2') format('woff2'); }
@font-face { font-family: Inter; font-weight: 400 700; src: url('${fonts}/inter-latin.woff2') format('woff2'); }
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
body { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 26px;
  background: radial-gradient(ellipse 70% 60% at 50% 38%, rgb(16 185 129 / 0.16), transparent 70%),
    radial-gradient(ellipse 90% 80% at 50% 120%, #0f2531, transparent 70%), #050f15;
  color: #e7efec; font-family: Inter, system-ui, sans-serif; text-align: center; padding: 0 120px; box-sizing: border-box; }
.mark { position: absolute; top: 40px; left: 52px; display: flex; align-items: center; gap: 10px;
  font: 600 17px Inter, sans-serif; color: #9fb3ad; letter-spacing: 0.01em; }
.mark img { width: 28px; height: 28px; }
.brand { display: flex; align-items: center; gap: 16px; font: 600 54px Fraunces, serif; letter-spacing: -0.01em; }
.brand img { width: 64px; height: 64px; filter: drop-shadow(0 0 22px rgb(52 211 153 / 0.35)); }
.myth { color: #e7efec; font-weight: 400; }
.scribe { background: linear-gradient(135deg, #6ee7b7, #10b981); -webkit-background-clip: text; color: transparent; }
h1 { margin: 0; max-width: 980px; font: 500 58px/1.12 Fraunces, serif; letter-spacing: -0.015em; }
p { margin: 0; max-width: 820px; font: 400 22px/1.5 Inter, sans-serif; color: #9fb3ad; }
.rule { width: 72px; height: 3px; border-radius: 2px; background: #34d399; box-shadow: 0 0 18px rgb(52 211 153 / 0.6); }
</style></head><body>${brand}<h1>${escapeHtml(card.title)}</h1><div class="rule"></div><p>${escapeHtml(card.sub)}</p></body></html>`
}

async function renderCards(app) {
  const files = {}
  for (const [name, card] of Object.entries(CARDS)) {
    const html = path.join(RAW_DIR, `card-${name}.html`)
    fs.writeFileSync(html, cardHtml(card))
    const png = await app.evaluate(
      async ({ BrowserWindow }, [file, w, h]) => {
        const win = new BrowserWindow({ width: w, height: h, show: true, frame: false })
        await win.loadFile(file)
        // The fonts, then a short settle so the first paint is complete.
        await win.webContents.executeJavaScript(
          'document.fonts.ready.then(() => new Promise((done) => setTimeout(done, 300)))'
        )
        const image = await win.webContents.capturePage()
        win.destroy()
        return image.toPNG().toString('base64')
      },
      [html, VIEW.width, VIEW.height]
    )
    files[name] = path.join(RAW_DIR, `card-${name}.png`)
    fs.writeFileSync(files[name], Buffer.from(png, 'base64'))
  }
  return files
}

// ---------------------------------------------------------------------------------------------
// The edit.

const hasFlock = spawnSync('sh', ['-c', 'command -v flock'], { stdio: 'ignore' }).status === 0

/** Runs a Node-heavy command, under the shared lock where `flock` exists. */
function heavy(command, args, options = {}) {
  const [cmd, argv] = hasFlock ? ['flock', [LOCK, command, ...args]] : [command, args]
  const result = spawnSync(cmd, argv, { stdio: 'inherit', cwd: ROOT, ...options })
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`)
}

/** The recorder's start: the webm's `creation_time` (Playwright stamps it to the millisecond). */
function videoStart(video, fallback) {
  const probe = spawnSync(ffmpegPath, ['-hide_banner', '-i', video], { encoding: 'utf8' })
  const stamp = /creation_time\s*:\s*(\S+)/.exec(probe.stderr ?? '')?.[1]
  const parsed = stamp ? Date.parse(stamp) : NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

const fixed = (n) => n.toFixed(3)

function edit() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  const start = videoStart(manifest.video, manifest.launchedAt)
  const at = (name) => (manifest.marks[name] - start) / 1000
  const clips = Object.fromEntries(
    ['write', 'ask', 'draft', 'upload', 'compile'].map((name) => [
      name,
      {
        from: at(`${name}.start`),
        to: at(`${name}.end`),
        hl: at(`${name}.hl`),
        still: at(`${name}.still`)
      }
    ])
  )

  // The demo: cards and clips joined with short fades through the ink-navy ground.
  const inputs = ['-i', manifest.video]
  const filters = []
  const parts = []
  const timeline = []
  let clock = 0
  const clipCount = SEQUENCE.filter(([kind]) => kind === 'clip').length
  filters.push(
    `[0:v]split=${clipCount}${SEQUENCE.filter(([kind]) => kind === 'clip')
      .map((_, i) => `[src${i}]`)
      .join('')}`
  )
  let clipIndex = 0
  for (const [index, [kind, name]] of SEQUENCE.entries()) {
    const label = `[p${index}]`
    if (kind === 'card') {
      inputs.push(
        '-loop',
        '1',
        '-framerate',
        String(FPS),
        '-t',
        String(CARD_SECONDS),
        '-i',
        manifest.cards[name]
      )
      const input = inputs.filter((arg) => arg === '-i').length - 1
      filters.push(
        `[${input}:v]scale=${VIDEO.width}:${VIDEO.height}:flags=lanczos,fps=${FPS},format=yuv420p,setsar=1,` +
          `fade=t=in:st=0:d=${FADE},fade=t=out:st=${fixed(CARD_SECONDS - FADE)}:d=${FADE}${label}`
      )
      timeline.push({ kind, name, at: clock, length: CARD_SECONDS })
      clock += CARD_SECONDS
    } else {
      const clip = clips[name]
      const length = clip.to - clip.from
      filters.push(
        `[src${clipIndex}]trim=start=${fixed(clip.from)}:end=${fixed(clip.to)},setpts=PTS-STARTPTS,` +
          `scale=${VIDEO.width}:${VIDEO.height}:flags=lanczos,fps=${FPS},format=yuv420p,setsar=1,` +
          `fade=t=in:st=0:d=${FADE},fade=t=out:st=${fixed(length - FADE)}:d=${FADE}${label}`
      )
      timeline.push({ kind, name, at: clock, length, still: clip.still - clip.from })
      clock += length
      clipIndex++
    }
    parts.push(label)
  }
  filters.push(`${parts.join('')}concat=n=${parts.length}:v=1:a=0[out]`)
  const mp4 = path.join(OUT_DIR, 'mythscribe-demo.mp4')
  heavy(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...inputs,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[out]',
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(FPS),
    '-movflags',
    '+faststart',
    '-an',
    mp4
  ])

  // The website loop: the strongest seconds of each section, cross-faded, no cards.
  const heroParts = []
  const heroFilters = ['[0:v]split=5[h0][h1][h2][h3][h4]']
  for (const [i, name] of ['write', 'ask', 'draft', 'upload', 'compile'].entries()) {
    const clip = clips[name]
    const from = Math.max(clip.from, Math.min(clip.hl, clip.to - HERO_SECONDS))
    heroFilters.push(
      `[h${i}]trim=start=${fixed(from)}:end=${fixed(from + HERO_SECONDS)},setpts=PTS-STARTPTS,` +
        `scale=1280:720:flags=lanczos,fps=${FPS},format=yuv420p,setsar=1[x${i}]`
    )
    heroParts.push(`[x${i}]`)
  }
  let previous = heroParts[0]
  for (let i = 1; i < heroParts.length; i++) {
    const offset = i * (HERO_SECONDS - HERO_XFADE)
    const out = i === heroParts.length - 1 ? '[hero]' : `[xf${i}]`
    heroFilters.push(
      `${previous}${heroParts[i]}xfade=transition=fade:duration=${HERO_XFADE}:offset=${fixed(offset)}${out}`
    )
    previous = out
  }
  const webm = path.join(OUT_DIR, 'mythscribe-hero.webm')
  heavy(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    manifest.video,
    '-filter_complex',
    heroFilters.join(';'),
    '-map',
    '[hero]',
    '-c:v',
    'libvpx-vp9',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '36',
    '-b:v',
    '0',
    '-row-mt',
    '1',
    '-an',
    webm
  ])

  // Six stills to review: the intro card and a moment from each section.
  const stills = path.join(OUT_DIR, 'stills')
  fs.mkdirSync(stills, { recursive: true })
  const moments = [
    ['1-intro-card', timeline[0].at + CARD_SECONDS / 2],
    ...timeline
      .filter((part) => part.kind === 'clip')
      .map((part, i) => [`${i + 2}-${part.name}`, part.at + part.still + 0.3])
  ]
  for (const [name, second] of moments) {
    heavy(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      fixed(second),
      '-i',
      mp4,
      '-frames:v',
      '1',
      path.join(stills, `${name}.png`)
    ])
  }

  const size = (file) => `${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB`
  process.stdout.write(
    `demo:  ${mp4} (${clock.toFixed(1)} s, ${size(mp4)})\n` +
      `hero:  ${webm} (${(5 * HERO_SECONDS - 4 * HERO_XFADE).toFixed(1)} s, ${size(webm)})\n` +
      `stills: ${stills}\n`
  )
  for (const part of timeline)
    process.stdout.write(`  ${part.kind} ${part.name.padEnd(8)} ${part.length.toFixed(1)} s\n`)
}

// ---------------------------------------------------------------------------------------------

if (process.argv.includes('--record')) {
  await record()
} else {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const editOnly = process.argv.includes('--edit-only')
  if (!editOnly && !process.argv.includes('--skip-build')) heavy('npx', ['electron-vite', 'build'])
  const recordArgs = [SELF, '--record', '--out', OUT_DIR]
  if (editOnly) process.stdout.write(`re-editing the recording in ${RAW_DIR}\n`)
  else if (process.platform === 'linux')
    heavy('xvfb-run', [
      '-a',
      '-s',
      `-screen 0 ${VIDEO.width}x${VIDEO.height}x24`,
      process.execPath,
      ...recordArgs
    ])
  else heavy(process.execPath, recordArgs)
  edit()
}
