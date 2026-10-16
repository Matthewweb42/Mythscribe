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
import type { NotebookPage } from '../src/shared/notebook'
import { clickIntoEditor } from './support'

/**
 * Notes redesign phase 2: the edit flow in a story memory v1 project, against a fake
 * OpenAI-compatible provider on loopback. A scene is typed and a note page made; the Edit button
 * in the right column opens the flow; a Quick copyedit of the scene is priced, then run; the
 * issue list shows two fixes and one issue without a fix; the issue opens its passage selected;
 * one fix is accepted and the other rejected inline in the text. Then an Update notes run edits
 * the page, shown with its Undo, which puts the page back.
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

/** The fake editor: issues for the copyedit, one appended line for Update notes. */
function flowAnswer(messages: { role: string; content: string }[]): string {
  const user = messages[1]?.content ?? ''
  const ref = /### (n\d+) /.exec(user)?.[1] ?? 'n0'
  if (user.includes('Update her notes')) {
    return JSON.stringify({ notes: [{ page: 'p1', add: NOTE_LINE }] })
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
  expect(sent[0]?.content).toContain('# Notes\n## p1 Mara (note)\nEyes: grey.')
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
