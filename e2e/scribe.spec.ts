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
import type { IpcResult, ProjectInfo } from '../src/shared/ipc/contract'
import type { NotebookPage, NotebookVersion } from '../src/shared/notebook'

/**
 * Notes redesign phase 1, slice 2: Ms Scribe in a story memory v1 project (what the installed app
 * runs), against a fake OpenAI-compatible provider on loopback. A note page is made through
 * `notebook:create`; in Write, a message the router sends to chat reaches `scribe.v1` with the
 * page and the book in view; the fake answers with an `edit_note` call and then the answer; the
 * page is changed in the notebook, the chat logs the edit with its highlight, and its Undo puts
 * the page back (`notebook:restoreVersion`). In Brainstorm a question is answered with no write
 * tool offered and nothing edited.
 */

let app: ElectronApplication
let page: Page
let tmp: string

const OWN_KEY = 'sk-live-scribe-4321'
/** `route.v2`'s opening; the fake router sends every message to the chat. */
const ROUTE_SENTINEL = "You are the router inside a novel-writing app's assistant."
/** `scribe.v1`'s opening (`SCRIBE_SENTINEL`). */
const SCRIBE_SENTINEL = 'You are Ms Scribe, the writing partner inside the author’s novel app.'
const WRITE_MESSAGE = 'Put that Mara fears the sea in her page.'
const WRITE_ANSWER = 'I added it to her page (p1).'
const BRAINSTORM_MESSAGE = 'What could happen next at the quay?'
const BRAINSTORM_ANSWER = 'Two options: a storm closes the quay, or a stranger asks for Mara.'

/** Every chat request the fake provider saw. */
const bodies: { messages: { role: string; content: string }[] }[] = []
let provider: http.Server

/**
 * The fake Ms Scribe: the Write message is answered with one `edit_note` appending a line to the
 * first page, then the answer naming it; anything else with the Brainstorm answer at once.
 */
