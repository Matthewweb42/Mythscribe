import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test'
import type { IpcResult, ProjectInfo, TreeNode } from '../src/shared/ipc/contract'
import type { EditFlowChapterLeftResult } from '../src/shared/editFlow'
import type { NotebookPage } from '../src/shared/notebook'
import { caretToEnd, clickIntoEditor } from './support'

/**
 * Notes redesign phase 2: the edit flow in a story memory v1 project, against a fake
 * OpenAI-compatible provider on loopback. A scene is typed and a note page made; the Edit button
 * in the right column opens the flow; a Quick copyedit of the scene is priced, then run; the
 * issue list shows two fixes and one issue without a fix; the issue opens its passage selected;
 * one fix is accepted and the other rejected inline in the text. Then an Update notes run edits
 * the page, shown with its Undo, which puts the page back. Phase 3: the tree's Update notes from
 * this chapter pre-fills the flow; with Settings › AI's automatic update on, leaving Chapter 1
 * after writing in it updates Mara's page once, the activity line opens the run, Undo restores it,
 * and leaving again without writing sends nothing. The notes binder (2026-10-16): Update notes
 * (`editNotes.v2`) writes its events into the Story timeline page in the Timeline section, made
 * once, and Undo removes it.
 */

let app: ElectronApplication
let page: Page
let tmp: string

const OWN_KEY = 'sk-live-editflow-4321'
/** `editFlow.v1`'s and `editNotes.v1`'s opening (`EDIT_FLOW_SENTINEL`). */
const FLOW_SENTINEL =
  'You are the editor inside the author’s novel app, working through her book in the edit flow.'
const PARAGRAPHS = [
  'Mara climbed the ridge alone, her brown eyes on the road.',
  'She teh sea below and stopped walking.',
  'The tide turnd at dusk.'
]
const NOTE_LINE = 'Climbs the ridge alone (Chapter 1).'

/** Every chat request the fake provider saw. */
const bodies: { messages: { role: string; content: string }[] }[] = []
let provider: http.Server

/** The notes binder: the events the fake's Update notes answers for the Story timeline, if any. */
let timelineEvents: { line: string; after: string }[] | null = null
const TIMELINE_LINE = 'Ch 1 · Mara climbs the ridge alone.'

/** The fake editor: issues for the copyedit, one appended line for Update notes. */
function flowAnswer(messages: { role: string; content: string }[]): string {
  const user = messages[1]?.content ?? ''
  const ref = /### (n\d+) /.exec(user)?.[1] ?? 'n0'
  if (user.includes('Update her notes')) {
    return JSON.stringify({
      notes: [{ page: 'p1', add: NOTE_LINE }],
      ...(timelineEvents === null ? {} : { timeline: timelineEvents })
    })
  }
  return JSON.stringify({
    issues: [
      { scene: ref, quote: 'her brown eyes on the road', problem: 'Her page says grey.', fix: null },
      { scene: ref, quote: 'She teh sea below', problem: 'Typo.', fix: 'She saw the sea below' },
      {
        scene: ref,
        quote: 'The tide turnd at dusk.',
        problem: 'Spelling.',
        fix: 'The tide turned at dusk.'
      }
    ]
  })
}

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
      bodies.push({ messages: request.messages })
      const system = request.messages[0]?.content ?? ''
      const json = request.response_format?.type === 'json_object'
      const content = system.startsWith(FLOW_SENTINEL)
        ? flowAnswer(request.messages)
        : json
          ? '{}'
          : 'The quay was quiet.'
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

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-e2e-editflow-'))
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
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close()
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

const flowBodies = (): typeof bodies =>
  bodies.filter((body) => body.messages[0]?.content.startsWith(FLOW_SENTINEL) === true)

