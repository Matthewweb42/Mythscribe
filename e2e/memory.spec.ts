import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import type { IpcResult, ProjectInfo, TreeNode } from '../src/shared/ipc/contract'
import type { ResearchDoc } from '../src/shared/research'
import type { TiptapNodeT } from '../src/shared/tiptap'
import { caretToEnd, clickIntoEditor } from './support'

/**
 * Story memory v2 (FEATURES.md §2.16; plan P1). The app is launched with
 * `MYTHSCRIBE_STORY_MEMORY=v2` (honoured only in unpackaged builds). Slices 2 to 4 run with Use AI
 * off, and slice 5 checks that nothing reached a model before it: `OPENAI_BASE_URL` points at a
 * fake provider on loopback that records every request, and the Cloud URL at a closed local port.
 * The smoke test (`smoke.spec.ts`) keeps covering v1 and is not edited for P1.
 *
 * P1 slice 2 (F-16.8, the Not canon parts of F-16.6): the Research section is in the picker and
 * not in the Manuscript tree; a Markdown upload opens as an editable page; a paragraph is marked
 * Not canon; the page is switched Not canon; word search finds it as a source document; the
 * compiled preview leaves it out.
 *
 * P1 slice 3 (F-16.6, F-16.7, F-16.11, the v2 shell): the picker lists v2's sections only; a
 * record is made with a nickname, and creating that nickname warns through the twin gate; Pinned
 * and Ideas lines are saved; *Same as* merges a second record and *Split* brings it back; a
 * surname is shared by two records; a tone label is made, put on a scene and filtered by; Mara is
 * the scene's POV; a click in her *Named in* selects her name in the scene; `#` opens no
 * suggestion; a file dropped on the window becomes a Research page.
 *
 * P1 slice 4 (F-16.12, F-16.10, F-16.13, F-16.4): This scene, Needs a look, Dismissed, Rename in
 * book.
 *
 * P1 slice 5 (F-16.14, F-16.9, F-16.7), Use AI on with an own OpenAI key at the fake: ghost text
 * sends the Story notes block (and the panel's *What the AI is told* shows the same block); a
 * Research upload is filed into Pinned through the estimate and the deck, the line carries its
 * "Filed from" mark, and editing the source sentence raises a Needs a look conflict.
 *
 * P1 slice 6 (F-16.15), a second launch without the override: a v1 project with a character tag
 * typed inline goes through Help › Try the story-memory switch-over on a copy…; the dry run lists
 * the tag as a record; the consent screen's replacement is edited to "Mara"; the copy reopens on
 * v2 with plain "Mara" and a Mara record; the original reopens as v1 with its inline tag.
 */

let app: ElectronApplication
let page: Page
let tmp: string
let exited = false

/** The key the fake provider is given (any well-formed key; the fake does not check it). */
const OWN_KEY = 'sk-live-memory-5678'
/** F-16.9: the opening of `contextImport.v3`'s rules; the fake files the bestiary for it. */
const FILING_SENTINEL =
  "You are the filing feature inside a novel-writing app, filing the author's research document " +
  "into the pinned notes of their story's records."
/** F-16.14: the Story notes block's first line (`STORY_NOTES_HEADING`). */
const STORY_NOTES_HEADING = 'Story notes (the manuscript wins'
/** What the fake answers a plain completion (ghost text) with. */
const GHOST_ANSWER = 'The lamps along the quay were already lit.'
/** The Research page slice 5 files: its last paragraph is the one the filed line quotes. */
const BESTIARY =
  '# Bestiary\n\nThe fen-wight is a pale thing that hunts the marsh at dusk.\n\n' +
  'Mara Vell keeps a fen-wight skull above her door.\n'
const FILED_LINE = 'Keeps a fen-wight skull above her door'
/** The fake's filing answer: a line for Mara (an addition) and a new record, each quoted. */
const FILING_ANSWER = JSON.stringify({
  records: [
    {
      name: 'Mara Vell',
      category: 'character',
      aliases: [],
      lines: [{ text: FILED_LINE, q: 'keeps a fen-wight skull above her door' }]
    },
    {
      name: 'Fen-wight',
      category: 'creature',
      aliases: [],
      lines: [{ text: 'Hunts the marsh at dusk', q: 'a pale thing that hunts the marsh at dusk' }]
    }
  ],
  categories: [],
  images: []
})

/** Every chat request the fake provider saw: JSON mode or not, and its messages. */
const providerBodies: { json: boolean; messages: { role: string; content: string }[] }[] = []
let provider: http.Server

/**
 * A fake OpenAI-compatible provider on loopback: a filing request (its sentinel) gets
 * `FILING_ANSWER`, any other JSON request an empty object, a plain one `GHOST_ANSWER` (streamed
 * when asked); `GET /models/<id>` echoes the id.
 */
function startFakeProvider(): Promise<string> {
  provider = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.method !== 'POST' || !(req.url ?? '').endsWith('/chat/completions')) {
      const id = (req.url ?? '').split('/').pop() ?? ''
      res.end(JSON.stringify({ id, object: 'model', created: 0, owned_by: 'system' }))
      return
    }
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
    })
    req.on('end', () => {
      const request = JSON.parse(body) as {
        model: string
        stream?: boolean
        response_format?: { type?: string }
        messages: { role: string; content: string }[]
      }
      const json = request.response_format?.type === 'json_object'
      providerBodies.push({ json, messages: request.messages })
      const filing = request.messages[0]?.content.startsWith(FILING_SENTINEL) === true
      const content = filing ? FILING_ANSWER : json ? '{}' : GHOST_ANSWER
      const usage = { prompt_tokens: 400, completion_tokens: 40, total_tokens: 440 }
      const base = { id: 'chatcmpl-fake', created: 0, model: request.model }
      if (request.stream === true) {
        res.setHeader('content-type', 'text/event-stream')
        const chunk = (payload: object): string =>
          `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', ...payload })}\n\n`
        res.write(chunk({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] }))
        res.write(chunk({ choices: [], usage }))
        res.end('data: [DONE]\n\n')
        return
      }
      res.end(
        JSON.stringify({
          ...base,
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage
        })
      )
    })
  })
  return new Promise((resolve) => {
    provider.listen(0, '127.0.0.1', () => {
      const address = provider.address()
      if (!address || typeof address === 'string') throw new Error('the fake provider has no port')
      resolve(`http://127.0.0.1:${address.port}/v1`)
    })
  })
}

