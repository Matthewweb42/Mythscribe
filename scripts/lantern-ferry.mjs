/**
 * The demo novel "The Lantern Ferry" and the harness around it, shared by the tooling scripts
 * that drive the built app: `site-screenshots.mjs` (the website's product shots, F-15.10) and
 * `demo-video.mjs` (the product demo video). Nothing here is part of the app or the gate suite.
 *
 * It holds the novel (scenes, story bible, the author's worldbuilding notes), a fake OpenAI
 * server on loopback that answers each request from its system turn's opening (the same approach
 * as `e2e/smoke.spec.ts`; no request leaves the machine and no key is real), the launch
 * environment, and `seedLanternFerry`, which builds the novel in a throwaway project over IPC.
 */
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { setTimeout } from 'node:timers'

// The openings of the system turns the fake answers (the e2e repeats the same strings).
export const CHAT_AGENT =
  "You are the assistant inside a novel-writing app, working for the book's author."
export const ROUTER = "You are the router inside a novel-writing app's assistant."
export const EDIT_PASS = 'You are the edit-pass feature inside a novel-writing app.'
export const SUMMARY = 'You are the scene-summary feature inside a novel-writing app.'
export const CONTINUITY = 'You are the continuity feature inside a novel-writing app.'
export const CONTEXT_IMPORT = 'You are the context-library feature inside a novel-writing app'
export const REVIEW_CHAT = 'You are the review assistant inside a novel-writing app.'
/** The prose draft behind an insertion the chat agent asks for (chat.v4's drafting rules). */
export const DRAFTING = 'You are drafting inside a novel-writing app.'

// ---------------------------------------------------------------------------------------------
// The demo novel. Original text written for the site.

const p = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
export const doc = (paragraphs) => ({ type: 'doc', content: paragraphs.map(p) })

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

export const SCENES = [
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
    kind: 'magic',
    name: 'Tide-lanterns',
    fields: {
      description:
        'Ferry lanterns trimmed with river salt. They burn yellow, except when they do not.',
      rules:
        'The flame turns green while something crosses beneath the boat. Counting aloud keeps the boat steady.',
      costs: 'Nobody knows why the counting works, or what it takes from the one who counts.',
      impact: 'The whole plot turns on what the green light is and who has been keeping count.'
    }
  }
]

/** Names and titles the story bible files under one sheet (F-4.14). */
const ALIASES = { 'Tomas Reed': ['Old Reed', 'the ferryman'] }