test('a Quick copyedit lists issues and fixes inline; Update notes edits a page with Undo', async () => {
  // A new v1 project through the wizard, Use AI on (its default).
  const projectPath = path.join(tmp, 'Flow Novel.mythscribe')
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath })
  }, projectPath)
  await page.getByRole('button', { name: 'New project' }).click()
  const wizard = page.getByRole('dialog')
  await wizard.getByRole('textbox', { name: 'Project name' }).fill('Flow Novel')
  for (let step = 0; step < 4; step += 1) {
    await wizard.getByRole('button', { name: 'Next' }).click()
  }
  await wizard.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByTestId('project-name')).toHaveText('Flow Novel')
  expect((await invoke<ProjectInfo | null>('project:current', undefined))?.storyMemory).toBe('v1')
  await invoke('ai:setOwnKeyProvider', { provider: 'openai' })
  await invoke('ai:setKey', { key: OWN_KEY })

  const mara = await invoke<NotebookPage>('notebook:create', {
    parentId: null,
    kind: 'page',
    title: 'Mara',
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Eyes: grey.' }] }]
    }
  })

  // The scene, typed.
  const scene = (await invoke<TreeNode[]>('tree:list', undefined)).find(
    (n) => n.kind === 'document' && n.hierarchyLevel === 'scene'
  )
  if (!scene) throw new Error('no scene')
  const bookTree = page.getByRole('tree', { name: 'Document tree' })
  await bookTree.getByRole('treeitem', { name: scene.title, exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Document' })
  await clickIntoEditor(editor)
  for (const [i, text] of PARAGRAPHS.entries()) {
    await page.keyboard.insertText(text)
    if (i < PARAGRAPHS.length - 1) await page.keyboard.press('Enter')
  }
  await expect
    .poll(
      async () =>
        JSON.stringify((await invoke<{ content: unknown }>('document:get', { id: scene.id })).content),
      { timeout: 15_000 }
    )
    .toContain('The tide turnd at dusk.')

  // The Edit button in the right column's header opens the flow: Copyediting on this scene,
  // Quick, priced before Run.
  const scribeButton = page.getByRole('button', { name: 'Ms Scribe', exact: true })
  if ((await scribeButton.getAttribute('aria-pressed')) !== 'true') await scribeButton.click()
  const assistant = page.getByTestId('assistant-panel')
  await assistant.getByTestId('edit-flow-open').click()
  const flow = assistant.getByTestId('edit-flow-panel')
  await expect(flow).toBeVisible()
  await expect(flow.getByLabel(/^Copyediting/)).toBeChecked()
  await expect(flow.getByRole('radio', { name: 'This scene' })).toBeChecked()
  await expect(flow.getByTestId('edit-flow-price-line')).toContainText('With MythScribe')
  await expect(flow.getByTestId('edit-flow-price')).toContainText('1 request')
  expect(flowBodies()).toHaveLength(0)

  await flow.getByTestId('edit-flow-run').click()
  await expect(flow.getByTestId('edit-flow-run-status')).toHaveAttribute('data-status', 'done', {
    timeout: 15_000
  })
  expect(flowBodies()).toHaveLength(1)
  const sent = flowBodies()[0]?.messages ?? []
  // The notes binder: a page made at the top sits in Documents.
  expect(sent[0]?.content).toContain('# Notes\n## p1 Mara (note, in Documents)\nEyes: grey.')
  expect(sent[0]?.content).toContain('# Book map\n')
  expect(sent[1]?.content).toContain('Copyediting:')
  expect(sent[1]?.content).toContain('She teh sea below and stopped walking.')

  // The issue list: one group, three issues in book order.
  const group = flow.getByTestId('edit-flow-group')
  await expect(group).toHaveAttribute('data-category', 'copy')
  const issues = group.getByTestId('edit-flow-issue')
  await expect(issues).toHaveCount(3)
  await expect(issues.nth(0)).toHaveAttribute('data-kind', 'note')
  await expect(issues.nth(1)).toHaveAttribute('data-kind', 'change')
  await expect(issues.nth(2)).toHaveAttribute('data-kind', 'change')

  // An issue opens its passage, selected.
  await issues.nth(0).getByTestId('edit-flow-issue-jump').click()
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
    .toBe('her brown eyes on the road')

  // The fixes are tracked changes in the text: accept one, reject the other, inline.
  await expect(editor.locator('.tracked-ins')).toHaveText([
    'She saw the sea below',
    'The tide turned at dusk.'
  ])
  await editor
    .locator('.tracked-change', { hasText: 'She saw the sea below' })
    .locator('.tracked-accept')
    .click()
  await expect(editor.locator('.tracked-ins')).toHaveText(['The tide turned at dusk.'])
  await editor.locator('.tracked-change').locator('.tracked-reject').click()
  await expect(editor.locator('.tracked-ins')).toHaveCount(0)
  await expect(editor).toContainText('She saw the sea below and stopped walking.')
  await expect(editor).toContainText('The tide turnd at dusk.')
  await expect(issues.nth(1)).toHaveAttribute('data-status', 'accepted')
  await expect(issues.nth(2)).toHaveAttribute('data-status', 'rejected')
  await expect(issues.nth(0)).toHaveAttribute('data-status', 'pending')

  // Update notes: the page is edited at once, shown with its Undo.
  await flow.getByTestId('edit-flow-back').click()
  await flow.getByLabel(/^Copyediting/).uncheck()
  await flow.getByLabel(/^Update notes/).check()
  await expect(flow.getByTestId('edit-flow-price-line')).toContainText('With MythScribe')
  await flow.getByTestId('edit-flow-run').click()
  await expect(flow.getByTestId('edit-flow-run-status')).toHaveAttribute('data-status', 'done', {
    timeout: 15_000
  })
  expect(flowBodies().at(-1)?.messages[1]?.content).toContain('Update her notes')
  const noteEdit = flow.getByTestId('edit-flow-note-edit')
  await expect(noteEdit).toHaveAttribute('data-status', 'applied')
  await expect(noteEdit).toContainText('Updated “Mara”')
  await expect(noteEdit.getByTestId('agent-change-diff')).toContainText(NOTE_LINE)
  await expect
    .poll(async () => (await invoke<NotebookPage>('notebook:get', { id: mara.id })).plain)
    .toBe(`Eyes: grey.\n${NOTE_LINE}`)

  await noteEdit.getByTestId('edit-flow-note-undo').click()
  await expect(noteEdit).toHaveAttribute('data-status', 'undone')
  await expect
    .poll(async () => (await invoke<NotebookPage>('notebook:get', { id: mara.id })).plain)
    .toBe('Eyes: grey.')

  // The latest run of the scene is kept; the copyedit before it on the same scene is replaced.
  await flow.getByTestId('edit-flow-back').click()
  await expect(flow.getByTestId('edit-flow-kept-run')).toHaveCount(1)
  await expect(flow.getByTestId('edit-flow-kept-run')).toContainText('Update notes')
})

