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
import type { IpcResult } from '../src/shared/ipc/contract'
import type { NotebookItem, NotebookPage } from '../src/shared/notebook'
import { caretToEnd, showOldStoryBible } from './support'

/**
 * Notes redesign phase 1, slice 1: the Notes section. A project made through the wizard (Use AI
 * off, story memory v1 as installed builds run) gets a folder and a page in it, both named in the
 * tree; text typed on the page is saved and is still there after the project is closed and
 * opened again; the page is deleted from its menu and the toast's Undo brings it back. The first
 * two tests reach no provider (Use AI off; the Cloud URL is a closed local port).
 *
 * Notes structure B (2026-10-16): a Markdown file with headings dropped on Notes, Split at
 * headings picked, comes in as a folder of pages; another dropped with Sort with Ms Scribe picked
 * is priced, then sorted against the fake provider on loopback into two pages in two folders, and
 * the activity line's Undo removes them (the file stays as its own page).
 */

let app: ElectronApplication
let page: Page
let tmp: string
let exited = false

const NAME = 'Notebook Novel'
const TYPED = 'Mara keeps a fen-wight skull above her door.'
/** The fresh start's project (notes redesign, 2026-10-15). */
const DOCS_NAME = 'Docs Novel'
/** Structure B's project (Use AI on, against the fake provider). */
const SORT_NAME = 'Sort Novel'
/** `notesSort.v1`'s opening (`NOTES_SORT_SENTINEL`). */
const SORT_SENTINEL =
  'You are the notes sorter inside a novel-writing app, breaking a document the author put in her notes into smaller pages.'
const BESTIARY =
  '# Bestiary\n\nFen-wights wear the skulls of drowned dogs.\n\nSaltmarket bars its doors at the second bell.\n'

/** Every request the fake provider saw (its system turn). */
const systems: string[] = []
let provider: http.Server

/** The fake provider: a sort answers two pages in two folders, copied from the file. */
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
        messages: { role: string; content: string }[]
      }
      const system = request.messages[0]?.content ?? ''
      systems.push(system)
      const content = system.startsWith(SORT_SENTINEL)
        ? JSON.stringify({
            pages: [
              {
                folder: 'Creatures',
                title: 'Fen-wight',
                text: 'Fen-wights wear the skulls of drowned dogs.'
              },
              {
                folder: 'Places',
                title: 'Saltmarket',
                text: 'Saltmarket bars its doors at the second bell.'
              }
            ]
          })
        : '{}'
      res.end(
        JSON.stringify({
          id: 'chatcmpl-fake',
          created: 0,
          model: request.model,
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 400, completion_tokens: 60, total_tokens: 460 }
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

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-e2e-notebook-'))
  const providerUrl = await startFakeProvider()
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (e): e is [string, string] => e[1] !== undefined && e[0] !== 'MYTHSCRIBE_STORY_MEMORY'
      )
    ),
    NODE_ENV: 'test',
    MYTHSCRIBE_USER_DATA: path.join(tmp, 'userData'),
    MYTHSCRIBE_E2E_PLAINTEXT_KEYS: '1',
    // Nothing leaves the machine: the own-key provider is the fake, Cloud a closed port.
    OPENAI_BASE_URL: providerUrl,
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

/** Selects the Notes tab (the fresh start shows Manuscript and Notes as two tabs). */
async function showNotes(): Promise<void> {
  const notes = page
    .getByRole('tablist', { name: 'Sections' })
    .getByRole('tab', { name: 'Notes', exact: true })
  await notes.click()
  await expect(notes).toHaveAttribute('aria-selected', 'true')
}

/** Drops `name` with `text` on the Notes section, as a file from the desktop would land. */
async function dropFile(name: string, text: string): Promise<void> {
  const transfer = await page.evaluateHandle(
    ({ fileName, body }) => {
      const data = new DataTransfer()
      data.items.add(new File([body], fileName, { type: 'text/markdown' }))
      return data
    },
    { fileName: name, body: text }
  )
  await page.locator('[data-notebook-drop]').dispatchEvent('drop', { dataTransfer: transfer })
}

