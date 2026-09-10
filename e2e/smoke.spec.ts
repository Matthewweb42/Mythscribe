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
  app = await electron.launch({ args: ['.'], env: { ...process.env, NODE_ENV: 'test' } })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('create, close, reopen a project on disk', async () => {
  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible()

  // Native save dialogs cannot be driven, so create through the bridge with an explicit directory.
  const created = await page.evaluate<IpcResult<ProjectInfo | null>, string>(
    (dir) =>
      window.mythscribe.invoke('project:create', {
        name: 'Smoke Novel',
        format: 'novel',
        directory: dir
      }) as Promise<IpcResult<ProjectInfo | null>>,
    tmp
  )
  expect(created.ok).toBe(true)
  if (!created.ok || !created.data) throw new Error('project was not created')
  const projectPath = created.data.path
  expect(fs.existsSync(path.join(projectPath, 'project.db'))).toBe(true)
  expect(fs.existsSync(path.join(projectPath, 'assets'))).toBe(true)

  // The UI learns about it through the project:changed event.
  await expect(page.getByTestId('project-name')).toHaveText('Smoke Novel')

  await page.getByRole('button', { name: 'Close project' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible()

  const reopened = await page.evaluate<IpcResult<ProjectInfo | null>, string>(
    (p) =>
      window.mythscribe.invoke('project:open', { path: p }) as Promise<
        IpcResult<ProjectInfo | null>
      >,
    projectPath
  )
  expect(reopened.ok).toBe(true)
  if (reopened.ok && reopened.data) expect(reopened.data.id).toBe(created.data.id)
  await expect(page.getByTestId('project-name')).toHaveText('Smoke Novel')
})
