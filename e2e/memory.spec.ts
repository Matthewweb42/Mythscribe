import fs from 'node:fs'
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
import { caretToEnd } from './support'

/**
 * Story memory v2 (FEATURES.md §2.16; plan P1), the AI-off path. The app is launched with
 * `MYTHSCRIBE_STORY_MEMORY=v2` (honoured only in unpackaged builds) and Use AI off, so nothing
 * here reaches a model: the provider and Cloud URLs point at a closed local port. The smoke test
 * (`smoke.spec.ts`) keeps covering v1 and is not edited for P1.
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
 */

let app: ElectronApplication
let page: Page
let tmp: string
let exited = false

/** A word nothing else in the project holds, so search and compile can be asked about it. */
const RESEARCH_WORD = 'Quillback'
const TYPED = ' The reef drops away past the second buoy.'
const SECOND_PARAGRAPH = 'Maybe the lighthouse keeper lied about the wreck.'

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-e2e-memory-'))
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)
    ),
    NODE_ENV: 'test',
    MYTHSCRIBE_USER_DATA: path.join(tmp, 'userData'),
    MYTHSCRIBE_STORY_MEMORY: 'v2',
    MYTHSCRIBE_E2E_PLAINTEXT_KEYS: '1',
    // Nothing leaves the machine: a closed port answers any request at once.
    OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
    MYTHSCRIBE_CLOUD_API_URL: 'http://127.0.0.1:9'
  }
  app = await electron.launch({ args: ['.'], env })
  app.on('close', () => {
    exited = true
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  if (!exited) await app?.close()
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