/** Types `name` into the tree's rename field and commits it. */
async function nameIt(name: string): Promise<void> {
  const field = page.getByRole('tree', { name: 'Notes' }).getByRole('textbox', { name: 'Rename' })
  await expect(field).toBeFocused()
  await field.fill(name)
  await field.press('Enter')
  await expect(field).toHaveCount(0)
}

async function storedText(title: string): Promise<string> {
  const items = await invoke<NotebookItem[]>('notebook:list', undefined)
  const found = items.find((item) => item.title === title)
  if (found === undefined) return ''
  return (await invoke<NotebookPage>('notebook:get', { id: found.id })).plain
}

test('notes: a folder and a page, typed text kept across a reopen, delete and Undo', async () => {
  // A new project through the wizard, Use AI off.
  const projectPath = path.join(tmp, `${NAME}.mythscribe`)
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath })
  }, projectPath)
  await page.getByRole('button', { name: 'New project' }).click()
  const wizard = page.getByRole('dialog')
  const nameField = wizard.getByRole('textbox', { name: 'Project name' })
  await nameField.fill('')
  await nameField.fill(NAME)
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await expect(wizard).toContainText('Step 4 of 5')
  await wizard.getByText('Off', { exact: true }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByTestId('project-name')).toHaveText(NAME)

  // The Notes section, empty.
  await showNotes()
  const toolbar = page.getByRole('toolbar', { name: 'Notes' })
  await expect(page.getByText('No notes yet.')).toBeVisible()

  // A folder, then a page inside it (the new folder is selected), each named in the tree.
  await toolbar.getByRole('button', { name: 'New folder' }).click()
  await nameIt('People')
  await toolbar.getByRole('button', { name: 'New page' }).click()
  await nameIt('Mara')
  const tree = page.getByRole('tree', { name: 'Notes' })
  const mara = tree.getByRole('treeitem', { name: 'Mara' })
  await expect(mara).toHaveAttribute('aria-level', '2')
  await expect(tree.getByRole('treeitem', { name: 'People' })).toHaveAttribute('aria-level', '1')

  // The page is open in the main pane, its title in the header; type on it.
  const notePage = page.getByTestId('notebook-page')
  await expect(notePage.getByRole('textbox', { name: 'Page title' })).toHaveValue('Mara')
  const editor = page.getByRole('textbox', { name: 'Note page' })
  await caretToEnd(editor)
  await page.keyboard.type(TYPED)
  await expect.poll(() => storedText('Mara')).toBe(TYPED)

  // Close and reopen the project: the folder, the page and its text are still there.
  await page.getByRole('button', { name: 'Close project' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  await page
    .getByRole('list', { name: 'Recent projects' })
    .getByRole('button', { name: NAME, exact: true })
    .click()
  await expect(page.getByTestId('project-name')).toHaveText(NAME)
  await showNotes()
  await tree.getByRole('treeitem', { name: 'Mara' }).getByText('Mara', { exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Note page' })).toContainText(TYPED)

  // Delete the page from its menu; the toast's Undo brings it back with its text.
  await tree.getByRole('treeitem', { name: 'Mara' }).getByText('Mara', { exact: true }).click({
    button: 'right'
  })
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(tree.getByRole('treeitem', { name: 'Mara' })).toHaveCount(0)
  await expect(page.getByTestId('notebook-page')).toHaveCount(0)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(tree.getByRole('treeitem', { name: 'Mara' })).toBeVisible()
  expect(await storedText('Mara')).toBe(TYPED)

  // Note templates (phase 6): a page from the Character template, typed in under Role, saved
  // as a template, then offered under My templates.
  await toolbar.getByRole('button', { name: 'New from template' }).click()
  await page.getByRole('menuitem', { name: 'Character', exact: true }).click()
  await nameIt('Rook')
  const rook = page.getByRole('textbox', { name: 'Note page' })
  await expect(rook.locator('h2').first()).toHaveText('Role')
  await rook.locator('h2:text-is("Role") + p').click()
  await page.keyboard.type('A smuggler')
  await expect.poll(() => storedText('Rook')).toMatch(/^Role\nA smuggler\nAppearance\n/)
  await tree.getByRole('treeitem', { name: 'Rook' }).getByText('Rook', { exact: true }).click({
    button: 'right'
  })
  await page.getByRole('menuitem', { name: 'Save as template' }).click()
  await expect(tree.getByRole('treeitem', { name: 'Templates' })).toBeVisible()
  await toolbar.getByRole('button', { name: 'New from template' }).click()
  const menu = page.getByRole('menu')
  await expect(menu.getByText('My templates')).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Rook', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
})

test('fresh start: a project’s Library file opens in Notes › Docs, with no Characters section', async () => {
  await page.getByRole('button', { name: 'Close project' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()

  // A project from before the fresh start: the story bible in use, an upload in its Library.
  const projectPath = path.join(tmp, `${DOCS_NAME}.mythscribe`)
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath })
  }, projectPath)
  await page.getByRole('button', { name: 'New project' }).click()
  const wizard = page.getByRole('dialog')
  const nameField = wizard.getByRole('textbox', { name: 'Project name' })
  await nameField.fill('')
  await nameField.fill(DOCS_NAME)
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByText('Off', { exact: true }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByTestId('project-name')).toHaveText(DOCS_NAME)
  await showOldStoryBible(page)
  const upload = path.join(tmp, 'Powers.md')
  fs.writeFileSync(upload, '# Powers\n\nShadow walking costs a memory.\n')
  await invoke('library:add', { paths: [upload] })

  // The old story bible put away again and the project reopened: its upload is a note page.
  await page.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('tab', { name: 'Archived features' }).click()
  await settings.getByRole('switch', { name: 'Archive Old story bible' }).check()
  await settings.getByRole('button', { name: 'Close settings' }).click()
  await expect
    .poll(
      async () =>
        (await invoke<{ unarchived?: string[] }>('editorSettings:get', undefined)).unarchived
    )
    .toEqual([])
  await page.getByRole('button', { name: 'Close project' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  await page
    .getByRole('list', { name: 'Recent projects' })
    .getByRole('button', { name: DOCS_NAME, exact: true })
    .click()
  await expect(page.getByTestId('project-name')).toHaveText(DOCS_NAME)

  await showNotes()
  const tree = page.getByRole('tree', { name: 'Notes' })
  await expect(tree.getByRole('treeitem', { name: 'Docs' })).toHaveAttribute('aria-level', '1')
  const powers = tree.getByRole('treeitem', { name: 'Powers' })
  await expect(powers).toHaveAttribute('aria-level', '2')
  await powers.getByText('Powers', { exact: true }).click()
  const notePage = page.getByRole('textbox', { name: 'Note page' })
  await expect(notePage.locator('h1')).toHaveText('Powers')
  await expect(notePage).toContainText('Shadow walking costs a memory.')

  // The sections: three tabs, Manuscript, Notes and Edits, with Outline and Timeline as large
  // folders at the top of Notes; no story-bible category or Library anywhere.
  await expect(page.getByRole('button', { name: /^Section: / })).toHaveCount(0)
  await expect(page.getByRole('tablist', { name: 'Sections' }).getByRole('tab')).toHaveText([
    'Manuscript',
    'Notes',
    'Edits'
  ])
  const views = page.getByRole('group', { name: 'Views' })
  await expect(views.getByRole('button')).toHaveText(['Outline', 'Timeline'])
  await expect(page.getByRole('tab', { name: 'Characters', exact: true })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Library', exact: true })).toHaveCount(0)

  // Timeline opens under Notes with a back row; the Notes tab stays selected.
  await views.getByRole('button', { name: 'Timeline', exact: true }).click()
  const notesTab = page.getByRole('tab', { name: 'Notes', exact: true })
  await expect(notesTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('region', { name: 'Timeline section', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Back to Notes' }).click()
  await expect(page.getByRole('tree', { name: 'Notes' })).toBeVisible()
  // Edits is a tab of its own.
  await page.getByRole('tab', { name: 'Edits', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Edits', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await page.getByRole('tab', { name: 'Notes', exact: true }).click()
})

test('structure B: a dropped file split at headings, another sorted with Ms Scribe and undone', async () => {
  await page.getByRole('button', { name: 'Close project' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()

  // A new project through the wizard, Use AI on (its default), a key for the fake provider.
  const projectPath = path.join(tmp, `${SORT_NAME}.mythscribe`)
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath })
  }, projectPath)
  await page.getByRole('button', { name: 'New project' }).click()
  const wizard = page.getByRole('dialog')
  const nameField = wizard.getByRole('textbox', { name: 'Project name' })
  await nameField.fill('')
  await nameField.fill(SORT_NAME)
  for (let step = 0; step < 4; step += 1) {
    await wizard.getByRole('button', { name: 'Next' }).click()
  }
  await wizard.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByTestId('project-name')).toHaveText(SORT_NAME)
  await invoke('ai:setOwnKeyProvider', { provider: 'openai' })
  await invoke('ai:setKey', { key: 'sk-live-notes-sort-1234' })
  await showNotes()
  const tree = page.getByRole('tree', { name: 'Notes' })

  // Split at headings: the file becomes a folder with a page per top heading.
  await dropFile(
    'Fenlands.md',
    'A drowned country.\n\n## Mara\n\nFerry keeper.\n\n### Voice\n\nClipped.\n\n## Rook\n\nA smuggler.\n'
  )
  const choice = page.getByTestId('notes-import-dialog')
  await expect(choice.getByRole('heading')).toHaveText('Add “Fenlands.md” to Notes')
  await expect(choice.getByRole('radio', { name: /One page each/ })).toBeChecked()
  await choice.getByRole('radio', { name: /Split at headings/ }).check()
  await choice.getByRole('button', { name: 'Add' }).click()
  await expect(choice).toHaveCount(0)
  const fenlands = tree.getByRole('treeitem', { name: 'Fenlands' })
  await expect(fenlands.first()).toHaveAttribute('aria-level', '1')
  for (const title of ['Mara', 'Rook']) {
    await expect(tree.getByRole('treeitem', { name: title, exact: true })).toHaveAttribute(
      'aria-level',
      '2'
    )
  }
  // The text before the first heading is a page named after the file, inside the folder.
  await expect(tree.locator('[aria-level="2"][aria-label="Fenlands"]')).toHaveCount(1)
  expect(await storedText('Mara')).toBe('Ferry keeper.\nVoice\nClipped.')

  // Sort with Ms Scribe: priced first, then two pages in two folders; the file stays a page.
  await dropFile('Bestiary.md', BESTIARY)
  await choice.getByRole('radio', { name: /Sort with Ms Scribe/ }).check()
  await expect(choice.getByTestId('notes-sort-price')).toContainText('1 request')
  await choice.getByRole('button', { name: 'Sort' }).click()
  const line = page.locator('[data-testid="activity-drop"][data-kind="notesSort"]')
  await expect(line).toContainText('Sorted Bestiary into 2 pages', { timeout: 15_000 })
  expect(systems.filter((system) => system.startsWith(SORT_SENTINEL))).toHaveLength(1)
  for (const [folder, title] of [
    ['Creatures', 'Fen-wight'],
    ['Places', 'Saltmarket']
  ] as const) {
    await expect(tree.getByRole('treeitem', { name: folder, exact: true })).toHaveAttribute(
      'aria-level',
      '1'
    )
    await expect(tree.getByRole('treeitem', { name: title, exact: true })).toHaveAttribute(
      'aria-level',
      '2'
    )
  }
  expect(await storedText('Saltmarket')).toBe('Saltmarket bars its doors at the second bell.')
  await expect(tree.getByRole('treeitem', { name: 'Bestiary', exact: true })).toBeVisible()

  // The line's Undo removes what the sort made; the file's own page stays.
  await line.getByRole('button', { name: 'Undo' }).click()
  await expect(tree.getByRole('treeitem', { name: 'Creatures', exact: true })).toHaveCount(0)
  await expect(tree.getByRole('treeitem', { name: 'Places', exact: true })).toHaveCount(0)
  await expect(tree.getByRole('treeitem', { name: 'Bestiary', exact: true })).toBeVisible()
  const items = await invoke<NotebookItem[]>('notebook:list', undefined)
  expect(items.some((item) => item.title === 'Saltmarket')).toBe(false)
})
