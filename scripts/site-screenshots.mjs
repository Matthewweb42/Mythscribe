/**
 * Captures the website's product screenshots (F-15.10) from the built app.
 *
 *   npm run build            # or any run that leaves out/
 *   xvfb-run -a -s "-screen 0 1600x1000x24" node scripts/site-screenshots.mjs
 *
 * It builds a short demo novel ("The Lantern Ferry") in a throwaway project through the IPC
 * bridge, answers every AI request from a fake OpenAI server on loopback (the same approach as
 * `e2e/smoke.spec.ts`; no request leaves the machine and no key is real), drives the real UI to
 * each view, and writes `site/public/img/shot-<name>.webp` and `.png`. Recapture when the UI
 * changes. Nothing here is part of the gate suite.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { setTimeout } from 'node:timers'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'site/public/img')
const WIDTH = 1440
const HEIGHT = 900
/** Exported widths: the full shot and a smaller one for phones (`srcset`). */
const EXPORT_WIDTHS = [1600, 800]

// The openings of the system turns the fake answers (the e2e repeats the same strings).
const CHAT_AGENT =
  "You are the assistant inside a novel-writing app, working for the book's author."
const ROUTER = "You are the router inside a novel-writing app's assistant."
const EDIT_PASS = 'You are the edit-pass feature inside a novel-writing app.'
const SUMMARY = 'You are the scene-summary feature inside a novel-writing app.'
const CONTINUITY = 'You are the continuity feature inside a novel-writing app.'

// ---------------------------------------------------------------------------------------------
// The demo novel. Original text written for the site.

const p = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const doc = (paragraphs) => ({ type: 'doc', content: paragraphs.map(p) })

const TOMAS_WARNING = 'Put your hand on the rope, girl, and don’t look at the water.'
const TOMAS_WARNING_TIGHT = 'Hand on the rope, girl. Eyes off the water.'
const LINE_EDITS = [
  {
    quote: 'as if the river owed him an apology and he was content to wait for it',
    replacement: 'as if the river owed him an apology and he could wait',
    why: 'Trim the tail of the simile so the sentence lands on Tomas.'
  },
  {
    quote:
      'It was the closest thing to thanks she had heard from him all autumn, and she decided to take it.',
    replacement: 'It was the closest he had come to thanks all autumn. She took it.',
    why: 'Two short sentences match the rhythm of the exchange above.'
  }
]