test('notes phase 3: the step pre-fills the flow; leaving a chapter after writing updates the notes once', async () => {
  // The project of the test above: Chapter 1 with its scene written, Mara's page "Eyes: grey.".
  const nodes = await invoke<TreeNode[]>('tree:list', undefined)
  const scene = nodes.find((n) => n.kind === 'document' && n.hierarchyLevel === 'scene')
  const chapter = nodes.find((n) => n.id === scene?.parentId)
  const part = nodes.find((n) => n.hierarchyLevel === 'part')
  if (!scene || !chapter || !part) throw new Error('no starter scene')
  const mara = (await invoke<{ id: string; title: string }[]>('notebook:list', undefined)).find(
    (p) => p.title === 'Mara'
  )
  if (!mara) throw new Error('no Mara page')
  const bookTree = page.getByRole('tree', { name: 'Document tree' })
  const menu = page.getByRole('menu')
  const renameBox = page.getByRole('textbox', { name: 'Rename' })
  const assistant = page.getByTestId('assistant-panel')
  const flow = assistant.getByTestId('edit-flow-panel')

  // The step: the chapter's menu opens the flow pre-filled with Update notes on it, priced, not run.
  const before = flowBodies().length
  // The row itself, not the middle of its open subtree.
  const rowOf = (item: Locator): Locator => item.locator(':scope > div')
  await rowOf(bookTree.getByRole('treeitem', { name: chapter.title, exact: true })).click({
    button: 'right'
  })
  await menu.getByRole('menuitem', { name: 'Update notes from this chapter' }).click()
  await expect(flow).toBeVisible()
  await expect(flow.getByLabel(/^Update notes/)).toBeChecked()
  await expect(flow.getByLabel(/^Copyediting/)).not.toBeChecked()
  await expect(flow.getByRole('radio', { name: 'This chapter' })).toBeChecked()
  await expect(flow.getByRole('radio', { name: 'Quick' })).toBeChecked()
  await expect(flow.getByTestId('edit-flow-price')).toContainText(chapter.title)
  expect(flowBodies()).toHaveLength(before)

  // A second chapter with a scene, made through the tree's menu while the switch is still off.
  await rowOf(bookTree.getByRole('treeitem', { name: part.title, exact: true })).click({
    button: 'right'
  })
  await menu.getByRole('menuitem', { name: 'New Chapter' }).click()
  await renameBox.fill('Chapter 2')
  await renameBox.press('Enter')
  const chapter2 = bookTree.getByRole('treeitem', { name: 'Chapter 2', exact: true })
  await rowOf(chapter2).click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'New Scene' }).click()
  await renameBox.fill('Harbour')
  await renameBox.press('Enter')
  const harbour = chapter2.getByRole('treeitem', { name: 'Harbour', exact: true })
  await expect(harbour).toBeVisible()

  // Settings › AI: the automatic update, off by default, with its price per chapter.
  await page.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('tab', { name: 'AI' }).click()
  const autoSwitch = settings.getByRole('switch', {
    name: 'Update my notes after I finish a chapter'
  })
  await expect(autoSwitch).not.toBeChecked()
  await expect(settings.getByTestId('notes-auto-price')).toContainText('a chapter on')
  await autoSwitch.check()
  await expect(autoSwitch).toBeChecked()
  await settings.getByRole('button', { name: 'Close settings' }).click()
  await expect(settings).toHaveCount(0)

  // Write in Chapter 1's scene, then open the scene of Chapter 2: the notes are updated once.
  await bookTree.getByRole('treeitem', { name: scene.title, exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Document' })
  await caretToEnd(editor)
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('Rook followed her to the quay.')
  await expect
    .poll(
      async () =>
        JSON.stringify((await invoke<{ content: unknown }>('document:get', { id: scene.id })).content),
      { timeout: 15_000 }
    )
    .toContain('Rook followed her to the quay.')
  const beforeLeave = flowBodies().length
  await harbour.click()
  await expect.poll(() => flowBodies().length, { timeout: 15_000 }).toBe(beforeLeave + 1)
  const sent = flowBodies().at(-1)?.messages ?? []
  expect(sent[1]?.content).toContain('Update her notes')
  expect(sent[1]?.content).toContain('Rook followed her to the quay.')
  await expect
    .poll(async () => (await invoke<NotebookPage>('notebook:get', { id: mara.id })).plain)
    .toBe(`Eyes: grey.\n${NOTE_LINE}`)

  // The activity line says what changed and opens the run's results, each note edit with Undo.
  const drop = page.locator('[data-testid="activity-drop"][data-kind="notesUpdate"]')
  await expect(drop).toContainText(`Notes updated from ${chapter.title}: 1 page`, {
    timeout: 15_000
  })
  await drop.getByRole('button', { name: 'Open' }).click()
  await expect(flow.getByTestId('edit-flow-run-status')).toHaveAttribute('data-status', 'done')
  await expect(flow.getByTestId('edit-flow-run-status')).toContainText('automatic')
  const noteEdit = flow.getByTestId('edit-flow-note-edit')
  await expect(noteEdit).toHaveAttribute('data-status', 'applied')
  await noteEdit.getByTestId('edit-flow-note-undo').click()
  await expect(noteEdit).toHaveAttribute('data-status', 'undone')
  await expect
    .poll(async () => (await invoke<NotebookPage>('notebook:get', { id: mara.id })).plain)
    .toBe('Eyes: grey.')

  // Leaving again without writing sends nothing more; main would refuse the same text anyway.
  const afterRun = flowBodies().length
  await bookTree.getByRole('treeitem', { name: scene.title, exact: true }).click()
  await expect(editor).toContainText('Rook followed her to the quay.')
  await harbour.click()
  await page.waitForTimeout(1_500)
  expect(flowBodies()).toHaveLength(afterRun)
  expect(
    await invoke<EditFlowChapterLeftResult>('editFlow:chapterLeft', { chapterId: chapter.id })
  ).toEqual({ started: false, reason: 'unchanged' })
  expect(flowBodies()).toHaveLength(afterRun)
})

