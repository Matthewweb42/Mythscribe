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
import type { IpcResult } from '../src/shared/ipc/contract'
import type { NotebookItem, NotebookPage } from '../src/shared/notebook'
import { caretToEnd } from './support'

/**
 * Notes redesign phase 1, slice 1: the Notes section. A project made through the wizard (Use AI
 * off, story memory v1 as installed builds run) gets a folder and a page in it, both named in the
 * tree; text typed on the page is saved and is still there after the project is closed and
 * opened again; the page is deleted from its menu and the toast's Undo brings it back. Nothing
 * here reaches a provider: the own-key URL and the Cloud URL are closed local ports.
 */

let app: ElectronApplication
let page: Page
let tmp: string
let exited = false

const NAME = 'Notebook Novel'
const TYPED = 'Mara keeps a fen-wight skull above her door.'

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-e2e-notebook-'))
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (e): e is [string, string] => e[1] !== undefined && e[0] !== 'MYTHSCRIBE_STORY_MEMORY'
      )
    ),
    NODE_ENV: 'test',
    MYTHSCRIBE_USER_DATA: path.join(tmp, 'userData'),
    MYTHSCRIBE_E2E_PLAINTEXT_KEYS: '1',
    OPENAI_BASE_URL: 'http://127.0.0.1:9',
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

async function showNotes(): Promise<void> {
  await page.getByRole('button', { name: /^Section: / }).click()
  const list = page.getByRole('listbox', { name: 'Sections' })
  await list.getByRole('option', { name: 'Notes', exact: true }).click()
  await expect(list).toHaveCount(0)
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
})