const SCENES = [
  {
    chapter: 'The Harbour',
    title: 'The Last Ferry',
    meta: { location: 'Greywater docks', pov: 'Ilse', timeline: 'Day 1, dusk' },
    synopsis:
      'Ilse talks her way onto the last ferry of the day. Halfway across, the lantern burns green, and Tomas starts counting.',
    notes: [
      'Keep Tomas almost silent: the reader should feel how much he is not saying.',
      'Plant the counting here; it pays off on the Drowned Steps.'
    ],
    tags: ['ilse-varrow', 'tomas-reed', 'greywater', 'tide-lanterns', 'foreboding'],
    text: [
      'The last ferry of the day left Greywater at a quarter past six, and Ilse Varrow was on it whether Tomas liked it or not.',
      'She sat in the bow with the coil of wet rope in her lap and watched the harbour lights come on one by one along the sea wall. The tide was going out. Behind her, Tomas worked the long oar without a word, the way he had worked it for forty years, as if the river owed him an apology and he was content to wait for it.',
      '“You’ll be wanting the lantern lit,” she said.',
      '“I’ll be wanting quiet.”',
      'She lit it anyway. The wick caught, flared yellow, and settled. Tomas grunted. It was the closest thing to thanks she had heard from him all autumn, and she decided to take it.',
      'Halfway across, where the channel deepened and the water turned the colour of slate, the lantern flickered. Ilse leaned closer. The flame had gone thin and pale, and at its heart, for the space of a breath, it burned green.',
      '“Tomas.”',
      `“I see it.” He did not stop rowing. “${TOMAS_WARNING} Whatever you hear, you don’t look at the water.”`,
      'She looked at him instead. In the green light his face was older than she remembered, and he was counting under his breath: slow, careful numbers, the way her mother used to count the bells on a foggy night.'
    ]
  },
  {
    chapter: 'The Harbour',
    title: 'Green Light',
    meta: { location: 'The river crossing', pov: 'Ilse', timeline: 'Day 1, night' },
    synopsis:
      'Something passes under the ferry. Tomas reaches the far bank on the count of ninety.',
    notes: ['The thing under the boat is never described directly.'],
    tags: ['ilse-varrow', 'tomas-reed', 'tide-lanterns'],
    text: [
      'The water went still. Not calm: still, the way a held breath is still, and the ferry slid over it without a sound.',
      'Something passed beneath them. Ilse felt it through the boards before she heard it, a long slow pressure like a hand drawn down the length of the hull.',
      'Tomas kept counting. At ninety, the lantern guttered back to yellow, and the far bank came up out of the dark as if it had been there all along.'
    ]
  },
  {
    chapter: 'The Warden',
    title: 'Salt and Ledgers',
    meta: { location: 'The Salt House', pov: 'Ilse', timeline: 'Day 2, morning' },
    synopsis: 'Warden Cassel wants every green light written down. Ilse lies to her.',
    notes: ['Cassel is polite, never cruel. That is what makes her frightening.'],
    tags: ['ilse-varrow', 'warden-cassel', 'the-salt-house'],
    text: [
      'Warden Cassel kept her ledgers in a room that smelled of salt and candle wax, and she did not look up when Ilse came in.',
      '“Last night’s crossing,” she said. “The lantern. What colour was it?”',
      '“Yellow,” said Ilse, and watched the Warden’s pen stop above the page.'
    ]
  },
  {
    chapter: 'The Warden',
    title: 'The Drowned Steps',
    meta: { location: 'The Drowned Steps', pov: 'Ilse', timeline: 'Day 2, low tide' },
    synopsis: 'At the lowest tide of the year, Ilse goes down the steps alone and starts to count.',
    notes: ['Mirror the first scene: the same rope, the same numbers.'],
    tags: ['ilse-varrow', 'the-drowned-steps', 'tide-lanterns'],
    text: [
      'Twice a year the river drew back far enough to show the Drowned Steps, and twice a year the town agreed not to talk about them.',
      'Ilse went down with the lantern in one hand and the rope in the other. On the seventh step the flame turned green, and she began, very quietly, to count.'
    ]
  }
]

const ENTITIES = [
  {
    kind: 'character',
    name: 'Ilse Varrow',
    fields: {
      age: '17',
      appearance:
        'Salt-stiff braid, a ferryman’s calluses she is proud of, her mother’s grey coat.',
      personality: 'Stubborn, curious, quick to talk and slow to be told no.',
      background:
        'Daughter of the harbour bell-ringer, who drowned when Ilse was nine. Apprenticed herself to Tomas without asking him.',
      goals: 'Find out what the green light means and why nobody will say.',
      relationships: 'Tomas Reed: teacher who pretends he is not. Warden Cassel: wary.'
    }
  },
  {
    kind: 'character',
    name: 'Tomas Reed',
    fields: {
      age: '64',
      born: 'Year 1148 of the Tide Reckoning',
      gender: 'Male',
      appearance: 'Broad, weathered, missing the top of one finger. Never without his oilskin hat.',
      personality:
        'Speaks in five words where others use twenty. Kind in actions, never in speech.',
      background:
        'Forty years on the Greywater ferry. Has seen the green light more times than he admits.',
      goals: 'Keep Ilse off the river after dark. Keep his promise to her mother.',
      relationships: 'Ilse Varrow: the apprentice he never wanted. Warden Cassel: old debts.'
    }
  },
  {
    kind: 'character',
    name: 'Warden Cassel',
    fields: {
      age: '50s',
      personality: 'Courteous, exact, patient. Writes everything down.',
      goals: 'A complete record of every green light on the river.'
    }
  },
  {
    kind: 'setting',
    name: 'Greywater',
    fields: {
      type: 'Harbour town on a tidal river',
      description:
        'A town of slate roofs and sea walls where the river meets the estuary. The ferry runs from the east quay until dusk.',
      atmosphere: 'Fog, bells, wet rope, gulls arguing over the fish market.'
    }
  },
  {
    kind: 'setting',
    name: 'The Salt House',
    fields: {
      type: 'Warden’s office',
      description: 'Ledgers, candle wax, and a window over the quay.'
    }
  },
  {
    kind: 'setting',
    name: 'The Drowned Steps',
    fields: {
      type: 'Ruined stair',
      description: 'Stone steps leading down into the river, uncovered only at the lowest tides.'
    }
  },
  {
    kind: 'world',
    name: 'Tide-lanterns',
    fields: {
      category: 'Magic system',
      description:
        'Ferry lanterns trimmed with river salt. They burn yellow, except when they do not.',
      rules:
        'The flame turns green while something crosses beneath the boat. Counting aloud keeps the boat steady. Nobody knows why.',
      impact: 'The whole plot turns on what the green light is and who has been keeping count.'
    }
  }
]

