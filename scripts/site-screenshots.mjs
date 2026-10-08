/**
 * Captures the website's product screenshots (F-15.10) from the built app.
 *
 *   npm run build            # or any run that leaves out/
 *   xvfb-run -a -s "-screen 0 1600x1000x24" node scripts/site-screenshots.mjs [--out <dir>]
 *
 * It builds a short demo novel ("The Lantern Ferry") in a throwaway project through the IPC
 * bridge, answers every AI request from a fake OpenAI server on loopback (the same approach as
 * `e2e/smoke.spec.ts`; no request leaves the machine and no key is real), drives the real UI to
 * each view, and writes `shot-<name>.webp` and `.png` into `site/public/img/` (or `--out`, for a
 * trial run that leaves the live images alone). Recapture when the UI changes. Nothing here is
 * part of the gate suite.
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
const outFlag = process.argv.indexOf('--out')
const OUT_DIR =
  outFlag > 0 && process.argv[outFlag + 1]
    ? path.resolve(process.argv[outFlag + 1])
    : path.join(ROOT, 'site/public/img')
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
const CONTEXT_IMPORT = 'You are the context-library feature inside a novel-writing app'
const REVIEW_CHAT = 'You are the review assistant inside a novel-writing app.'

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

/** Names and titles the story bible files under one sheet (F-4.14). */
const ALIASES = { 'Tomas Reed': ['Old Reed', 'the ferryman'] }

/** The author's worldbuilding notes, uploaded to the context library (F-9.8). */
const LORE_FILE = 'lantern-lore.md'
const LORE = `# Notes on the river

Marta Varrow rang the harbour bell for twenty years. Everyone on the quay called her the bell-ringer; she drowned the winter Ilse turned nine.

Edda Cassel, the Warden, is fifty-two. She keeps the Salt House ledgers and has never once crossed the river herself.

The Tide Reckoning counts years from the night the river first ran green. Ferrymen date their contracts by it.

The East Quay is where the ferry ties up at dusk: three iron rings, a bell post, a slipway green with weed.

Theme: what a town agrees not to say.
`

/** What the fake sorts the notes into: new sheets, an update with a conflict, a note. */
const CONTEXT_ANSWER = {
  entities: [
    {
      kind: 'character',
      name: 'Marta Varrow',
      aliases: ['the bell-ringer'],
      fields: { background: 'Rang the Greywater harbour bell for twenty years. Ilse’s mother.' },
      details: ['Drowned the winter Ilse turned nine.']
    },
    {
      kind: 'character',
      name: 'Warden Cassel',
      aliases: ['Edda Cassel', 'the Warden'],
      fields: { age: '52' },
      details: ['Has never once crossed the river herself.']
    },
    {
      kind: 'world',
      name: 'The Tide Reckoning',
      aliases: [],
      fields: {
        category: 'Calendar',
        description: 'Years counted from the night the river first ran green.'
      },
      details: ['Ferrymen date their contracts by it.']
    },
    {
      kind: 'setting',
      name: 'The East Quay',
      aliases: [],
      fields: { description: 'Three iron rings, a bell post, and a slipway green with weed.' },
      details: []
    }
  ],
  notes: ['Theme: what a town agrees not to say.'],
  images: []
}
const REVIEW_REQUEST = 'Marta is Mother Varrow to the ferrymen.'

/** File › Book details, which the compile prints (F-12.4). */
const BOOK_DETAILS = {
  title: 'The Lantern Ferry',
  author: 'E. M. Hollis',
  copyrightYear: '2026',
  rights: 'All rights reserved.',
  dedication: 'For everyone who has crossed in the dark.',
  epigraph: 'Count the bells, and you will always find the shore.',
  epigraphSource: 'Greywater saying'
}

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
  if (system.startsWith(CONTEXT_IMPORT)) return CONTEXT_ANSWER
  if (system.startsWith(REVIEW_CHAT)) {
    // The review lists each item as `<id> · <name> · …`; the reply works on those ids.
    const listing = request.messages[1]?.content ?? ''
    const item =
      listing
        .split('\n')
        .find((line) => line.includes(' · Marta Varrow · '))
        ?.split(' · ')[0] ?? ''
    return {
      reply: 'Marta Varrow now also answers to Mother Varrow.',
      ops: [{ op: 'aliases', item, aliases: ['the bell-ringer', 'Mother Varrow'] }]
    }
  }
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

/** One server-sent-events chunk in the shape the OpenAI SDK parses. */
const sseChunk = (model, payload) =>
  `data: ${JSON.stringify({ id: 'chatcmpl-site', object: 'chat.completion.chunk', created: 0, model, ...payload })}\n\n`

function startFakeOpenAi() {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && (req.url ?? '').endsWith('/chat/completions')) {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const request = JSON.parse(body)
        const model = request.model ?? 'gpt-5.4'
        const system = request.messages[0]?.content ?? ''
        // The chat agent streams every step (its answer shows as it arrives), JSON or not.
        const json =
          request.response_format?.type === 'json_object' || system.startsWith(CHAT_AGENT)
        const content = json ? JSON.stringify(answerFor(request)) : ''
        // A short pause so the live lookup steps are on screen long enough to see.
        setTimeout(() => {
          if (request.stream) {
            res.setHeader('content-type', 'text/event-stream')
            const cut = Math.floor(content.length / 2)
            for (const [piece, finish] of [
              [content.slice(0, cut), null],
              [content.slice(cut), 'stop']
            ]) {
              res.write(
                sseChunk(model, {
                  choices: [{ index: 0, delta: { content: piece }, finish_reason: finish }]
                })
              )
            }
            res.write(
              sseChunk(model, {
                choices: [],
                usage: { prompt_tokens: 2400, completion_tokens: 180, total_tokens: 2580 }
              })
            )
            res.end('data: [DONE]\n\n')
            return
          }
          res.setHeader('content-type', 'application/json')
          res.end(
            JSON.stringify({
              id: 'chatcmpl-site',
              object: 'chat.completion',
              created: 0,
              model,
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
    res.setHeader('content-type', 'application/json')
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
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const { server, url } = await startFakeOpenAi()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-site-'))
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    MYTHSCRIBE_USER_DATA: path.join(tmp, 'user'),
    OPENAI_BASE_URL: url,
    // The fake key goes to a plain file under the throwaway profile: there is no OS keychain
    // under xvfb, and keys are keychain-only otherwise (honoured by unpackaged builds only).
    MYTHSCRIBE_E2E_PLAINTEXT_KEYS: '1'
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
    // A fresh install's own key is for OpenRouter; the fake speaks OpenAI's API at
    // OPENAI_BASE_URL, so the demo picks OpenAI first (as the e2e does).
    await invoke(page, 'ai:setOwnKeyProvider', { provider: 'openai' })
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

    for (const entity of ENTITIES) {
      const created = await invoke(page, 'entity:create', entity)
      const aliases = ALIASES[entity.name]
      if (aliases) await invoke(page, 'entity:update', { id: created.id, aliases })
    }
    await invoke(page, 'bookDetails:set', BOOK_DETAILS)
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
    await sidebarTabs.getByRole('tab', { name: 'Library' }).click()
    await page.getByRole('tabpanel', { name: 'Library' }).getByTestId('library-add').click()
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
    await sidebarTabs.getByRole('tab', { name: 'Manuscript' }).click()
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