/** The author's worldbuilding notes, uploaded to the context library (F-9.8). */
export const LORE_FILE = 'lantern-lore.md'
export const LORE = `# Notes on the river

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
export const REVIEW_REQUEST = 'Marta is Mother Varrow to the ferrymen.'

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

/** The `nN` id the app gave a scene, as the agent's lookups list it (`n3 … › Title`). */
export function sceneRef(messages, title) {
  const seen = messages.map((m) => m.content).join('\n')
  return new RegExp(`(n\\d+) [^\\n]*› ${title}\\b`).exec(seen)?.[1] ?? 'n1'
}

/** The lookups the chat agent has made so far in this turn (each comes back as a user message). */
export const lookupsIn = (messages) =>
  messages.filter((m) => m.role === 'user' && m.content.startsWith('Result of '))

/** The author's message the chat agent is working on. */
export const askedIn = (messages) =>
  [...messages].reverse().find((m) => m.role === 'user' && !m.content.startsWith('Result of '))
    ?.content ?? ''

/** The site's assistant shot: three lookups, then a cited answer with one text edit. */
function agentReply(messages) {
  const looked = lookupsIn(messages)
  if (looked.length === 0) return { tool: 'search', args: { query: 'Tomas warning water' } }
  if (looked.length === 1) return { tool: 'read_sheet', args: { name: 'Tomas Reed' } }
  const id = sceneRef(messages, 'The Last Ferry')
  if (looked.length === 2) return { tool: 'read_scene', args: { id } }
  return {
    found: true,
    answer:
      'Not quite. His sheet says he speaks in five words where others use twenty, and everywhere else in the scene he is curt (“I’ll be wanting quiet.”). The warning runs long for him. A tighter line:',
    citations: [{ id, quote: 'I’ll be wanting quiet.' }, { sheet: 'Tomas Reed' }],
    edits: [{ edit: 'text', id, find: TOMAS_WARNING, replace: TOMAS_WARNING_TIGHT }]
  }
}

/**
 * The JSON answer for a request, by its system turn's opening. `agent` answers the chat agent's
 * steps (the site's assistant shot by default).
 */
export function answerFor(request, agent = agentReply) {
  const system = request.messages[0]?.content ?? ''
  if (system.startsWith(CHAT_AGENT)) return agent(request.messages)
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Starts the fake on a free loopback port. Options:
 * - `agent(messages)`: the chat agent's next step (default: the site's assistant shot);
 * - `prose(request)`: the plain-text answer to a non-JSON request (default: empty);
 * - `delayMs`: the pause before each answer, so live lookup steps stay on screen (default 400);
 * - `proseChunkMs`: when set, plain prose streams word by word with this gap (default: in two
 *   pieces at once, like the JSON answers).
 */
export function startFakeOpenAi(options = {}) {
  const { agent = agentReply, prose = () => '', delayMs = 400, proseChunkMs = 0 } = options
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
        const content = json ? JSON.stringify(answerFor(request, agent)) : prose(request)
        setTimeout(async () => {
          if (request.stream) {
            res.setHeader('content-type', 'text/event-stream')
            const cut = Math.floor(content.length / 2)
            const pieces =
              !json && proseChunkMs > 0
                ? content.split(/(?<=\s)/)
                : [content.slice(0, cut), content.slice(cut)]
            for (const [index, piece] of pieces.entries()) {
              const last = index === pieces.length - 1
              res.write(
                sseChunk(model, {
                  choices: [
                    { index: 0, delta: { content: piece }, finish_reason: last ? 'stop' : null }
                  ]
                })
              )
              if (!json && proseChunkMs > 0 && !last) await wait(proseChunkMs)
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
        }, delayMs)
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

/** The environment the built app launches with: a throwaway profile and the fake as OpenAI. */
export function demoEnv(tmp, url) {
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
  return env
}

export async function invoke(page, channel, input) {
  const result = await page.evaluate(([c, i]) => window.mythscribe.invoke(c, i), [channel, input])
  if (!result.ok) throw new Error(`${channel} failed: ${result.error.message}`)
  return result.data
}

/**
 * The sidebar section picker (F-9.11): the button that opens it and the option for `name`,
 * which sits behind "Show unused sections" while the section is empty.
 */
export function sectionPicker(page) {
  const button = page.getByRole('button', { name: /^Section: / })
  const list = page.getByRole('listbox', { name: 'Sections' })
  return {
    button,
    list,
    option: (name) => list.getByRole('option', { name, exact: true }),
    unused: list.getByRole('option', { name: /^Show unused sections/ }),
    panel: (name) => page.getByRole('region', { name: `${name} section`, exact: true })
  }
}

/** Shows a sidebar section through the picker (instantly; the demo video glides instead). */
export async function showSection(page, name) {
  const picker = sectionPicker(page)
  await picker.button.click()
  if ((await picker.option(name).count()) === 0) await picker.unused.click()
  await picker.option(name).click()
  await picker.list.waitFor({ state: 'detached' })
  return picker.panel(name)
}

export async function dismissToasts(page) {
  const buttons = page.getByRole('button', { name: 'Dismiss notification' })
  while ((await buttons.count()) > 0) {
    await buttons
      .first()
      .click({ timeout: 2_000 })
      .catch(() => undefined)
  }
}

/**
 * Builds "The Lantern Ferry" in a new project under `tmp` (Ask, the fake's key), reloads the
 * window, and returns the scenes' ids by title.
 */
export async function seedLanternFerry(page, tmp) {
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
  // Cost lines name and price the app's real defaults (OpenRouter's DeepSeek pair), not OpenAI's.
  await invoke(page, 'ai:setModels', {
    provider: 'openai',
    models: { fast: 'deepseek/deepseek-v4-flash', strong: 'deepseek/deepseek-v4-pro' }
  })
  // The novel is in British spelling; keep the spellchecker's underline off it.
  for (const word of ['colour', 'harbour']) await invoke(page, 'dictionary:add', { word })

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
  return sceneIds
}
