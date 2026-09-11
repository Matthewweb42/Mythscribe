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
import type { IpcResult, ProjectInfo } from '../src/shared/ipc/contract'

/**
 * Smoke test (CLAUDE.md quality gates): create a project → close it → reopen it → its data is
 * still there. M1 extends this with "write text → reopen → text is still there".
 */

let app: ElectronApplication
let page: Page
let tmp: string

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-e2e-'))
  // Point app-level state (recents) at the temp dir so the developer's real userData is untouched.
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, NODE_ENV: 'test', MYTHSCRIBE_USER_DATA: path.join(tmp, 'userData') }
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('create, close, reopen a project on disk', async () => {
  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible()

  // The native save dialog cannot be driven, so stub it in the main process. `createDialogs`
  // looks up `dialog.showSaveDialog` at call time, so the patch takes effect for the wizard.
  const projectPath = path.join(tmp, 'Smoke Novel.mythscribe')
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath })
  }, projectPath)

  // F-1.2: two-step wizard — name, then format cards. Back keeps the name.
  await page.getByRole('button', { name: 'New project' }).click()
  const wizard = page.getByRole('dialog')
  await wizard.getByRole('button', { name: 'Next' }).click()
  await expect(wizard.getByRole('alert')).toHaveText('A name is required')
  await wizard.getByRole('textbox', { name: 'Project name' }).fill('Smoke Novel')
  await wizard.getByRole('button', { name: 'Next' }).click()
  await expect(wizard.getByRole('radio', { name: /^novel/i })).toBeChecked()
  // The radio is visually hidden; the card label is what the author clicks.
  await wizard.getByText('Web novel', { exact: true }).click()
  await expect(wizard.getByRole('radio', { name: /^web novel/i })).toBeChecked()
  await wizard.getByRole('button', { name: 'Back' }).click()
  await expect(wizard.getByRole('textbox', { name: 'Project name' })).toHaveValue('Smoke Novel')
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Create' }).click()

  await expect(page.getByTestId('project-name')).toHaveText('Smoke Novel')
  expect(fs.existsSync(path.join(projectPath, 'project.db'))).toBe(true)
  expect(fs.existsSync(path.join(projectPath, 'assets'))).toBe(true)

  const created = await page.evaluate<IpcResult<ProjectInfo | null>>(
    () =>
      window.mythscribe.invoke('project:current', undefined) as Promise<
        IpcResult<ProjectInfo | null>
      >
  )
  expect(created.ok).toBe(true)
  if (!created.ok || !created.data) throw new Error('project was not created')
  expect(created.data.path).toBe(projectPath)

  await page.getByRole('button', { name: 'Close project' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible()

  // F-1.1: the welcome screen lists the project; clicking the row reopens it.
  const recents = page.getByRole('list', { name: 'Recent projects' })
  await recents.getByRole('button', { name: 'Smoke Novel', exact: true }).click()
  await expect(page.getByTestId('project-name')).toHaveText('Smoke Novel')
  const reopened = await page.evaluate<IpcResult<ProjectInfo | null>>(
    () =>
      window.mythscribe.invoke('project:current', undefined) as Promise<
        IpcResult<ProjectInfo | null>
      >
  )
  expect(reopened.ok).toBe(true)
  if (reopened.ok && reopened.data) expect(reopened.data.id).toBe(created.data.id)
  expect(fs.existsSync(path.join(tmp, 'userData', 'app-state.json'))).toBe(true)
})