// ---------------------------------------------------------------------------------------------
// The fake OpenAI server.

function ref(messages, title) {
  const seen = messages.map((m) => m.content).join('\n')
  return new RegExp(`(n\\d+) [^\\n]*› ${title}\\b`).exec(seen)?.[1] ?? 'n1'
}

function agentReply(messages) {
  const looked = messages.filter((m) => m.role === 'user' && m.content.startsWith('Result of '))
  if (looked.length === 0) return { tool: 'search', args: { query: 'Tomas warning water' } }
  if (looked.length === 1) return { tool: 'read_sheet', args: { name: 'Tomas Reed' } }
  const id = ref(messages, 'The Last Ferry')
  if (looked.length === 2) return { tool: 'read_scene', args: { id } }
  return {
    found: true,
    answer:
      'Not quite. His sheet says he speaks in five words where others use twenty, and everywhere else in the scene he is curt (“I’ll be wanting quiet.”). The warning runs long for him. A tighter line:',
    citations: [{ id, quote: 'I’ll be wanting quiet.' }, { sheet: 'Tomas Reed' }],
    edits: [{ edit: 'text', id, find: TOMAS_WARNING, replace: TOMAS_WARNING_TIGHT }]
  }
}

function answerFor(request) {
  const system = request.messages[0]?.content ?? ''
  if (system.startsWith(CHAT_AGENT)) return agentReply(request.messages)
  if (system.startsWith(ROUTER)) return { action: 'chat', instruction: null }
  if (system.startsWith(EDIT_PASS)) {
    const text = request.messages.map((m) => m.content).join('\n')
    return { changes: LINE_EDITS.filter((change) => text.includes(change.quote)) }
  }
  if (system.startsWith(CONTINUITY)) return { findings: [] }
  if (system.startsWith(SUMMARY)) {
    const user = request.messages.at(-1)?.content ?? ''
    const scene = SCENES.find((s) => user.includes(s.text[0].slice(0, 40)))
    return {
      summary: scene?.synopsis ?? 'A scene on the river.',
      keyPoints: [],
      characters: [],
      facts: [],
      tags: []
    }
  }
  return { tags: [] }
}