/** A word nothing else in the project holds, so search and compile can be asked about it. */
const RESEARCH_WORD = 'Quillback'
const TYPED = ' The reef drops away past the second buoy.'
const SECOND_PARAGRAPH = 'Maybe the lighthouse keeper lied about the wreck.'

/** The launch environment without the story-memory override (slice 6 launches on v1 with it). */
let baseEnv: Record<string, string>

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-e2e-memory-'))
  const providerUrl = await startFakeProvider()
  baseEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (e): e is [string, string] => e[1] !== undefined && e[0] !== 'MYTHSCRIBE_STORY_MEMORY'
      )
    ),
    NODE_ENV: 'test',
    MYTHSCRIBE_USER_DATA: path.join(tmp, 'userData'),
    MYTHSCRIBE_E2E_PLAINTEXT_KEYS: '1',
    // Nothing leaves the machine: the own-key provider is the fake on loopback, and a closed
    // port answers any Cloud request at once.
    OPENAI_BASE_URL: providerUrl,
    MYTHSCRIBE_CLOUD_API_URL: 'http://127.0.0.1:9'
  }
  const env = { ...baseEnv, MYTHSCRIBE_STORY_MEMORY: 'v2' }
  app = await electron.launch({ args: ['.'], env })
  app.on('close', () => {
    exited = true
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  if (!exited) await app?.close()
  provider?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function invoke<T>(channel: string, input: unknown): Promise<T> {
  const result = await page.evaluate<IpcResult<T>, { channel: string; input: unknown }>(
    ({ channel: name, input: value }) =>
      window.mythscribe.invoke(name as never, value) as Promise<IpcResult<T>>,
    { channel, input }
  )
  if (!result.ok) throw new Error(`${channel} failed: ${result.error.message}`)
  return result.data
}

/** Shows a sidebar section through the picker (the unused ones behind "Show unused sections"). */
async function showSection(name: string): Promise<void> {
  await page.getByRole('button', { name: /^Section: / }).click()
  const list = page.getByRole('listbox', { name: 'Sections' })
  const option = list.getByRole('option', { name, exact: true })
  if ((await option.count()) === 0) {
    await list.getByRole('option', { name: /^Show unused sections/ }).click()
  }
  await option.click()
  await expect(list).toHaveCount(0)
}

/** The paragraphs of a stored page, each with its Not canon mark. */
async function storedParagraphs(id: string): Promise<{ text: string; notCanon: boolean }[]> {
  const stored = await invoke<{ content: TiptapNodeT | null }>('document:get', { id })
  return (stored.content?.content ?? [])
    .filter((block) => block.type === 'paragraph')
    .map((block) => ({
      text: (block.content ?? []).map((child) => child.text ?? '').join(''),
      notCanon: block.attrs?.notCanon === true
    }))
}

test('story memory v2: the Research section and Not canon pages (P1 slice 2)', async () => {
  // Create a project through the wizard with Use AI off; the dev override runs it on v2.
  const projectPath = path.join(tmp, 'Memory Novel.mythscribe')
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath })
  }, projectPath)
  await page.getByRole('button', { name: 'New project' }).click()
  const wizard = page.getByRole('dialog')
  await wizard.getByRole('textbox', { name: 'Project name' }).fill('Memory Novel')
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await expect(wizard).toContainText('Step 4 of 5')
  await wizard.getByText('Off', { exact: true }).click()
  await expect(wizard.getByRole('radio', { name: /^off/i })).toBeChecked()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByTestId('project-name')).toHaveText('Memory Novel')
  const info = await invoke<ProjectInfo | null>('project:current', undefined)
  expect(info?.storyMemory).toBe('v2')

  // F-16.8: the v2 open made the Research root, after end matter.
  const roots = (await invoke<TreeNode[]>('tree:list', undefined)).filter(
    (n) => n.parentId === null
  )
  expect(roots.map((n) => n.sectionType)).toEqual(['front', 'manuscript', 'end', 'research'])

  // Research is in the picker; the Manuscript tree does not show it.
  await page.getByRole('button', { name: /^Section: / }).click()
  await expect(
    page.getByRole('listbox', { name: 'Sections' }).getByRole('option', { name: 'Research' })
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await showSection('Manuscript')
  const bookTree = page.getByRole('tree', { name: 'Document tree' })
  await expect(bookTree.getByRole('treeitem', { name: 'Manuscript' })).toBeVisible()
  await expect(bookTree.getByRole('treeitem', { name: 'Research' })).toHaveCount(0)

  // Add a .md file through the (stubbed) open dialog: it opens as an editable page.
  const notes = path.join(tmp, 'Reef notes.md')
  fs.writeFileSync(
    notes,
    `# The reef\n\n${RESEARCH_WORD} rockfish live forty fathoms down.\n\n${SECOND_PARAGRAPH}\n`
  )
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] })
  }, notes)
  await showSection('Research')
  const researchTree = page.getByRole('tree', { name: 'Document tree' })
  await expect(researchTree.getByRole('treeitem', { name: 'Research' })).toBeVisible()
  await expect(researchTree.getByRole('treeitem', { name: 'Manuscript' })).toHaveCount(0)
  await page
    .getByRole('toolbar', { name: 'Research' })
    .getByRole('button', { name: 'Add files…' })
    .click()
  await expect(researchTree.getByRole('treeitem', { name: 'Reef notes' })).toBeVisible()
  const researchPage = page.getByTestId('research-page')
  await expect(researchPage.getByRole('heading', { name: 'Reef notes' })).toBeVisible()
  await expect(researchPage.getByTestId('research-source')).toHaveText(
    'Uploaded from Reef notes.md'
  )
  const editor = page.getByRole('textbox', { name: 'Research page' })
  await expect(editor).toContainText(`${RESEARCH_WORD} rockfish live forty fathoms down.`)
  const nodeId =
    (await invoke<TreeNode[]>('tree:list', undefined)).find((n) => n.title === 'Reef notes')?.id ??
    ''
  expect(nodeId).not.toBe('')

  // Edit it: the typed words are saved with the page.
  await caretToEnd(editor)
  await page.keyboard.type(TYPED)
  await expect
    .poll(async () => (await storedParagraphs(nodeId)).map((p) => p.text).at(-1))
    .toBe(`${SECOND_PARAGRAPH}${TYPED}`)

  // Mark the paragraph Not canon from the page's toolbar: it is muted and stored marked.
  const notCanon = page
    .getByRole('toolbar', { name: 'Page' })
    .getByRole('button', { name: 'Not canon' })
  await expect(notCanon).toHaveAttribute('aria-pressed', 'false')
  await notCanon.click()
  await expect(notCanon).toHaveAttribute('aria-pressed', 'true')
  await expect(editor.locator('p[data-not-canon]')).toHaveCount(1)
  await expect(editor.locator('p[data-not-canon]')).toContainText(SECOND_PARAGRAPH)
  await expect
    .poll(async () => (await storedParagraphs(nodeId)).map((p) => p.notCanon))
    .toEqual([false, true])
  // The first paragraph is still canon until the page itself is switched.
  await editor.getByText(`${RESEARCH_WORD} rockfish`, { exact: false }).click()
  await expect(notCanon).toHaveAttribute('aria-pressed', 'false')

  // Switch the whole page Not canon.
  await researchPage.getByRole('switch').click()
  await expect(researchPage).toHaveAttribute('data-not-canon', 'true')
  await expect
    .poll(async () =>
      (await invoke<ResearchDoc[]>('research:list', undefined)).find((d) => d.nodeId === nodeId)
    )
    .toMatchObject({ origin: 'upload', fileType: 'md', notCanon: true })

  // Word search finds it, labelled a source document.
  const searchDialog = page.getByRole('dialog', { name: 'Search project' })
  await page.keyboard.press('Control+Shift+F')
  await expect(searchDialog).toBeVisible()
  await expect(searchDialog.getByRole('button', { name: 'Source documents' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await searchDialog.getByRole('searchbox', { name: 'Search the project' }).fill(RESEARCH_WORD)
  const hit = searchDialog.getByTestId('search-result-research')
  await expect(hit).toHaveCount(1)
  await expect(hit).toContainText('Reef notes')
  await expect(hit).toContainText('Source document')
  await expect(searchDialog.getByTestId('search-result-document')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(searchDialog).toHaveCount(0)

  // The compiled preview leaves Research out.
  await page
    .getByRole('menubar', { name: 'Application menu' })
    .getByRole('menuitem', { name: 'View' })
    .click()
  await page
    .getByRole('menu', { name: 'View' })
    .getByRole('menuitem', { name: 'Compiled preview' })
    .click()
  const compiled = page.getByRole('dialog', { name: 'Compiled preview' })
  const preview = compiled.getByTestId('compile-preview')
  await expect(preview).toBeVisible()
  await expect(preview).not.toContainText(RESEARCH_WORD)
  await expect(preview).not.toContainText('Reef notes')
  await page.keyboard.press('Escape')
  await expect(compiled).toHaveCount(0)
})

/** One record as `record:get` answers it, with its pages' text. */
interface StoredRecord {
  id: string
  name: string
  aliases: { id: string; text: string; shared: boolean }[]
  pinned: TiptapNodeT | null
  ideas: TiptapNodeT | null
}

const pageText = (doc: TiptapNodeT | null): string =>
  (doc?.content ?? [])
    .map((block) => (block.content ?? []).map((child) => child.text ?? '').join(''))
    .join('\n')

test('story memory v2: sheets, labels, typed details and the v2 editor (P1 slice 3)', async () => {
  // Continues in the project the slice 2 test made. Records replace the v1 sheets and tags.
  const sectionNames = async (): Promise<string[]> => {
    await page.getByRole('button', { name: /^Section: / }).click()
    const list = page.getByRole('listbox', { name: 'Sections' })
    const unused = list.getByRole('option', { name: /^Show unused sections/ })
    if ((await unused.count()) > 0) await unused.click()
    const names = await list.getByRole('option').allTextContents()
    await page.keyboard.press('Escape')
    await expect(list).toHaveCount(0)
    return names
  }
  // (The thread category stays, as a plain record list, until P2b.)
  const names = (await sectionNames()).join(' | ')
  for (const gone of ['Index', 'Timeline', 'Library', 'To do', 'Changes']) {
    expect(names).not.toMatch(new RegExp(`(^| )${gone}( |\\d|$)`))
  }
  expect(names).toContain('Research')
  expect(names).toContain('Outline')

  // F-16.6: create "Mara Vell" in Characters; the gate is clear, so it is made and opened.
  await showSection('Characters')
  const createDialog = page.getByRole('dialog', { name: 'New character' })
  await page.getByRole('button', { name: 'New character…' }).click()
  await createDialog.getByRole('textbox', { name: 'Name' }).fill('Mara Vell')
  await createDialog.getByRole('button', { name: 'Create' }).click()
  await expect(createDialog).toHaveCount(0)
  const sheet = page.getByTestId('record-sheet')
  await expect(sheet.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Mara Vell')
  const records = (): Promise<StoredRecord[]> => invoke<StoredRecord[]>('record:list', undefined)
  const maraId = (await records()).find((r) => r.name === 'Mara Vell')?.id ?? ''
  expect(maraId).not.toBe('')

  // Add the nickname "Mara".
  await sheet.getByRole('textbox', { name: 'New nickname' }).fill('Mara')
  await sheet.getByRole('button', { name: 'Add', exact: true }).click()
  const nicknames = sheet.getByRole('list', { name: 'Nicknames' })
  await expect(nicknames.getByRole('listitem', { name: 'Mara' })).toBeVisible()

  // Creating "Mara" now shows the twin gate's warning (decision P1-D4: warned, never blocked).
  await page.getByRole('button', { name: 'New character…' }).click()
  await createDialog.getByRole('textbox', { name: 'Name' }).fill('Mara')
  const warning = createDialog.getByTestId('record-gate-warning')
  await expect(warning).toContainText('Looks like Mara Vell')
  await expect(warning.getByRole('button', { name: 'Same as Mara Vell' })).toBeVisible()
  await expect(warning.getByRole('button', { name: 'Create anyway' })).toBeVisible()
  await expect(createDialog.getByRole('button', { name: 'Create', exact: true })).toBeDisabled()
  await createDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(createDialog).toHaveCount(0)

  // A Pinned line and an Ideas line, each saved on the record's own page.
  const pinned = sheet.getByRole('textbox', { name: 'Pinned' })
  await caretToEnd(pinned)
  await page.keyboard.type('Eyes: grey as the harbour.')
  const ideas = sheet.getByRole('textbox', { name: 'Ideas' })
  await caretToEnd(ideas)
  await page.keyboard.type('Maybe she was a smuggler once.')
  await expect
    .poll(async () => {
      const stored = await invoke<StoredRecord>('record:get', { id: maraId })
      return [pageText(stored.pinned), pageText(stored.ideas)]
    })
    .toEqual(['Eyes: grey as the harbour.', 'Maybe she was a smuggler once.'])

  // A second record, then Same as: it joins Mara Vell; Split brings it back.
  await page.getByRole('button', { name: 'New character…' }).click()
  await createDialog.getByRole('textbox', { name: 'Name' }).fill('Tomas Harrow')
  await createDialog.getByRole('button', { name: 'Create' }).click()
  await expect(createDialog).toHaveCount(0)
  await expect(sheet.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(
    'Tomas Harrow'
  )
  await page
    .getByRole('list', { name: 'Characters' })
    .getByRole('button', { name: /^Mara Vell/ })
    .click()
  await expect(sheet.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Mara Vell')
  await sheet.getByRole('button', { name: 'Same as…' }).click()
  await sheet
    .getByRole('combobox', { name: /Which record is the same/ })
    .selectOption({ label: 'Tomas Harrow' })
  await expect(sheet).toContainText('Tomas Harrow becomes part of Mara Vell')
  await sheet.getByRole('button', { name: 'Merge into Mara Vell' }).click()
  await expect(nicknames.getByRole('listitem', { name: 'Tomas Harrow' })).toBeVisible()
  await expect.poll(async () => (await records()).map((r) => r.name)).toEqual(['Mara Vell'])
  await sheet.getByRole('button', { name: 'Split…' }).click()
  await sheet.getByRole('checkbox', { name: 'Tomas Harrow' }).check()
  await sheet.getByRole('button', { name: 'Split into a new record' }).click()
  await expect(nicknames.getByRole('listitem', { name: 'Tomas Harrow' })).toHaveCount(0)
  await expect
    .poll(async () => (await records()).map((r) => r.name).sort())
    .toEqual(['Mara Vell', 'Tomas Harrow'])
  // Merged pages stay on Mara's sheet.
  await expect(pinned).toContainText('Eyes: grey as the harbour.')

  // Identity rule 4: Tomas has the surname "Harrow"; adding it to Mara offers to share it, and
  // Share marks it shared on both.
  const characters = page.getByRole('list', { name: 'Characters' })
  await characters.getByRole('button', { name: /^Tomas Harrow/ }).click()
  await expect(sheet.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(
    'Tomas Harrow'
  )
  await sheet.getByRole('textbox', { name: 'New nickname' }).fill('Harrow')
  await sheet.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(nicknames.getByRole('listitem', { name: 'Harrow' })).toBeVisible()
  await characters.getByRole('button', { name: /^Mara Vell/ }).click()
  await expect(sheet.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Mara Vell')
  await sheet.getByRole('textbox', { name: 'New nickname' }).fill('Harrow')
  await sheet.getByRole('button', { name: 'Add', exact: true }).click()
  const share = page.getByRole('dialog', { name: 'Share “Harrow”?' })
  await expect(share).toContainText('already a name of Tomas Harrow')
  await share.getByRole('button', { name: 'Share' }).click()
  await expect(nicknames.getByRole('listitem', { name: 'Harrow' })).toContainText(
    'Shared with Tomas Harrow'
  )
  await expect
    .poll(async () =>
      (await records())
        .flatMap((r) => r.aliases.filter((a) => a.text === 'Harrow').map((a) => [r.name, a.shared]))
        .sort()
    )
    .toEqual([
      ['Mara Vell', true],
      ['Tomas Harrow', true]
    ])

  // F-16.7 and F-16.11: open the first scene; its details take a tone label and Mara as POV.
  const scene = (await invoke<TreeNode[]>('tree:list', undefined)).find(
    (n) => n.kind === 'document' && n.hierarchyLevel === 'scene'
  )
  if (!scene) throw new Error('no scene in the seed')
  await showSection('Manuscript')
  const bookTree = page.getByRole('tree', { name: 'Document tree' })
  await bookTree.getByRole('treeitem', { name: scene.title }).first().click()
  await expect(sheet).toHaveCount(0)
  const notesColumn = page.getByTestId('notes-panel')
  if ((await notesColumn.count()) === 0) {
    await page.getByRole('button', { name: 'Notes', exact: true }).click()
  }
  const detailsToggle = notesColumn.getByRole('button', { name: 'Scene details' })
  if ((await detailsToggle.getAttribute('aria-expanded')) !== 'true') await detailsToggle.click()
  const metadata = notesColumn.getByRole('group', { name: 'Scene metadata' })
  await expect(metadata.getByRole('combobox', { name: 'Location' })).toHaveCount(0)

  // A tone label, made in the Labels dialog and put on the scene.
  await metadata.getByRole('button', { name: 'Manage labels…' }).click()
  const labelsDialog = page.getByRole('dialog', { name: 'Labels' })
  await labelsDialog.getByRole('textbox', { name: 'New label name' }).fill('Wry')
  await labelsDialog.getByRole('combobox', { name: 'New label kind' }).selectOption('tone')
  await labelsDialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(labelsDialog.getByRole('listitem', { name: 'Wry' })).toBeVisible()
  await labelsDialog.getByRole('button', { name: 'Done' }).click()
  await expect(labelsDialog).toHaveCount(0)
  await metadata.getByRole('combobox', { name: 'Add a label' }).selectOption({ label: 'Wry' })
  await expect(metadata.getByTestId('label-chip')).toHaveText(['Wry'])

  // The Manuscript tree filters by it.
  await page.getByRole('combobox', { name: 'Filter by label' }).selectOption({ label: 'Wry' })
  await expect(page.getByText('1 document carries Wry')).toBeVisible()
  await expect(bookTree.getByRole('treeitem', { name: scene.title })).toBeVisible()
  await page.getByRole('button', { name: 'Clear filter' }).click()

  // Mara as the POV, stored as the record's id.
  const pov = metadata.getByRole('combobox', { name: 'POV' })
  await expect(pov).toBeEnabled()
  await pov.selectOption({ label: 'Mara Vell' })
  await expect
    .poll(
      async () =>
        (await invoke<{ povRecordId: string | null }>('sceneDetail:get', { nodeId: scene.id }))
          .povRecordId
    )
    .toBe(maraId)

  // F-16.5, F-16.6: the scene names Mara Vell; once the local name scan has run, her sheet's
  // Named in lists the scene, and a click there selects her name in it.
  const editor = page.getByRole('textbox', { name: 'Document' })
  await caretToEnd(editor)
  await page.keyboard.type(' Mara Vell waited by the steps.')
  await expect
    .poll(
      async () =>
        (await invoke<{ recordId: string; nodeId: string }[]>('names:byRecord', undefined)).some(
          (row) => row.recordId === maraId && row.nodeId === scene.id
        ),
      { timeout: 15_000 }
    )
    .toBe(true)
  await showSection('Characters')
  await characters.getByRole('button', { name: /^Mara Vell/ }).click()
  const namedIn = sheet.getByRole('region', { name: 'Named in' })
  await namedIn.getByRole('button', { name: new RegExp(scene.title) }).click()
  await expect(sheet).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
    .toBe('Mara Vell')

  // F-16.4: typing # in the scene opens no tag suggestion (tags are gone in v2).
  await caretToEnd(editor)
  await page.keyboard.type(' #Ma')
  await expect(editor).toContainText('#Ma')
  await expect(page.getByRole('listbox', { name: 'Tag suggestions' })).toHaveCount(0)
  // Nor is there a tags column or its toggle.
  await expect(page.getByRole('button', { name: 'Tags', exact: true })).toHaveCount(0)

  // F-16.8: a file dropped on the window becomes a Research page (no Library, no sort).
  await page.evaluate(() => {
    const files = new DataTransfer()
    files.items.add(new File(['The tide turns at the second buoy.'], 'Harbour log.md'))
    const options = { dataTransfer: files, bubbles: true, cancelable: true }
    window.dispatchEvent(new DragEvent('dragenter', options))
    window.dispatchEvent(new DragEvent('drop', options))
  })
  const researchTree = page.getByRole('tree', { name: 'Document tree' })
  await expect(researchTree.getByRole('treeitem', { name: 'Harbour log' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Research page' })).toContainText(
    'The tide turns at the second buoy.'
  )
  expect(
    (await invoke<ResearchDoc[]>('research:list', undefined)).filter((d) => d.origin === 'upload')
  ).toHaveLength(2)
})

/** The stored plain text of a document, paragraphs joined by new lines. */
async function storedText(id: string): Promise<string> {
  return (await storedParagraphs(id)).map((paragraph) => paragraph.text).join('\n')
}

test('story memory v2: This scene, Needs a look, Dismissed and Rename in book (P1 slice 4)', async () => {
  // Continues in the project the slice 3 test made (Mara Vell, nickname "Mara", and Tomas Harrow).
  const scenes = (await invoke<TreeNode[]>('tree:list', undefined)).filter(
    (n) => n.kind === 'document' && n.hierarchyLevel === 'scene'
  )
  const first = scenes[0]
  if (!first) throw new Error('no scene in the seed')
  const records = (): Promise<StoredRecord[]> => invoke<StoredRecord[]>('record:list', undefined)
  const maraId = (await records()).find((r) => r.name === 'Mara Vell')?.id ?? ''
  await showSection('Manuscript')
  const bookTree = page.getByRole('tree', { name: 'Document tree' })
  await bookTree.getByRole('treeitem', { name: first.title }).first().click()
  const editor = page.getByRole('textbox', { name: 'Document' })
  await clickIntoEditor(editor)
  await page.keyboard.press('Control+A')
  await page.keyboard.type('Mara walked in.')

  // F-16.12: the This scene panel sits in the tags panel's slot (its header toggle in v2).
  const panel = page.getByTestId('this-scene-panel')
  if ((await panel.count()) === 0) {
    await page.getByRole('button', { name: 'This scene', exact: true }).click()
  }
  await expect(panel.getByRole('tab', { name: 'This scene' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  // Here: the POV the slice 3 test chose.
  await expect(panel.getByRole('region', { name: 'Here' }).getByLabel('POV')).toHaveValue(maraId)

  // F-16.5: "Mara walked in." gives a Named chip once the local scan has read the saved text
  // (the scene named "Mara Vell" before, so the chip is waited for on the new mention).
  await expect
    .poll(
      async () =>
        (await invoke<{ text: string }[]>('names:forNode', { nodeId: first.id })).map(
          (m) => m.text
        ),
      { timeout: 15_000 }
    )
    .toEqual(['Mara'])
  const chips = panel.getByTestId('named-chips')
  const maraChip = chips.getByRole('button', { name: /^Mara Vell/ })
  await expect(maraChip).toBeVisible({ timeout: 15_000 })
  await expect(maraChip).toHaveAttribute('title', 'named once: ¶1')

  // Not a mention takes it off and lands on the one Dismissed list (F-16.10).
  const before = (await invoke<{ count: number }>('dismissed:list', undefined)).count
  await maraChip.click()
  const why = panel.getByRole('group', { name: 'Why Mara Vell is here' })
  await why.getByRole('button', { name: 'Not a mention' }).click()
  await expect(maraChip).toHaveCount(0)
  const dismissedButton = panel.getByRole('button', { name: `Dismissed (${before + 1})` })
  await expect(dismissedButton).toBeVisible()
  await dismissedButton.click()
  const dismissedDialog = page.getByRole('dialog', { name: /^Dismissed \(/ })
  await expect(dismissedDialog.getByRole('heading')).toHaveText(`Dismissed (${before + 1})`)
  const undoRow = dismissedDialog.getByRole('button', { name: /^Undo: "Mara walked" is not/ })
  await expect(undoRow).toBeVisible()
  // Undo brings it back: the chip returns once the scan reads the scene again.
  await undoRow.click()
  await expect(dismissedDialog.getByRole('heading')).toHaveText(`Dismissed (${before})`)
  await dismissedDialog.getByRole('button', { name: 'Close' }).click()
  await expect(dismissedDialog).toHaveCount(0)
  await expect(maraChip).toBeVisible({ timeout: 15_000 })

  // F-16.4: "Hesk" written in two scenes becomes a question in Needs a look.
  await caretToEnd(editor)
  await page.keyboard.type(' They waited for Hesk.')
  await page.getByRole('button', { name: 'New scene' }).click()
  const renameBox = page.getByRole('textbox', { name: 'Rename' })
  await expect(renameBox).toBeFocused()
  await renameBox.fill('Two')
  await renameBox.press('Enter')
  await expect(renameBox).toBeHidden()
  await bookTree.getByRole('treeitem', { name: 'Two', exact: true }).click()
  await caretToEnd(editor)
  await page.keyboard.type('The boat belonged to Hesk.')
  const second = (await invoke<TreeNode[]>('tree:list', undefined)).find((n) => n.title === 'Two')
  if (!second) throw new Error('the second scene was not made')
  const needs = panel.getByRole('region', { name: 'Needs a look' })
  const questions = needs.getByRole('group', { name: 'Questions' })
  await expect(questions).toContainText('Hesk: named in 2 scenes', { timeout: 15_000 })
  // Its badge counts conflicts only: questions never light it.
  await expect(panel.getByTestId('needs-a-look-badge')).toHaveCount(0)
  await questions
    .getByRole('combobox', { name: 'Add Hesk as' })
    .selectOption({ label: 'Character' })
  await expect.poll(async () => (await records()).map((r) => r.name)).toContain('Hesk')
  await expect(questions).toHaveCount(0)

  // F-16.10: a to-do for this scene, added and ticked.
  await needs.getByRole('button', { name: 'Add a to-do' }).click()
  await needs.getByRole('textbox', { name: 'New to-do' }).fill('Check the tide tables')
  await needs.getByRole('button', { name: 'Add', exact: true }).click()
  const tick = needs.getByRole('checkbox', { name: 'Done: Check the tide tables' })
  await expect(tick).toBeVisible()
  // Ticked, it moves behind the collapsed "1 done" line (it never crowds Needs a look).
  await tick.click()
  await expect(needs.getByText('1 done', { exact: true })).toBeVisible()
  await expect
    .poll(async () =>
      (
        await invoke<{ text: string; done: boolean; nodeId: string | null }[]>(
          'authorTodo:list',
          undefined
        )
      ).map((t) => [t.text, t.done, t.nodeId])
    )
    .toEqual([['Check the tide tables', true, second.id]])

  // F-16.13: Rename in book, from Hesk's chip in the open scene: the preview counts the 2 places
  // the name scan reads as Hesk in 2 scenes; Rename changes the open scene in its editor (at
  // main's places) and the other one in main.
  const heskChip = chips.getByRole('button', { name: /^Hesk/ })
  await expect(heskChip).toBeVisible({ timeout: 15_000 })
  await heskChip.click()
  const heskCard = panel.getByRole('group', { name: 'Why Hesk is here' })
  await heskCard.getByRole('button', { name: 'Rename in book…' }).click()
  await heskCard.getByRole('textbox', { name: 'New name' }).fill('Haskel')
  await expect(heskCard.getByTestId('rename-preview')).toContainText('2 matches in 2 scenes')
  await heskCard.getByRole('button', { name: 'Rename', exact: true }).click()
  await expect(editor).toContainText('The boat belonged to Haskel.')
  await expect.poll(() => storedText(first.id)).toBe('Mara walked in. They waited for Haskel.')
  await expect.poll(async () => (await records()).map((r) => r.name)).toContain('Haskel')
  const renamed = page
    .getByRole('status')
    .locator('div')
    .filter({ hasText: 'Renamed “Hesk” to “Haskel”: 2 matches in 2 scenes.' })
  await expect(renamed).toBeVisible()

  // One Undo restores both scenes and the name.
  await renamed.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(editor).toContainText('The boat belonged to Hesk.')
  await expect.poll(() => storedText(first.id)).toBe('Mara walked in. They waited for Hesk.')
  await expect.poll(() => storedText(second.id)).toBe('The boat belonged to Hesk.')
  await expect.poll(async () => (await records()).map((r) => r.name)).toContain('Hesk')
})

test('story memory v2: the Story notes block and filing into Pinned (P1 slice 5)', async () => {
  // Slices 2 to 4 ran with Use AI off: nothing reached the provider.
  expect(providerBodies).toEqual([])
  const records = (): Promise<StoredRecord[]> => invoke<StoredRecord[]>('record:list', undefined)
  const maraId = (await records()).find((r) => r.name === 'Mara Vell')?.id ?? ''
  expect(maraId).not.toBe('')

  // Use AI on, with an own OpenAI key at the fake provider.
  const settingsDialog = page.getByRole('dialog', { name: 'Settings' })
  await page.keyboard.press('Control+,')
  await expect(settingsDialog).toBeVisible()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await settingsDialog.getByRole('switch', { name: 'Use AI' }).check()
  await settingsDialog
    .getByRole('radiogroup', { name: 'Key provider' })
    .getByTestId('own-key-provider-openai')
    .click()
  await expect(settingsDialog.getByRole('form', { name: 'OpenAI API key' })).toBeVisible()
  await settingsDialog.getByLabel('API key', { exact: true }).fill(OWN_KEY)
  await settingsDialog.getByRole('button', { name: 'Save' }).click()
  await expect(settingsDialog.getByTestId('ai-key-hint')).toHaveText('Key saved: sk-…5678')
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)

  // F-16.14: ghost text in the first scene (Mara's POV, her Pinned "Eyes: grey as the harbour.")
  // sends the Story notes block in its system turn; her Ideas line is never in it.
  const first = (await invoke<TreeNode[]>('tree:list', undefined)).find(
    (n) => n.kind === 'document' && n.hierarchyLevel === 'scene'
  )
  if (!first) throw new Error('no scene in the seed')
  await showSection('Manuscript')
  const bookTree = page.getByRole('tree', { name: 'Document tree' })
  await bookTree.getByRole('treeitem', { name: first.title }).first().click()
  const editor = page.getByRole('textbox', { name: 'Document' })
  const vibeWrite = page.getByRole('button', { name: 'VibeWrite' })
  await expect(vibeWrite).toBeEnabled()
  await vibeWrite.click()
  await expect(vibeWrite).toHaveAttribute('aria-pressed', 'true')
  await caretToEnd(editor)
  await page.keyboard.type(' Mara Vell looked back at the quay.')
  await expect(editor.locator('.ghost-text')).toHaveText(GHOST_ANSWER, { timeout: 15_000 })
  const ghost = providerBodies.filter((body) => !body.json).at(-1)
  const ghostSystem = ghost?.messages[0]
  expect(ghostSystem?.role).toBe('system')
  expect(ghostSystem?.content).toContain(STORY_NOTES_HEADING)
  expect(ghostSystem?.content).toContain('Here: Mara Vell (POV)')
  expect(ghostSystem?.content).toContain('Eyes: grey as the harbour.')
  expect(ghostSystem?.content).not.toContain('smuggler')
  await page.keyboard.press('Escape')
  await expect(editor.locator('.ghost-text')).toHaveCount(0)
  await vibeWrite.click()
  await expect(vibeWrite).toHaveAttribute('aria-pressed', 'false')

  // The panel's *What the AI is told* shows that block, read locally.
  const panel = page.getByTestId('this-scene-panel')
  if ((await panel.count()) === 0) {
    await page.getByRole('button', { name: 'This scene', exact: true }).click()
  }
  const told = panel.getByTestId('what-the-ai-is-told')
  await told.locator('summary').click()
  const block = told.getByTestId('story-notes-block')
  await expect(block).toContainText(STORY_NOTES_HEADING)
  expect(ghostSystem?.content).toContain((await block.textContent()) ?? '')

  // F-16.9: upload Bestiary.md into Research and file it into Pinned.
  const bestiary = path.join(tmp, 'Bestiary.md')
  fs.writeFileSync(bestiary, BESTIARY)
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] })
  }, bestiary)
  await showSection('Research')
  const researchTree = page.getByRole('tree', { name: 'Document tree' })
  await page
    .getByRole('toolbar', { name: 'Research' })
    .getByRole('button', { name: 'Add files…' })
    .click()
  await expect(researchTree.getByRole('treeitem', { name: 'Bestiary' })).toBeVisible()
  const researchPage = page.getByTestId('research-page')
  await expect(researchPage.getByRole('heading', { name: 'Bestiary', level: 2 })).toBeVisible()
  await researchPage.getByTestId('research-file').click()
  const filing = page.getByTestId('filing-dialog')
  await expect(filing.getByTestId('filing-estimate')).toContainText('1 request to gpt-5.4')
  await filing.getByTestId('filing-confirm').click()
  await expect(filing.getByTestId('filing-summary')).toHaveText(
    'From “Bestiary”: 1 new record · 1 record added to'
  )
  const filingBody = providerBodies.at(-1)
  expect(filingBody?.messages[0]?.content.startsWith(FILING_SENTINEL)).toBe(true)
  expect(filingBody?.messages.at(-1)?.content).toContain('Mara Vell keeps a fen-wight skull')
  // Everything starts accepted; Apply writes both cards.
  await filing.getByTestId('review-apply').click()
  await expect(filing).toHaveCount(0)
  await expect(researchPage.getByTestId('research-filed')).toContainText('Filed on ')
  await expect.poll(async () => (await records()).map((r) => r.name).sort()).toContain('Fen-wight')
  await expect
    .poll(async () => pageText((await invoke<StoredRecord>('record:get', { id: maraId })).pinned))
    .toBe(`Eyes: grey as the harbour.\n${FILED_LINE}`)

  // Mara's Pinned shows the filed line with its "Filed from" mark.
  await showSection('Characters')
  await page
    .getByRole('list', { name: 'Characters' })
    .getByRole('button', { name: /^Mara Vell/ })
    .click()
  const sheet = page.getByTestId('record-sheet')
  const pinned = sheet.getByRole('textbox', { name: 'Pinned' })
  await expect(pinned).toContainText(FILED_LINE)
  await expect(sheet.getByTestId('filed-from')).toHaveText(/^Filed from “Bestiary” ¶\d+$/)

  // Editing the quoted sentence in Research raises a Needs a look conflict.
  await showSection('Research')
  await researchTree.getByRole('treeitem', { name: 'Bestiary' }).click()
  const researchEditor = page.getByRole('textbox', { name: 'Research page' })
  await expect(researchEditor).toContainText('above her door.')
  await caretToEnd(researchEditor)
  for (const key of Array<string>('door.'.length).fill('Backspace')) await page.keyboard.press(key)
  await page.keyboard.type('gate.')
  await expect(researchEditor).toContainText('above her gate.')
  if ((await panel.count()) === 0) {
    await page.getByRole('button', { name: 'This scene', exact: true }).click()
  }
  const conflicts = panel
    .getByRole('region', { name: 'Needs a look' })
    .getByRole('group', { name: 'Conflicts' })
  const conflict = conflicts.getByTestId('filed-conflict')
  await expect(conflict).toContainText(`Mara Vell: “${FILED_LINE}”`, { timeout: 15_000 })
  await expect(conflict).toContainText('Mara Vell keeps a fen-wight skull above her gate.')
  await expect(panel.getByTestId('needs-a-look-badge')).toHaveText('1')
  // Keep line: the line stays as it is, and the conflict goes quiet.
  await conflict.getByRole('button', { name: 'Keep line' }).click()
  await expect(conflicts).toHaveCount(0)
  await expect
    .poll(async () => pageText((await invoke<StoredRecord>('record:get', { id: maraId })).pinned))
    .toBe(`Eyes: grey as the harbour.\n${FILED_LINE}`)
})

test('story memory: the switch-over on a copy of a v1 project (P1 slice 6)', async () => {
  // A second launch without the override, with its own app data: new projects run v1.
  if (!exited) await app.close()
  app = await electron.launch({
    args: ['.'],
    env: { ...baseEnv, MYTHSCRIBE_USER_DATA: path.join(tmp, 'userData-v1') }
  })
  exited = false
  app.on('close', () => {
    exited = true
  })
  page = await app.firstWindow()

  const projectPath = path.join(tmp, 'Switch Novel.mythscribe')
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath })
  }, projectPath)
  await page.getByRole('button', { name: 'New project' }).click()
  const wizard = page.getByRole('dialog')
  await wizard.getByRole('textbox', { name: 'Project name' }).fill('Switch Novel')
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByText('Off', { exact: true }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByTestId('project-name')).toHaveText('Switch Novel')
  expect((await invoke<ProjectInfo | null>('project:current', undefined))?.storyMemory).toBe('v1')

  // A character tag, made in the Index, typed inline through the `#` suggestion.
  await showSection('Index')
  const tagsPanel = page.getByRole('region', { name: 'Index section', exact: true })
  await tagsPanel
    .getByRole('tablist', { name: 'Tag categories' })
    .getByRole('tab', { name: 'Characters' })
    .click()
  const tagForm = tagsPanel.getByRole('form', { name: 'New tag' })
  await tagForm.getByRole('textbox', { name: 'Tag name' }).fill('mara')
  await tagForm.getByRole('button', { name: 'Create tag' }).click()
  await showSection('Manuscript')
  const scene = (await invoke<TreeNode[]>('tree:list', undefined)).find(
    (n) => n.hierarchyLevel === 'scene'
  )
  if (scene === undefined) throw new Error('the new project has no scene')
  await page
    .getByRole('tree', { name: 'Document tree' })
    .getByText(scene.title, { exact: true })
    .click()
  const editor = page.getByRole('textbox', { name: 'Document' })
  await clickIntoEditor(editor)
  await page.keyboard.type('Then #mar')
  const suggestions = page.getByRole('listbox', { name: 'Tag suggestions' })
  await expect(suggestions.getByRole('option').first()).toHaveText('mara')
  await page.keyboard.press('Tab')
  await page.keyboard.type('left.')
  await expect(editor.locator('[data-inline-tag]')).toHaveText(['#mara'])
  const storedText = async (): Promise<string> =>
    JSON.stringify(
      (await invoke<{ content: TiptapNodeT | null }>('document:get', { id: scene.id })).content
    )
  await expect.poll(storedText).toContain('left.')
  expect(await storedText()).toContain('inlineTag')

  // Help › Try the story-memory switch-over on a copy…: the dry run lists the tag as a record.
  await page
    .getByRole('menubar', { name: 'Application menu' })
    .getByRole('menuitem', { name: 'Help' })
    .click()
  await page
    .getByRole('menu', { name: 'Help' })
    .getByRole('menuitem', { name: 'Try the story-memory switch-over on a copy…' })
    .click()
  const dryRun = page.getByRole('dialog', { name: 'Switch-over dry run' })
  // (A character tag arrives with its sheet in v1, F-9.12, so the record comes from both.)
  await expect(dryRun.getByRole('list', { name: 'Converted' })).toContainText(
    'Mara: Record (character): from its sheet and tag.'
  )
  await dryRun.getByRole('button', { name: 'Next' }).click()

  // The consent screen: the replacement (the linked sheet's name), edited to "Mara".
  const replacement = page.getByRole('textbox', { name: 'Replacement for #mara' })
  await expect(replacement).toHaveValue('Mara')
  await replacement.fill('')
  await replacement.fill('Mara')
  await page.getByRole('button', { name: 'Convert' }).click()
  const done = page.getByRole('dialog', { name: 'Switched over' })
  await expect(done).toBeVisible({ timeout: 15_000 })

  // The copy opens on v2: plain "Mara" in the scene, and a Mara record.
  const copy = await invoke<ProjectInfo | null>('project:current', undefined)
  expect(copy?.storyMemory).toBe('v2')
  expect(path.basename(copy?.path ?? '')).toMatch(
    /^Switch Novel \(story memory test \d{4}-\d\d-\d\d \d{4}\)\.mythscribe$/
  )
  const converted = await storedText()
  expect(converted).not.toContain('inlineTag')
  expect(converted).toContain('Then Mara left.')
  expect((await invoke<{ name: string }[]>('record:list', undefined)).map((r) => r.name)).toEqual([
    'Mara'
  ])
  await done.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(done).toHaveCount(0)
  await page
    .getByRole('tree', { name: 'Document tree' })
    .getByText(scene.title, { exact: true })
    .click()
  await expect(editor).toContainText('Then Mara left.')
  await expect(editor.locator('[data-inline-tag]')).toHaveCount(0)

  // The original reopens (File › Open project…) as v1, its inline tag as it was.
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] })
  }, projectPath)
  await page
    .getByRole('menubar', { name: 'Application menu' })
    .getByRole('menuitem', { name: 'File' })
    .click()
  await page
    .getByRole('menu', { name: 'File' })
    .getByRole('menuitem', { name: 'Open project…' })
    .click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByTestId('project-name')).toHaveText('Switch Novel')
  const original = await invoke<ProjectInfo | null>('project:current', undefined)
  expect(original?.path).toBe(projectPath)
  expect(original?.storyMemory).toBe('v1')
  expect(await storedText()).toContain('inlineTag')
  await page
    .getByRole('tree', { name: 'Document tree' })
    .getByText(scene.title, { exact: true })
    .click()
  await expect(editor.locator('[data-inline-tag]')).toHaveText(['#mara'])
})
