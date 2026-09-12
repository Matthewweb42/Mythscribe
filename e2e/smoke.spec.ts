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
import type { IpcResult, ProjectInfo, Tag, TreeNode } from '../src/shared/ipc/contract'
import type { Layout } from '../src/shared/layout'
import { matterTemplate } from '../src/shared/matterTemplates'
import type { TiptapNodeT } from '../src/shared/tiptap'
import { countWords } from '../src/shared/wordCount'

/**
 * Smoke test (CLAUDE.md quality gates): create a project → write text → close it → reopen it →
 * the structure and the text are still there.
 */

/** What Scene 1 reads after the F-3.1/F-3.2 steps; nine words, so the cached count is checked too. */
const SENTENCE = 'The storm broke at dusk. Rain followed. Then silence.'
const SENTENCE_WORDS = 9

/** The notes typed into the panel (F-3.7): one on Scene 1, one on Chapter 1 (a folder). */
const SCENE_NOTE = 'Ends on the cliff.'
const CHAPTER_NOTE = 'Get them to the coast.'

/** The Title Page template's word count (F-2.6), as the tree row and the persisted row must show it. */
const TITLE_PAGE_WORDS = countWords(matterTemplate('title-page').content)

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

  // F-4.1: the tag bank works through the bridge (the Tags tab arrives with F-4.2): a created
  // tag comes back kebab-cased with its category's default color and no usage yet.
  const tagCreated = await page.evaluate<IpcResult<Tag>>(
    () =>
      window.mythscribe.invoke('tag:create', {
        name: 'Dark Forest',
        category: 'setting'
      }) as Promise<IpcResult<Tag>>
  )
  expect(tagCreated.ok).toBe(true)
  if (!tagCreated.ok) throw new Error(`tag:create failed: ${tagCreated.error.message}`)
  expect(tagCreated.data).toMatchObject({
    name: 'dark-forest',
    category: 'setting',
    color: '#ea580c',
    parentId: null,
    usageCount: 0
  })
  const tagList = await page.evaluate<IpcResult<Tag[]>>(
    () => window.mythscribe.invoke('tag:list', undefined) as Promise<IpcResult<Tag[]>>
  )
  expect(tagList.ok).toBe(true)
  if (tagList.ok) expect(tagList.data).toEqual([tagCreated.data])

  // F-2.1: the document tree shows the sections by format, collapses and expands a folder, and
  // selecting a scene highlights it and shows it in the main pane.
  const tree = page.getByRole('tree', { name: 'Document tree' })
  // F-3.5: nothing is selected yet, so the main pane shows the empty state.
  await expect(page.getByTestId('empty-state')).toHaveText('Select a document to start writing.')
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

  // F-7.2: the arrow keys on the sidebar handle widen it; the new fraction is written to
  // app-state.json (so it survives a restart), and the header button hides and shows the tree.
  const sidebarHandle = page.getByRole('separator', { name: 'Resize sidebar' })
  const sidebarBefore = (await getLayout()).sidebar.size
  await sidebarHandle.focus()
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
  // The renderer resizes at once; main learns of it after the 150 ms debounce.
  await expect
    .poll(async () => (await getLayout()).sidebar.size, { timeout: 3000 })
    .toBeGreaterThan(sidebarBefore)
  const sidebarAfter = (await getLayout()).sidebar.size
  await expect(sidebarHandle).toHaveAttribute(
    'aria-valuenow',
    String(Math.round(sidebarAfter * 100))
  )
  // Back the other way, so the later column-width checks (F-3.4/F-3.6) keep the room they assume.
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowLeft')
  await expect
    .poll(async () => (await getLayout()).sidebar.size, { timeout: 3000 })
    .toBeLessThan(sidebarAfter)
  const sidebarFinal = (await getLayout()).sidebar.size
  expect(sidebarFinal).toBeCloseTo(sidebarBefore)
  const appStateFile = path.join(tmp, 'userData', 'app-state.json')
  await expect
    .poll(() => (fs.existsSync(appStateFile) ? fs.readFileSync(appStateFile, 'utf8') : ''), {
      timeout: 3000
    })
    .toContain('"layout"')
  expect((JSON.parse(fs.readFileSync(appStateFile, 'utf8')) as { layout: Layout }).layout).toEqual(
    await getLayout()
  )
  const sidebarToggle = page.getByRole('button', { name: 'Sidebar', exact: true })
  await expect(sidebarToggle).toHaveAttribute('aria-pressed', 'true')
  await sidebarToggle.click()
  await expect(sidebarToggle).toHaveAttribute('aria-pressed', 'false')
  await expect(tree).toBeHidden()
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await sidebarToggle.click()
  await expect(sidebarToggle).toHaveAttribute('aria-pressed', 'true')
  await expect(tree).toBeVisible()
  await expect(scene1).toHaveAttribute('aria-selected', 'true')
  await expect
    .poll(async () => (await getLayout()).sidebar, { timeout: 3000 })
    .toEqual({ open: true, size: sidebarFinal, tab: 'manuscript' })

  // F-7.3: the sidebar is a tab bar; only the built Manuscript and Tags tabs are listed (no
  // placeholders), Manuscript is selected, and its panel holds the tree.
  const sidebarTabs = page.getByRole('tablist', { name: 'Sidebar' })
  await expect(sidebarTabs.getByRole('tab')).toHaveText(['Manuscript', 'Tags'])
  const manuscriptTab = sidebarTabs.getByRole('tab', { name: 'Manuscript' })
  await expect(manuscriptTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tabpanel', { name: 'Manuscript' }).getByRole('tree')).toBeVisible()

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

  // F-2.6: "New Title Page" from the Front Matter menu adds a gold, selected document filled from
  // the template (no rename box); the row shows the template's words and the editor opens on it.
  const frontMatter = tree.getByRole('treeitem', { name: 'Front Matter', exact: true })
  await frontMatter.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'New Title Page' }).click()
  await expect(menu).toBeHidden()
  const titlePage = frontMatter.getByRole('treeitem', { name: 'Title Page', exact: true })
  await expect(titlePage).toBeVisible()
  await expect(titlePage).toHaveAttribute('data-matter', 'true')
  await expect(titlePage).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('textbox', { name: 'Rename' })).toHaveCount(0)
  expect(TITLE_PAGE_WORDS).toBeGreaterThan(0)
  await expect(titlePage).toHaveText(`Title Page${TITLE_PAGE_WORDS}`)
  await expect(page.getByTestId('selected-title')).toHaveText('Title Page')
  const editor = page.getByRole('textbox', { name: 'Document' })
  await expect(editor.locator('h1')).toHaveText('[Book Title]')
  await expect(editor.locator('p', { hasText: '[Author Name]' })).toBeVisible()

  // F-3.1: selecting a scene shows the editor; typing, Bold from the toolbar and Ctrl+B, the
  // scene break in the web-novel style (F-3.6 default "~~~"), and undo.
  await scene1.click()
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await expect(editor).toHaveAttribute('contenteditable', 'true')
  await expect(page.getByTestId('empty-state')).toHaveCount(0)
  // F-3.4: the text sits in a centered column no wider than the 700 px default. Centering is
  // measured inside the scroll container's client box, so a vertical scrollbar (the editor's
  // 60 vh minimum height under the F-4.4 tag bar overflows a 900 px window) does not skew it.
  const column = await editor.locator('..').boundingBox()
  if (!column) throw new Error('editor column not laid out')
  expect(column.width).toBeLessThanOrEqual(700)
  const offCenter = await editor.locator('..').evaluate((el) => {
    const parent = el.parentElement
    if (!parent) throw new Error('editor column has no scroll container')
    const rect = el.getBoundingClientRect()
    const left = rect.left - parent.getBoundingClientRect().left - parent.clientLeft
    return Math.abs(left - (parent.clientWidth - left - rect.width))
  })
  expect(offCenter).toBeLessThan(2)
  // F-7.5: Ctrl+, opens the Settings dialog on its Editor tab; F-3.6: its controls apply a wider
  // column and a larger font live, and the preview follows; Escape closes the dialog.
  const settingsDialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(settingsDialog).toHaveCount(0)
  await page.keyboard.press('Control+,')
  await expect(settingsDialog).toBeVisible()
  await expect(settingsDialog.getByRole('tab', { name: 'Editor' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await settingsDialog.getByRole('spinbutton', { name: 'Max width' }).fill('900')
  await settingsDialog.getByRole('spinbutton', { name: 'Font size' }).fill('20')
  await expect(settingsDialog.getByTestId('editor-preview').locator('p').nth(1)).toHaveCSS(
    'font-size',
    '20px'
  )
  await page.keyboard.press('Escape')
  await expect(settingsDialog).toHaveCount(0)
  // The header button opens the same dialog; its close button dismisses it.
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(settingsDialog).toBeVisible()
  await expect(settingsDialog.getByRole('spinbutton', { name: 'Font size' })).toHaveValue('20')
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  await expect(editor).toHaveCSS('font-size', '20px')
  const widened = await editor.locator('..').boundingBox()
  if (!widened) throw new Error('editor column not laid out')
  expect(widened.width).toBeGreaterThan(700)
  expect(widened.width).toBeLessThanOrEqual(900)
  await editor.click()
  await page.keyboard.type('The storm broke at dusk.')
  await expect(editor.locator('p')).toHaveText('The storm broke at dusk.')
  const bold = page
    .getByRole('toolbar', { name: 'Formatting' })
    .getByRole('button', { name: 'Bold' })
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

  // F-3.2: the debounced autosave writes the text about a second after the last keystroke, and
  // Ctrl+S writes it at once. Both are read back through `document:get`.
  const rowsNow = await listTree()
  const openingParent = rowsNow.find((n) => n.title === 'Opening')?.parentId
  const scene1Row = rowsNow.find((n) => n.title === 'Scene 1' && n.parentId === openingParent)
  if (!scene1Row) throw new Error('Scene 1 row not found')
  await page.keyboard.press('End')
  await page.keyboard.type(' Rain followed.')
  await expect(editor.locator('p')).toHaveText('The storm broke at dusk. Rain followed.')
  await expect
    .poll(() => documentText(scene1Row.id), { timeout: 3000 })
    .toBe('The storm broke at dusk. Rain followed.')
  await page.keyboard.type(' Then silence.')
  // F-3.3: the status bar counts the editor live, before the save lands.
  await expect(page.getByTestId('status-words')).toHaveText(`${SENTENCE_WORDS} words`)
  await expect(page.getByTestId('status-delta')).toHaveText(`+${SENTENCE_WORDS} this session`)
  await page.keyboard.press('Control+s')
  await expect.poll(() => documentText(scene1Row.id), { timeout: 3000 }).toBe(SENTENCE)

  // F-3.7: Notes from the toolbar opens a side panel beside the editor with the scene's notes;
  // selecting Chapter 1 swaps in the chapter's own notes and saves the scene's at once. The
  // chapter note is still pending when the project closes, so the close flushes it.
  const chapter1Row = rowsNow.find((n) => n.id === openingParent)
  if (!chapter1Row) throw new Error('Chapter 1 row not found')
  const notesToggle = page.getByRole('button', { name: 'Notes', exact: true })
  await expect(page.getByTestId('notes-panel')).toHaveCount(0)
  await expect(notesToggle).toHaveAttribute('aria-pressed', 'false')
  await notesToggle.click()
  await expect(notesToggle).toHaveAttribute('aria-pressed', 'true')
  const notes = page.getByTestId('notes-panel').getByRole('textbox', { name: 'Notes' })
  await expect(notes).toHaveAttribute('contenteditable', 'true')
  await expect(notes.locator('p')).toHaveText('')
  await notes.click()
  await page.keyboard.type(SCENE_NOTE)
  await expect(notes.locator('p')).toHaveText(SCENE_NOTE)
  await expect(editor.locator('p')).toHaveText(SENTENCE)
  await chapter1.getByText('Chapter 1', { exact: true }).click()
  await expect(page.getByTestId('selected-title')).toHaveText('Chapter 1')
  await expect(notes.locator('p')).toHaveText('')
  await expect(notes).toHaveAttribute('contenteditable', 'true')
  await expect.poll(() => notesText(scene1Row.id), { timeout: 3000 }).toBe(SCENE_NOTE)
  await notes.click()
  await page.keyboard.type(CHAPTER_NOTE)
  await expect(notes.locator('p')).toHaveText(CHAPTER_NOTE)
  expect(await notesText(chapter1Row.id)).toBeNull()

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
  // F-2.2/F-2.3/F-2.6: the two created scenes, the rename, and the Title Page survived the
  // close; the duplicate was deleted again, so the count is 17 + 3.
  const persisted = await listTree()
  expect(persisted).toHaveLength(20)
  expect(persisted.map((n) => n.title)).toContain('Opening')
  expect(persisted.map((n) => n.title)).not.toContain('Opening (Copy)')
  expect(persisted.filter((n) => n.title === 'Untitled Scene')).toHaveLength(1)
  // F-2.6: the templated document keeps its matter type, title, and cached word count.
  const titlePageRow = persisted.find((n) => n.matterType === 'title-page')
  expect(titlePageRow).toMatchObject({
    title: 'Title Page',
    kind: 'document',
    wordCount: TITLE_PAGE_WORDS,
    parentId: persisted.find((n) => n.sectionType === 'front')?.id
  })
  // F-2.4: the drag survived the close: Opening sits before Scene 1 in Chapter 1.
  const openingRow = persisted.find((n) => n.title === 'Opening')
  if (!openingRow) throw new Error('Opening was not persisted')
  const chapter1Children = persisted
    .filter((n) => n.parentId === openingRow.parentId)
    .sort((a, b) => a.position - b.position)
  expect(chapter1Children.map((n) => n.title)).toEqual(['Opening', 'Scene 1'])
  expect(chapter1Children.map((n) => n.position)).toEqual([0, 1])
  // F-3.2: the text survived the close and the cached word count matches it.
  expect(chapter1Children.map((n) => n.wordCount)).toEqual([0, SENTENCE_WORDS])
  // F-3.7: both notes survived the close: the scene's through the switch away from it, the
  // chapter's through the flush on closing the project.
  expect(await notesText(scene1Row.id)).toBe(SCENE_NOTE)
  expect(await notesText(chapter1Row.id)).toBe(CHAPTER_NOTE)
  await scene1.click()
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await expect(editor).toHaveAttribute('contenteditable', 'true')
  await expect(editor.locator('p')).toHaveText(SENTENCE)
  // F-3.7: the panel stayed open across the reopen and shows the scene's note again.
  await expect(notesToggle).toHaveAttribute('aria-pressed', 'true')
  await expect(notes.locator('p')).toHaveText(SCENE_NOTE)
  // F-3.6: the formatting settings survived the close too.
  await expect(editor).toHaveCSS('font-size', '20px')
  const persistedColumn = await editor.locator('..').boundingBox()
  if (!persistedColumn) throw new Error('editor column not laid out')
  expect(persistedColumn.width).toBeGreaterThan(700)
  expect(persistedColumn.width).toBeLessThanOrEqual(900)

  // F-4.2: the Tags tab lists the tag created through the bridge (it survived the close and the
  // store loaded it on reopen) under All and under its category, creates one through the form
  // (the color pre-fills from the chosen category), opens its detail view, renames it inline,
  // and deletes it after a confirmation.
  await sidebarTabs.getByRole('tab', { name: 'Tags' }).click()
  const tagsPanel = page.getByRole('tabpanel', { name: 'Tags' })
  const categories = tagsPanel.getByRole('tablist', { name: 'Tag categories' })
  await expect(categories.getByRole('tab')).toHaveText([
    'All',
    'Characters',
    'Settings',
    'World Building',
    'Tone',
    'Content',
    'Plot Threads',
    'Custom'
  ])
  const tagRows = tagsPanel.getByRole('list', { name: 'Tags' })
  await expect(tagRows.getByRole('button')).toHaveText(['dark-forest 0 uses'])
  await expect(
    tagRows.getByRole('button', { name: /^dark-forest/ }).locator('span[aria-hidden]')
  ).toHaveCSS('background-color', 'rgb(234, 88, 12)')
  await categories.getByRole('tab', { name: 'Settings' }).click()
  await expect(tagRows.getByRole('button')).toHaveText(['dark-forest 0 uses'])
  await categories.getByRole('tab', { name: 'Tone' }).click()
  await expect(tagsPanel.getByText('No tags match.')).toBeVisible()
  const tagForm = tagsPanel.getByRole('form', { name: 'New tag' })
  await expect(tagForm.getByRole('combobox', { name: 'Category' })).toHaveValue('tone')
  await expect(tagForm.getByLabel('Color')).toHaveValue('#2563eb')
  await tagForm.getByRole('textbox', { name: 'Tag name' }).fill('Moody')
  await tagForm.getByRole('button', { name: 'Create tag' }).click()
  await expect(tagRows.getByRole('button')).toHaveText(['moody 0 uses'])
  await expect(tagForm.getByRole('textbox', { name: 'Tag name' })).toHaveValue('')
  await tagRows.getByRole('button', { name: /^moody/ }).click()
  const tagName = tagsPanel.getByRole('textbox', { name: 'Tag name' })
  await expect(tagName).toHaveValue('moody')
  await expect(tagsPanel.getByLabel('Color')).toHaveValue('#2563eb')
  await expect(tagsPanel.getByText('Used in 0 documents')).toBeVisible()
  await tagName.fill('Melancholy')
  await tagName.press('Enter')
  await expect(tagName).toHaveValue('melancholy')
  await tagsPanel.getByRole('button', { name: 'Delete tag' }).click()
  const deleteTagDialog = page.getByRole('dialog', { name: 'Delete "melancholy"?' })
  await expect(deleteTagDialog).toBeVisible()
  await deleteTagDialog.getByRole('button', { name: 'Delete' }).click()
  await expect(deleteTagDialog).toBeHidden()
  await expect(tagsPanel.getByText('No tags match.')).toBeVisible()
  await categories.getByRole('tab', { name: 'All' }).click()
  await expect(tagRows.getByRole('button')).toHaveText(['dark-forest 0 uses'])
  // F-4.3: loading a template after the confirm adds its tags (28 for Standard Fiction) and toasts.
  const templates = tagsPanel.getByRole('form', { name: 'Tag templates' })
  await templates.getByRole('combobox', { name: 'Template' }).selectOption('standard-fiction')
  await templates.getByRole('button', { name: 'Load' }).click()
  const loadDialog = page.getByRole('dialog', { name: 'Load the Standard Fiction template?' })
  await expect(loadDialog).toBeVisible()
  await loadDialog.getByRole('button', { name: 'Load' }).click()
  await expect(loadDialog).toBeHidden()
  await expect(page.getByRole('status')).toContainText('Added 28 tags')
  await expect(tagRows.getByRole('button')).toHaveCount(29)
  await expect(tagRows.getByRole('button', { name: /^protagonist/ })).toBeVisible()
  await sidebarTabs.getByRole('tab', { name: 'Manuscript' }).click()
  await expect(manuscriptTab).toHaveAttribute('aria-selected', 'true')
  await expect(tree).toBeVisible()

  // F-4.4: the tag bar above Scene 1's editor starts without chips; "Add tag" opens a picker of
  // the unassigned tags, searching "forest" narrows it to dark-forest (the template's plain
  // "dark" tone tag would also match "dark"), Enter links it as a chip, and the Tags tab shows
  // the usage at once; removing the chip returns it to 0. Collapsing hides the chips, the
  // picker, and the handle, and the state persists in the layout.
  await expect(scene1).toHaveAttribute('aria-selected', 'true')
  const tagBar = page.getByRole('region', { name: 'Tags', exact: true })
  await expect(tagBar).toBeVisible()
  await expect(tagBar.getByRole('listitem')).toHaveCount(0)
  await tagBar.getByRole('button', { name: 'Add tag' }).click()
  const tagSearch = page.getByRole('searchbox', { name: 'Search tags' })
  await expect(tagSearch).toBeFocused()
  await tagSearch.fill('forest')
  await expect(
    page.getByRole('listbox', { name: 'Unassigned tags' }).getByRole('option')
  ).toHaveText(['dark-forest'])
  await tagSearch.press('Enter')
  await expect(tagBar.getByRole('listitem')).toHaveText(['dark-forest'])
  await expect(tagSearch).toHaveCount(0)
  await sidebarTabs.getByRole('tab', { name: 'Tags' }).click()
  await expect(tagRows.getByRole('button', { name: /^dark-forest/ })).toHaveText(
    'dark-forest 1 use'
  )
  await sidebarTabs.getByRole('tab', { name: 'Manuscript' }).click()
  await tagBar.getByRole('button', { name: 'Remove dark-forest' }).click()
  await expect(tagBar.getByRole('listitem')).toHaveCount(0)
  await sidebarTabs.getByRole('tab', { name: 'Tags' }).click()
  await expect(tagRows.getByRole('button', { name: /^dark-forest/ })).toHaveText(
    'dark-forest 0 uses'
  )
  await sidebarTabs.getByRole('tab', { name: 'Manuscript' }).click()
  const tagBarToggle = tagBar.getByRole('button', { name: /^Tags/ })
  await expect(tagBarToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(tagBar.getByRole('separator', { name: 'Resize tag bar' })).toHaveAttribute(
    'aria-valuenow',
    '120'
  )
  await tagBarToggle.click()
  await expect(tagBarToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(tagBar.getByRole('button', { name: 'Add tag' })).toHaveCount(0)
  await expect(tagBar.getByRole('separator')).toHaveCount(0)
  await expect
    .poll(async () => (await getLayout()).tagBar, { timeout: 3000 })
    .toEqual({ open: false, height: 120, split: 0.4 })
  await tagBarToggle.click()
  await expect(tagBarToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(tagBar.getByRole('button', { name: 'Add tag' })).toBeVisible()

  // F-4.5: the metadata pane sits beside the chips for a scene. Location autocompletes from the
  // setting tags (typing "dark" offers dark-forest, Enter fills it in), POV and the timeline
  // position are free text. Showing another scene flushes the edits and coming back reloads
  // them from disk. The split between the panes moves from its handle and persists.
  const metadata = tagBar.getByRole('group', { name: 'Scene metadata' })
  const location = metadata.getByRole('combobox', { name: 'Location' })
  await expect(location).toBeEnabled()
  await location.fill('dark')
  await expect(
    metadata.getByRole('listbox', { name: 'Location suggestions' }).getByRole('option')
  ).toHaveText(['dark-forest'])
  await location.press('Enter')
  await expect(location).toHaveValue('dark-forest')
  await metadata.getByRole('combobox', { name: 'POV' }).fill('Mara')
  await metadata.getByRole('textbox', { name: 'Timeline' }).fill('Day 3, after the storm')
  await opening.getByText('Opening', { exact: true }).click()
  await expect(page.getByTestId('selected-title')).toHaveText('Opening')
  await expect(metadata.getByRole('combobox', { name: 'Location' })).toHaveValue('')
  await scene1.getByText('Scene 1', { exact: true }).click()
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await expect(metadata.getByRole('combobox', { name: 'Location' })).toHaveValue('dark-forest')
  await expect(metadata.getByRole('combobox', { name: 'POV' })).toHaveValue('Mara')
  await expect(metadata.getByRole('textbox', { name: 'Timeline' })).toHaveValue(
    'Day 3, after the storm'
  )
  const splitHandle = tagBar.getByRole('separator', { name: 'Resize metadata pane' })
  await expect(splitHandle).toHaveAttribute('aria-valuenow', '40')
  await splitHandle.focus()
  await page.keyboard.press('ArrowRight')
  await expect
    .poll(async () => (await getLayout()).tagBar.split, { timeout: 3000 })
    .toBeGreaterThan(0.4)

  // F-2.5/F-3.8: selecting Chapter 1 stacks Opening and Scene 1 in tree order, each as its own
  // region with the web-novel scene break between them; typing into Opening leaves Scene 1
  // untouched and autosaves under Opening's own id.
  await chapter1.getByText('Chapter 1', { exact: true }).click()
  await expect(page.getByTestId('selected-title')).toHaveText('Chapter 1')
  // The folder's own tag bar (F-4.5) is a region too; the document regions are the sections.
  const regions = page.locator('section[aria-label]')
  await expect(regions).toHaveCount(2)
  await expect(regions.nth(0)).toHaveAttribute('aria-label', 'Opening')
  await expect(regions.nth(1)).toHaveAttribute('aria-label', 'Scene 1')
  await expect(page.getByRole('separator', { name: 'Scene break' })).toHaveText('~~~')
  const openingBox = regions.nth(0).getByRole('textbox', { name: 'Document' })
  const scene1Box = regions.nth(1).getByRole('textbox', { name: 'Document' })
  await expect(scene1Box.locator('p')).toHaveText(SENTENCE)
  await expect(openingBox).toHaveAttribute('contenteditable', 'true')
  await openingBox.click()
  await page.keyboard.type('Before the storm.')
  await expect(openingBox.locator('p')).toHaveText('Before the storm.')
  await expect(scene1Box.locator('p')).toHaveText(SENTENCE)
  await expect.poll(() => documentText(openingRow.id), { timeout: 3000 }).toBe('Before the storm.')
  expect(await documentText(scene1Row.id)).toBe(SENTENCE)
  // F-3.3: the folder's status bar shows the combined saved count and no session delta.
  await expect(page.getByTestId('status-words')).toHaveText(`${SENTENCE_WORDS + 3} words`)
  await expect(page.getByTestId('status-delta')).toHaveCount(0)

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

/** The plain text of a Tiptap document: paragraphs joined by newlines. */
function plainText(n: TiptapNodeT): string {
  return n.text ?? (n.content ?? []).map(plainText).join(n.type === 'doc' ? '\n' : '')
}

/** The plain text of a saved document, or null when never written. */
async function documentText(id: string): Promise<string | null> {
  const result = await page.evaluate<
    IpcResult<{ id: string; content: TiptapNodeT | null }>,
    string
  >(
    (nodeId) =>
      window.mythscribe.invoke('document:get', { id: nodeId }) as Promise<
        IpcResult<{ id: string; content: TiptapNodeT | null }>
      >,
    id
  )
  if (!result.ok) throw new Error(`document:get failed: ${result.error.message}`)
  return result.data.content ? plainText(result.data.content) : null
}

/** The plain text of a node's saved notes (F-3.7), or null when never written. */
async function notesText(id: string): Promise<string | null> {
  const result = await page.evaluate<IpcResult<{ id: string; notes: TiptapNodeT | null }>, string>(
    (nodeId) =>
      window.mythscribe.invoke('notes:get', { id: nodeId }) as Promise<
        IpcResult<{ id: string; notes: TiptapNodeT | null }>
      >,
    id
  )
  if (!result.ok) throw new Error(`notes:get failed: ${result.error.message}`)
  return result.data.notes ? plainText(result.data.notes) : null
}

/** The persisted panel layout (F-7.2) as main reports it. */
async function getLayout(): Promise<Layout> {
  const result = await page.evaluate<IpcResult<Layout>>(
    () => window.mythscribe.invoke('layout:get', undefined) as Promise<IpcResult<Layout>>
  )
  if (!result.ok) throw new Error(`layout:get failed: ${result.error.message}`)
  return result.data
}

async function listTree(): Promise<TreeNode[]> {
  const result = await page.evaluate<IpcResult<TreeNode[]>>(
    () => window.mythscribe.invoke('tree:list', undefined) as Promise<IpcResult<TreeNode[]>>
  )
  if (!result.ok) throw new Error(`tree:list failed: ${result.error.message}`)
  return result.data
}