test('the notes binder: Update notes writes the Story timeline in the Timeline section, and Undo removes it', async () => {
  // The project of the tests above: Chapter 1 written, the automatic update on (nothing written since).
  // Chapter 1 (the tree's order is not the book's: Harbour, in Chapter 2, has no text).
  const nodes = await invoke<TreeNode[]>('tree:list', undefined)
  const chapter = nodes.find((n) => n.kind === 'folder' && n.title === 'Chapter 1')
  if (!chapter) throw new Error('no Chapter 1')
  timelineEvents = [{ line: TIMELINE_LINE, after: '' }]
  // A new page, so the request is not the automatic run's (an identical request is answered from
  // the local cache, not sent).
  await invoke<NotebookPage>('notebook:create', {
    parentId: null,
    kind: 'page',
    title: 'Rook',
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A smuggler.' }] }]
    }
  })
  const bookTree = page.getByRole('tree', { name: 'Document tree' })
  const flow = page.getByTestId('assistant-panel').getByTestId('edit-flow-panel')
  await bookTree
    .getByRole('treeitem', { name: chapter.title, exact: true })
    .locator(':scope > div')
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Update notes from this chapter' }).click()
  await expect(flow.getByLabel(/^Update notes/)).toBeChecked()
  const before = flowBodies().length
  await flow.getByTestId('edit-flow-run').click()
  await expect(flow.getByTestId('edit-flow-run-status')).toHaveAttribute('data-status', 'done', {
    timeout: 15_000
  })
  expect(flowBodies()).toHaveLength(before + 1)
  expect(flowBodies().at(-1)?.messages[1]?.content).toContain('Story timeline')

  // The page is made once, in the Timeline section, with the event on it.
  const items = await invoke<(NotebookPage & { role?: string | null })[]>('notebook:list', undefined)
  const made = items.filter((item) => item.title === 'Story timeline')
  expect(made).toHaveLength(1)
  expect(made[0]?.parentId).toBe(items.find((item) => item.role === 'timeline')?.id)
  expect((await invoke<NotebookPage>('notebook:get', { id: made[0]?.id ?? '' })).plain).toBe(
    TIMELINE_LINE
  )
  const edit = flow.getByTestId('edit-flow-note-edit').filter({ hasText: 'Story timeline' })
  await expect(edit).toContainText('Made the page “Story timeline”')

  // Undo removes the page it made, as for every note edit.
  await edit.getByTestId('edit-flow-note-undo').click()
  await expect(edit).toHaveAttribute('data-status', 'undone')
  await expect
    .poll(async () =>
      (await invoke<NotebookPage[]>('notebook:list', undefined)).some(
        (item) => item.title === 'Story timeline'
      )
    )
    .toBe(false)
  timelineEvents = null
})