function scribeAnswer(messages: { role: string; content: string }[]): string {
  const looked = messages.some((m) => m.role === 'user' && m.content.startsWith('Result of '))
  const asked =
    [...messages].reverse().find((m) => m.role === 'user' && !m.content.startsWith('Result of '))
      ?.content ?? ''
  if (asked === WRITE_MESSAGE && !looked) {
    return JSON.stringify({
      tool: 'edit_note',
      args: { id: 'p1', text: 'Fears the sea.', append: true }
    })
  }
  if (asked === WRITE_MESSAGE) return JSON.stringify({ answer: WRITE_ANSWER, sources: ['p1'] })
  return JSON.stringify({ answer: BRAINSTORM_ANSWER, sources: [] })
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
      const content = system.startsWith(SCRIBE_SENTINEL)
        ? scribeAnswer(request.messages)
        : system.startsWith(ROUTE_SENTINEL)
          ? JSON.stringify({ action: 'chat', instruction: null })
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-e2e-scribe-'))
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

const paragraphs = (...lines: string[]): unknown => ({
  type: 'doc',
  content: lines.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

test('Ms Scribe edits a note in Write with Undo, and Brainstorm edits nothing (notes phase 1)', async () => {
  // A new v1 project through the wizard, Use AI on (its default), the chat in Write.
  const projectPath = path.join(tmp, 'Scribe Novel.mythscribe')
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath })
  }, projectPath)
  await page.getByRole('button', { name: 'New project' }).click()
  const wizard = page.getByRole('dialog')
  await wizard.getByRole('textbox', { name: 'Project name' }).fill('Scribe Novel')
  for (let step = 0; step < 4; step += 1) {
    await wizard.getByRole('button', { name: 'Next' }).click()
  }
  await wizard.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByTestId('project-name')).toHaveText('Scribe Novel')
  expect((await invoke<ProjectInfo | null>('project:current', undefined))?.storyMemory).toBe('v1')
  await invoke('ai:setOwnKeyProvider', { provider: 'openai' })
  await invoke('ai:setKey', { key: OWN_KEY })

  // A note page, made through the notebook's channel.
  const mara = await invoke<NotebookPage>('notebook:create', {
    parentId: null,
    kind: 'page',
    title: 'Mara',
    content: paragraphs('Eyes: grey.')
  })
  expect(mara.plain).toBe('Eyes: grey.')

  const scribeButton = page.getByRole('button', { name: 'Ms Scribe', exact: true })
  if ((await scribeButton.getAttribute('aria-pressed')) !== 'true') await scribeButton.click()
  const assistant = page.getByTestId('assistant-panel')
  await expect(assistant).toBeVisible()
  const modes = assistant.getByRole('radiogroup', { name: 'Mode' }).getByRole('radio')
  await expect(modes).toHaveText(['Brainstorm', 'Write', 'Vibe'])
  await expect(assistant.getByRole('radio', { name: 'Write', exact: true })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  const messageBox = assistant.getByRole('textbox', { name: 'Message' })
  const turns = assistant.locator('[data-testid="chat-turn"]')
  const scribeBodies = (): typeof bodies =>
    bodies.filter((body) => body.messages[0]?.content.startsWith(SCRIBE_SENTINEL) === true)

  // Write: the router, then Ms Scribe's edit_note and her answer.
  await messageBox.fill(WRITE_MESSAGE)
  await messageBox.press('Enter')
  await expect(turns).toHaveCount(2)
  // The ref reads as the page's title; the source chip holds the link.
  await expect(turns.nth(1)).toContainText('I added it to her page (Mara).', { timeout: 15_000 })
  expect(scribeBodies()).toHaveLength(2)
  const system = scribeBodies()[0]?.messages[0]?.content ?? ''
  expect(system).toContain('## p1 Mara (note)\nEyes: grey.')
  expect(system).toContain('edit_note {')
  expect(system).toContain('# Book map')
  expect(scribeBodies()[1]?.messages.at(-1)?.content).toBe('Result of edit_note:\nEdited p1 Mara.')

  const change = turns.nth(1).getByTestId('agent-change')
  await expect(change).toHaveAttribute('data-status', 'applied')
  await expect(change).toContainText('Edited the note “Mara”')
  await expect(change.getByTestId('agent-change-diff')).toContainText('Fears the sea.')
  await expect(turns.nth(1).getByTestId('scribe-source-page')).toHaveText(['Mara'])
  await expect
    .poll(async () => (await invoke<NotebookPage>('notebook:get', { id: mara.id })).plain)
    .toBe('Eyes: grey.\nFears the sea.')
  const versions = await invoke<NotebookVersion[]>('notebook:versions', { id: mara.id })
  expect(versions.map((version) => version.author)).toEqual(['ai'])

  // Undo puts the page back as it was.
  await change.getByTestId('agent-change-undo').click()
  await expect(change).toHaveAttribute('data-status', 'undone')
  await expect
    .poll(async () => (await invoke<NotebookPage>('notebook:get', { id: mara.id })).plain)
    .toBe('Eyes: grey.')

  // Brainstorm: an answer with no write tool offered, and nothing edited.
  const versionsBefore = (await invoke<NotebookVersion[]>('notebook:versions', { id: mara.id }))
    .length
  await assistant.getByRole('radio', { name: 'Brainstorm', exact: true }).click()
  await messageBox.fill(BRAINSTORM_MESSAGE)
  await messageBox.press('Enter')
  await expect(turns).toHaveCount(4)
  await expect(turns.nth(3)).toContainText(BRAINSTORM_ANSWER, { timeout: 15_000 })
  const brainstorm = scribeBodies().at(-1)?.messages[0]?.content ?? ''
  expect(brainstorm).toContain('Mode Brainstorm')
  expect(brainstorm).not.toContain('edit_note {')
  expect(brainstorm).not.toContain('propose_prose_edit {')
  await expect(turns.nth(3).getByTestId('agent-change')).toHaveCount(0)
  expect((await invoke<NotebookPage>('notebook:get', { id: mara.id })).plain).toBe('Eyes: grey.')
  expect((await invoke<NotebookVersion[]>('notebook:versions', { id: mara.id })).length).toBe(
    versionsBefore
  )
})
