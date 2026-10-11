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