function startFakeOpenAi() {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.method === 'POST' && (req.url ?? '').endsWith('/chat/completions')) {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const request = JSON.parse(body)
        const json = request.response_format?.type === 'json_object'
        const content = json ? JSON.stringify(answerFor(request)) : ''
        // A short pause so the live lookup steps are on screen long enough to see.
        setTimeout(() => {
          res.end(
            JSON.stringify({
              id: 'chatcmpl-site',
              object: 'chat.completion',
              created: 0,
              model: request.model ?? 'gpt-5.4',
              choices: [
                { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }
              ],
              usage: { prompt_tokens: 2400, completion_tokens: 180, total_tokens: 2580 }
            })
          )
        }, 400)
      })
      return
    }
    const id = (req.url ?? '').split('/').pop() ?? ''
    res.end(JSON.stringify({ id, object: 'model', created: 0, owned_by: 'system' }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/v1` })
    )
  })
}

// ---------------------------------------------------------------------------------------------
// Driving the app.

async function invoke(page, channel, input) {
  const result = await page.evaluate(([c, i]) => window.mythscribe.invoke(c, i), [channel, input])
  if (!result.ok) throw new Error(`${channel} failed: ${result.error.message}`)
  return result.data
}

async function dismissToasts(page) {
  const buttons = page.getByRole('button', { name: 'Dismiss notification' })
  while ((await buttons.count()) > 0) {
    await buttons
      .first()
      .click({ timeout: 2_000 })
      .catch(() => undefined)
  }
}

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
  const { server, url } = await startFakeOpenAi()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-site-'))
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    MYTHSCRIBE_USER_DATA: path.join(tmp, 'user'),
    OPENAI_BASE_URL: url
  }
  delete env.WAYLAND_DISPLAY
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

    await invoke(page, 'project:create', {
      name: 'The Lantern Ferry',
      format: 'novel',
      directory: tmp,
      aiSwitch: 'ask'
    })
    await invoke(page, 'ai:setKey', { key: 'sk-site-demo-not-a-real-key' })

    // The starter is Arc 1 → Chapter 1 → Scene 1; rename it and grow the rest.
    const seeded = await invoke(page, 'tree:list')
    const manuscript = seeded.find((n) => n.sectionType === 'manuscript')
    const part = seeded.find((n) => n.parentId === manuscript.id)
    const chapter1 = seeded.find((n) => n.parentId === part.id)
    const scene1 = seeded.find((n) => n.parentId === chapter1.id)
    await invoke(page, 'tree:rename', { id: part.id, title: 'Part One: Low Water' })
    await invoke(page, 'tree:rename', { id: chapter1.id, title: 'The Harbour' })
    const chapter2 = await invoke(page, 'tree:create', {
      parentId: part.id,
      kind: 'folder',
      hierarchyLevel: 'chapter',
      title: 'The Warden'
    })
    const chapters = { 'The Harbour': chapter1.id, 'The Warden': chapter2.id }

    for (const entity of ENTITIES) await invoke(page, 'entity:create', entity)
    for (const name of ['foreboding']) await invoke(page, 'tag:create', { name, category: 'tone' })
    const tags = await invoke(page, 'tag:list')

    const sceneIds = {}
    for (const [index, scene] of SCENES.entries()) {
      const id =
        index === 0
          ? scene1.id
          : (
              await invoke(page, 'tree:create', {
                parentId: chapters[scene.chapter],
                kind: 'document',
                hierarchyLevel: 'scene',
                title: scene.title
              })
            ).id
      if (index === 0) await invoke(page, 'tree:rename', { id, title: scene.title })
      sceneIds[scene.title] = id
      await invoke(page, 'document:save', { id, content: doc(scene.text) })
      await invoke(page, 'notes:save', { id, notes: doc(scene.notes) })
      const { meta } = await invoke(page, 'sceneMeta:get', { id })
      await invoke(page, 'sceneMeta:set', {
        id,
        meta: { ...meta, ...scene.meta, synopsis: scene.synopsis }
      })
      for (const name of scene.tags) {
        const tag = tags.find((t) => t.name === name)
        if (tag) await invoke(page, 'documentTag:add', { nodeId: id, tagId: tag.id })
      }
    }
    await page.reload()
    await page.getByTestId('project-name').waitFor()

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
    const sidebarTabs = page.getByRole('tablist', { name: 'Sidebar' })
    await sidebarTabs.getByRole('tab', { name: 'Edits' }).click()
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
    await sidebarTabs.getByRole('tab', { name: 'Manuscript' }).click()
    await tree.getByRole('treeitem', { name: 'The Last Ferry', exact: true }).click()
    await page.getByTestId('tracked-changes-count').waitFor()
    await shoot(page, 'shot-edit-review')

    // 4. The story bible: Tomas's sheet.
    await sidebarTabs.getByRole('tab', { name: 'Characters' }).click()
    const characters = page.getByRole('tabpanel', { name: 'Characters' })
    await characters
      .getByRole('button', { name: /^Tomas Reed/ })
      .first()
      .click()
    await page.getByTestId('entity-editor').waitFor()
    await page.waitForTimeout(500)
    await shoot(page, 'shot-story-bible')
  } finally {
    await app.close()
    server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

await main()
