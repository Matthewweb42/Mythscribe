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

/**
 * Smoke test (CLAUDE.md quality gates): create a project → close it → reopen it → its data is
 * still there. M1 extends this with "write text → reopen → text is still there".
 */

let app: ElectronApplication
let page: Page
let tmp: string
let exited = false

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-e2e-'))
  // Point app-level state (recents) at the temp dir so the developer's real userData is untouched.
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, NODE_ENV: 'test', MYTHSCRIBE_USER_DATA: path.join(tmp, 'userData') }
  })
  app.on('close', () => {
    exited = true
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  // The last step closes the window, which quits the app on Linux; only close it if still up.
  if (!exited) await app?.close()
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
  // F-1.5: the shell header and window title carry the project name and format.
  await expect(page).toHaveTitle('Smoke Novel — MythScribe')
  await expect(page.locator('header')).toContainText('Web novel')
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

  // F-1.3: the new project is seeded with the three sections and the starter skeleton.
  const seeded = await listTree()
  expect(seeded).toHaveLength(17)
  expect(seeded.filter((n) => n.sectionType !== null)).toHaveLength(3)
  const titles = seeded.map((n) => n.title)
  expect(titles).toContain('Arc 1')
  expect(titles).toContain('Arc 2')
  expect(titles.filter((t) => t.startsWith('Chapter'))).toHaveLength(6)
  expect(titles.filter((t) => t === 'Scene 1')).toHaveLength(6)

  // F-2.1: the document tree shows the sections by format, collapses and expands a folder, and
  // selecting a scene highlights it and shows it in the main pane.
  const tree = page.getByRole('tree', { name: 'Document tree' })
  await expect(tree.getByRole('treeitem', { name: 'Volume 1', exact: true })).toBeVisible()
  const arc1 = tree.getByRole('treeitem', { name: 'Arc 1', exact: true })
  await expect(arc1).toBeVisible()
  await expect(tree.getByRole('treeitem', { name: 'Arc 2', exact: true })).toBeVisible()
  const chapter1 = arc1.getByRole('treeitem', { name: 'Chapter 1', exact: true })
  await expect(chapter1).toBeVisible()
  await tree.getByRole('button', { name: 'Collapse Arc 1' }).click()
  await expect(chapter1).toBeHidden()
  await expect(arc1).toHaveAttribute('aria-expanded', 'false')
  await tree.getByRole('button', { name: 'Expand Arc 1' }).click()
  await expect(chapter1).toBeVisible()
  const scene1 = chapter1.getByRole('treeitem', { name: 'Scene 1', exact: true })
  await scene1.click()
  await expect(scene1).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')

  // F-2.2: "New scene" from the bar inserts after the selected scene and opens inline rename;
  // Enter commits the title and the row keeps its place right after Scene 1.
  await page.getByRole('button', { name: 'New scene' }).click()
  const untitled = chapter1.getByRole('treeitem', { name: 'Untitled Scene', exact: true })
  await expect(untitled).toBeVisible()
  const renameBox = page.getByRole('textbox', { name: 'Rename' })
  await expect(renameBox).toBeFocused()
  await renameBox.fill('Opening')
  await renameBox.press('Enter')
  await expect(renameBox).toBeHidden()
  await expect(chapter1.getByRole('treeitem', { name: 'Opening', exact: true })).toBeVisible()
  await expect(chapter1.getByRole('treeitem')).toHaveText([/^Scene 1/, /^Opening/])

  // F-2.2: the right-click menu on a chapter offers a new scene under it; Escape cancels the
  // rename and keeps the default title.
  const chapter2 = arc1.getByRole('treeitem', { name: 'Chapter 2', exact: true })
  await chapter2.click({ button: 'right' })
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: 'New Scene' }).click()
  await expect(menu).toBeHidden()
  const untitled2 = chapter2.getByRole('treeitem', { name: 'Untitled Scene', exact: true })
  await expect(untitled2).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Rename' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('textbox', { name: 'Rename' })).toBeHidden()
  await expect(untitled2).toBeVisible()
  await expect(chapter2.getByRole('treeitem')).toHaveText([/^Scene 1/, /^Untitled Scene/])

  // F-2.3: Rename from the right-click menu opens the inline editor prefilled with the title;
  // Escape keeps it.
  const opening = chapter1.getByRole('treeitem', { name: 'Opening', exact: true })
  await opening.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Rename' }).click()
  await expect(menu).toBeHidden()
  const renameAgain = page.getByRole('textbox', { name: 'Rename' })
  await expect(renameAgain).toBeFocused()
  await expect(renameAgain).toHaveValue('Opening')
  await page.keyboard.press('Escape')
  await expect(renameAgain).toBeHidden()
  await expect(opening).toBeVisible()

  // F-2.3: Duplicate puts "<title> (Copy)" right after the original and selects it.
  await opening.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Duplicate' }).click()
  await expect(menu).toBeHidden()
  const openingCopy = chapter1.getByRole('treeitem', { name: 'Opening (Copy)', exact: true })
  await expect(openingCopy).toBeVisible()
  await expect(openingCopy).toHaveAttribute('aria-selected', 'true')
  await expect(chapter1.getByRole('treeitem')).toHaveText([
    /^Scene 1/,
    /^Opening/,
    /^Opening \(Copy\)/
  ])

  // F-2.3: Delete asks first; confirming removes the row and selects the previous sibling.
  await openingCopy.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(menu).toBeHidden()
  const deleteDialog = page.getByRole('dialog', { name: "Delete 'Opening (Copy)'?" })
  await expect(deleteDialog).toBeVisible()
  await deleteDialog.getByRole('button', { name: 'Delete' }).click()
  await expect(deleteDialog).toBeHidden()
  await expect(openingCopy).toBeHidden()
  await expect(chapter1.getByRole('treeitem')).toHaveText([/^Scene 1/, /^Opening/])
  await expect(opening).toHaveAttribute('aria-selected', 'true')

  // F-2.4: dragging Opening onto the top edge of Scene 1 (the "before" zone of a 28px row)
  // reorders it ahead of Scene 1; the selection stays on the moved row.
  await opening.dragTo(scene1, { targetPosition: { x: 60, y: 4 } })
  await expect(chapter1.getByRole('treeitem')).toHaveText([/^Opening/, /^Scene 1/])
  await expect(opening).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-drop]')).toHaveCount(0)

  // F-3.1: selecting a scene shows the editor; typing, Bold from the toolbar and Ctrl+B, the
  // scene break in the web-novel style (F-3.6 default "~~~"), and undo. Persistence is F-3.2.
  await scene1.click()
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  const editor = page.getByRole('textbox', { name: 'Document' })
  await expect(editor).toHaveAttribute('contenteditable', 'true')
  await editor.click()
  await page.keyboard.type('The storm broke at dusk.')
  await expect(editor.locator('p')).toHaveText('The storm broke at dusk.')
  const bold = page.getByRole('toolbar', { name: 'Formatting' }).getByRole('button', { name: 'Bold' })
  await expect(bold).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Control+a')
  await bold.click()
  await expect(bold).toHaveAttribute('aria-pressed', 'true')
  await expect(editor.locator('strong')).toHaveText('The storm broke at dusk.')
  await page.keyboard.press('Control+b')
  await expect(bold).toHaveAttribute('aria-pressed', 'false')
  await expect(editor.locator('strong')).toHaveCount(0)
  await page.keyboard.press('End')
  await page.getByRole('button', { name: 'Scene break' }).click()
  const sceneBreak = editor.locator('[data-scene-break]')
  await expect(sceneBreak).toHaveText('~~~')
  await expect(editor.locator('p')).toHaveCount(2)
  await page.keyboard.press('Control+z')
  await expect(sceneBreak).toHaveCount(0)
  await expect(editor.locator('p')).toHaveCount(1)

  await page.getByRole('button', { name: 'Close project' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible()
  await expect(page).toHaveTitle('MythScribe')

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
  // F-2.2/F-2.3: the two created scenes and the rename survived the close; the duplicate was
  // deleted again, so the count is back to 19.
  const persisted = await listTree()
  expect(persisted).toHaveLength(19)
  expect(persisted.map((n) => n.title)).toContain('Opening')
  expect(persisted.map((n) => n.title)).not.toContain('Opening (Copy)')
  expect(persisted.filter((n) => n.title === 'Untitled Scene')).toHaveLength(1)
  // F-2.4: the drag survived the close: Opening sits before Scene 1 in Chapter 1.
  const openingRow = persisted.find((n) => n.title === 'Opening')
  if (!openingRow) throw new Error('Opening was not persisted')
  const chapter1Children = persisted
    .filter((n) => n.parentId === openingRow.parentId)
    .sort((a, b) => a.position - b.position)
  expect(chapter1Children.map((n) => n.title)).toEqual(['Opening', 'Scene 1'])
  expect(chapter1Children.map((n) => n.position)).toEqual([0, 1])

  // F-1.4: the native open dialog (stubbed like the save dialog) opens project.db.
  await closeProject()
  await stubOpenDialog(path.join(projectPath, 'project.db'))
  await page.getByRole('button', { name: 'Open project' }).click()
  await expect(page.getByTestId('project-name')).toHaveText('Smoke Novel')

  // F-1.4: choosing something that is not a project explains what to pick instead.
  await closeProject()
  const stray = path.join(tmp, 'not-a-project.txt')
  fs.writeFileSync(stray, 'not a project')
  await stubOpenDialog(stray)
  await page.getByRole('button', { name: 'Open project' }).click()
  await expect(page.getByRole('status')).toContainText('Not a MythScribe project')
  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible()

  // F-1.4: closing the OS window with a project open lets the renderer flush first, then main
  // closes the project and the window; with no windows left the app quits.
  await recents.getByRole('button', { name: 'Smoke Novel', exact: true }).click()
  await expect(page.getByTestId('project-name')).toHaveText('Smoke Novel')
  const closed = app.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
  await closed
  expect(exited).toBe(true)
})

async function closeProject(): Promise<void> {
  await page.getByRole('button', { name: 'Close project' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible()
}

async function stubOpenDialog(filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] })
  }, filePath)
}

async function listTree(): Promise<TreeNode[]> {
  const result = await page.evaluate<IpcResult<TreeNode[]>>(
    () => window.mythscribe.invoke('tree:list', undefined) as Promise<IpcResult<TreeNode[]>>
  )
  if (!result.ok) throw new Error(`tree:list failed: ${result.error.message}`)
  return result.data
}
