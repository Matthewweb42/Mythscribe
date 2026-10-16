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
import type { NotebookItem, NotebookPage, NotebookVersion } from '../src/shared/notebook'
import { clickIntoEditor } from './support'

/**
 * Notes redesign phase 1, slice 2: Ms Scribe in a story memory v1 project (what the installed app
 * runs), against a fake OpenAI-compatible provider on loopback. A note page is made through
 * `notebook:create`; in Write, a message the router sends to chat reaches `scribe.v2` with the
 * page and the book in view; the fake answers with an `edit_note` call and then the answer; the
 * page is changed in the notebook, the chat logs the edit with its highlight, and its Undo puts
 * the page back (`notebook:restoreVersion`). In Brainstorm a question is answered with nothing
 * edited, the moment saying the mode changes nothing (`scribe.v3`: every tool is in the cached
 * rules, the mode is said in the moment).
 *
 * Then (2026-10-15, `scribe.v2`) a source with a quote: the scene is renamed "Tash" inside a
 * chapter renamed "Blades of Alandor"; her answer names the scene by ref, which reads as the
 * chapter; the source carries one real and one made-up quote, main keeps the real one, and the
 * chip opens the scene with that passage selected and at the middle of the view.
 *
 * Then (2026-10-15, `scribe.v3`) Vibe: asked to make the scene better, she proposes a change to the
 * sea line unasked; it waits in the chat (the old words struck, the new marked) and, since the
 * notes fixes (2026-10-15), inline in the scene as a tracked change; Accept in the text puts it in
 * the scene and the card shows it accepted. Still in Vibe, Rewrite in my voice on a selection sends
 * `rewrite.v6`: the bolder line closes its user turn.
 *
 * Then (2026-10-16, `scribe.v5`, notes structure part C) in Write: "put Tash in a Characters
 * folder" makes the folder and moves the page at once (two lines, each with Undo, and Undo all,
 * which puts Tash back in Documents and removes the folder); a delete shows the card and removes
 * nothing until Delete, after which the page is gone.
 */

let app: ElectronApplication
let page: Page
let tmp: string

const OWN_KEY = 'sk-live-scribe-4321'
/** `route.v2`'s opening; the fake router sends every message to the chat. */
const ROUTE_SENTINEL = "You are the router inside a novel-writing app's assistant."
/** `scribe.v1`'s, `scribe.v2`'s and `scribe.v3`'s opening (`SCRIBE_SENTINEL`). */
const SCRIBE_SENTINEL = 'You are Ms Scribe, the writing partner inside the author’s novel app.'
const WRITE_MESSAGE = 'Put that Mara fears the sea in her page.'
const WRITE_ANSWER = 'I added it to her page (p1).'
const BRAINSTORM_MESSAGE = 'What could happen next at the quay?'
const BRAINSTORM_ANSWER = 'Two options: a storm closes the quay, or a stranger asks for Mara.'
const SEA_QUESTION = 'Where does Tash first see the sea?'
const VIBE_QUESTION = 'What can I do to make this scene better?'
const VIBE_REPLACEMENT = 'Below the ridge the sea lay still and grey as a blade'
const VIBE_ANSWER = 'One change: the sea line, sharper and colder.'
const MOVE_MESSAGE = 'Put Tash in a Characters folder.'
const MOVE_ANSWER = 'Tash is in Characters now.'
const DELETE_MESSAGE = 'Delete my Old ideas page.'
const DELETE_ANSWER = 'It waits for your Delete.'
/** `rewrite.v1`'s opening (every rewrite version's system turn starts with it). */
const REWRITE_SENTINEL = 'You are the rewrite feature inside a novel-writing app.'
/** The start of `rewrite.v6`'s Vibe line (notes fixes, 2026-10-15), last in the user turn. */
const REWRITE_VIBE_LINE = 'Mode Vibe: be bolder than a close rewrite'
/** The paragraph of Tash's scene her source quotes, far enough down to need a scroll. */
const SEA_AT = 14
const SEA_QUOTE = 'Below the ridge the sea lay flat as hammered tin'
const sceneParagraph = (i: number): string =>
  i === SEA_AT
    ? `${SEA_QUOTE}, and Tash stopped walking for the first time that day.`
    : `Paragraph ${i}. The wind came off the ridge in long cold pulls, and Tash kept her head ` +
      'down and counted the cairns as she passed them, one for every mile the road had taken.'

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
  if (asked === MOVE_MESSAGE) {
    return looked
      ? JSON.stringify({ answer: MOVE_ANSWER, sources: [] })
      : JSON.stringify({ tool: 'move_note', args: { ids: ['Tash'], to: 'Characters' } })
  }
  if (asked === DELETE_MESSAGE) {
    return looked
      ? JSON.stringify({ answer: DELETE_ANSWER, sources: [] })
      : JSON.stringify({ tool: 'delete_note', args: { id: 'Old ideas' } })
  }
  if (asked === VIBE_QUESTION) {
    const ref =
      /### (n\d+) Blades of Alandor › Tash\n/.exec(messages[0]?.content ?? '')?.[1] ?? 'n0'
    if (!looked) {
      return JSON.stringify({
        tool: 'propose_prose_edit',
        args: { id: ref, find: SEA_QUOTE, replace: VIBE_REPLACEMENT }
      })
    }
    return JSON.stringify({ answer: VIBE_ANSWER, sources: [ref] })
  }
  if (asked === SEA_QUESTION) {
    // Her ref for the scene, from the book she was sent.
    const ref =
      /### (n\d+) Blades of Alandor › Tash\n/.exec(messages[0]?.content ?? '')?.[1] ?? 'n0'
    return JSON.stringify({
      answer: `She first sees it in ${ref}.`,
      sources: [
        { ref, quote: SEA_QUOTE },
        { ref, quote: 'Tash swam out past the breakers at dawn' }
      ]
    })
  }
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
  // The notes binder: a page made at the top sits in Documents.
  expect(system).toContain('## p1 Mara (note, in Documents)\nEyes: grey.')
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
  expect(brainstorm.split('\n# Now\n')[1]).toContain(
    'Mode Brainstorm: think and plan with her; you change nothing'
  )
  await expect(turns.nth(3).getByTestId('agent-change')).toHaveCount(0)
  expect((await invoke<NotebookPage>('notebook:get', { id: mara.id })).plain).toBe('Eyes: grey.')
  expect((await invoke<NotebookVersion[]>('notebook:versions', { id: mara.id })).length).toBe(
    versionsBefore
  )
})

test('a source opens the scene at the passage she quotes, and her answer names the chapter', async () => {
  // Continues in the same project, Ms Scribe's panel open. Scene 1 becomes "Tash" in a chapter
  // called "Blades of Alandor" (renamed in main; the tree in the window keeps its old labels).
  const scene = (await invoke<TreeNode[]>('tree:list', undefined)).find(
    (n) => n.kind === 'document' && n.hierarchyLevel === 'scene'
  )
  if (!scene?.parentId) throw new Error('no scene in a chapter')
  const label = scene.title
  await invoke('tree:rename', { id: scene.parentId, title: 'Blades of Alandor' })
  await invoke('tree:rename', { id: scene.id, title: 'Tash' })

  // Thirty paragraphs typed into it, more than one screen.
  const bookTree = page.getByRole('tree', { name: 'Document tree' })
  await bookTree.getByRole('treeitem', { name: label, exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Document' })
  await clickIntoEditor(editor)
  for (let i = 1; i <= 30; i += 1) {
    await page.keyboard.insertText(sceneParagraph(i))
    if (i < 30) await page.keyboard.press('Enter')
  }
  await expect
    .poll(
      async () =>
        JSON.stringify(
          (await invoke<{ content: unknown }>('document:get', { id: scene.id })).content
        ),
      { timeout: 15_000 }
    )
    .toContain('Paragraph 30.')
  // The caret is at the end, the view scrolled to the bottom: the source must scroll back up.

  const assistant = page.getByTestId('assistant-panel')
  const messageBox = assistant.getByRole('textbox', { name: 'Message' })
  const turns = assistant.locator('[data-testid="chat-turn"]')
  const before = await turns.count()
  await messageBox.fill(SEA_QUESTION)
  await messageBox.press('Enter')
  await expect(turns).toHaveCount(before + 2)
  const answer = turns.nth(before + 1)
  // The ref reads as the scene's chapter, not its point-of-view title.
  await expect(answer).toContainText('She first sees it in the chapter Blades of Alandor.', {
    timeout: 15_000
  })
  const system =
    bodies.filter((b) => b.messages[0]?.content.startsWith(SCRIBE_SENTINEL) === true).at(-1)
      ?.messages[0]?.content ?? ''
  // The book map names the scene's chapter.
  const map = system.split('# Book map\n')[1]?.split('\n\n')[0] ?? ''
  expect(map).toMatch(/^n\d+ Blades of Alandor › Tash\b/m)
  expect(system).toContain('"quote":"<5 to 15 words copied exactly')

  // One source, kept with the quote the scene holds; the made-up one dropped.
  const source = answer.getByTestId('scribe-source-scene')
  await expect(source).toHaveText(['Blades of Alandor › Tash'])
  await expect(source).toHaveAttribute('title', `Open Blades of Alandor › Tash at “${SEA_QUOTE}”`)
  await expect(answer.getByTestId('scribe-source-passage')).toHaveCount(0)

  await source.click()
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
    .toBe(SEA_QUOTE)
  // The passage sits at the middle of the editor's scroller.
  await expect
    .poll(() =>
      editor.evaluate((root) => {
        let scroller: HTMLElement | null = root.parentElement
        while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
          scroller = scroller.parentElement
        }
        const range = window.getSelection()?.getRangeAt(0)
        if (!scroller || !range) return null
        const box = scroller.getBoundingClientRect()
        const middle = box.top + box.height / 2
        return Math.abs(range.getBoundingClientRect().top - middle) < box.height / 6
      })
    )
    .toBe(true)
})

test('Vibe proposes a bolder change unasked, which waits as a tracked change in the scene until Accept', async () => {
  // Continues in the same project, Tash's scene open in the editor.
  const assistant = page.getByTestId('assistant-panel')
  const messageBox = assistant.getByRole('textbox', { name: 'Message' })
  const turns = assistant.locator('[data-testid="chat-turn"]')
  const editor = page.getByRole('textbox', { name: 'Document' })
  await assistant.getByRole('radio', { name: 'Vibe', exact: true }).click()
  await expect(assistant.getByRole('radio', { name: 'Vibe', exact: true })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  const before = await turns.count()
  await messageBox.fill(VIBE_QUESTION)
  await messageBox.press('Enter')
  await expect(turns).toHaveCount(before + 2)
  const answer = turns.nth(before + 1)
  await expect(answer).toContainText(VIBE_ANSWER, { timeout: 15_000 })
  const scribeBodies = bodies.filter(
    (b) => b.messages[0]?.content.startsWith(SCRIBE_SENTINEL) === true
  )
  const system = scribeBodies.at(-1)?.messages[0]?.content ?? ''
  expect(system.split('\n# Now\n')[1]).toContain('Mode Vibe: be bold and do the work.')
  expect(scribeBodies.at(-1)?.messages.at(-1)?.content).toMatch(
    /^Result of propose_prose_edit:\nOffered/
  )

  // The change waits: the old words struck, the new ones marked, the scene's text as it was.
  const change = answer.getByTestId('agent-change')
  await expect(change).toHaveAttribute('data-status', 'pending')
  // A word diff: the replaced words struck ("flat"), the new ones marked ("still").
  await expect(change.locator('del').first()).toContainText('flat')
  await expect(change.locator('ins').first()).toContainText('still')
  await expect(change.getByTestId('agent-change-tracked')).toBeVisible()
  await expect(change.getByTestId('agent-change-apply')).toHaveText('Accept')

  // Notes fixes (2026-10-15): it shows inline in the scene as a tracked change, the old words
  // still in the text until it is accepted.
  const tracked = editor.locator('.tracked-change', { hasText: VIBE_REPLACEMENT })
  await expect(tracked).toHaveCount(1)
  await expect(editor.locator('.tracked-ins')).toHaveText([VIBE_REPLACEMENT])
  await expect(editor).toContainText(SEA_QUOTE)

  // Accept in the text applies it, and the card shows it accepted.
  await tracked.locator('.tracked-accept').click()
  await expect(editor.locator('.tracked-ins')).toHaveCount(0)
  await expect(editor).toContainText(VIBE_REPLACEMENT)
  await expect(editor).not.toContainText(SEA_QUOTE)
  await expect(change).toHaveAttribute('data-status', 'applied')
})

test('Rewrite in Vibe sends the bolder version, its line last in the user turn (notes fixes)', async () => {
  // Continues in Vibe, Tash's scene open in the editor.
  const editor = page.getByRole('textbox', { name: 'Document' })
  const rewriteButton = page.getByTestId('selection-rewrite')
  await clickIntoEditor(editor)
  const first = editor.locator('p').first()
  await first.scrollIntoViewIfNeeded()
  await first.evaluate((paragraph) => {
    const text = paragraph.firstChild
    if (!(text instanceof Text)) throw new Error('expected the paragraph to open with text')
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, Math.min(60, text.length))
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await expect
    .poll(() => page.evaluate(() => (window.getSelection()?.toString() ?? '').length))
    .toBeGreaterThan(20)
  await expect(rewriteButton).toBeEnabled()
  const before = bodies.length
  await rewriteButton.click()
  const panel = page.getByTestId('rewrite-panel')
  await expect(panel.getByTestId('rewrite-diff')).toBeVisible({ timeout: 15_000 })
  const rewrite = bodies
    .slice(before)
    .find((b) => b.messages[0]?.content.startsWith(REWRITE_SENTINEL) === true)
  expect(rewrite).toBeDefined()
  const user = rewrite?.messages.at(-1)?.content ?? ''
  expect(user).toContain('Rewrite the passage.')
  expect(user.slice(user.lastIndexOf('\n\n') + 2).startsWith(REWRITE_VIBE_LINE)).toBe(true)
  await panel.getByTestId('rewrite-reject').click()
  await expect(panel).toHaveCount(0)
})

test('in Write she makes a folder and moves a page at once with Undo, and a delete waits for Delete (scribe.v5)', async () => {
  // Continues in the same project, Ms Scribe's panel open. Two loose pages in Notes › Documents.
  const tash = await invoke<NotebookPage>('notebook:create', {
    parentId: null,
    kind: 'page',
    title: 'Tash',
    content: paragraphs('Climbs.')
  })
  const old = await invoke<NotebookPage>('notebook:create', {
    parentId: null,
    kind: 'page',
    title: 'Old ideas',
    content: paragraphs('A storm.')
  })
  const assistant = page.getByTestId('assistant-panel')
  const messageBox = assistant.getByRole('textbox', { name: 'Message' })
  const turns = assistant.locator('[data-testid="chat-turn"]')
  await assistant.getByRole('radio', { name: 'Write', exact: true }).click()
  await expect(assistant.getByRole('radio', { name: 'Write', exact: true })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  const notebook = async (): Promise<NotebookItem[]> =>
    invoke<NotebookItem[]>('notebook:list', undefined)

  // "Put Tash in a Characters folder": the folder is made and the page moved, at once.
  let before = await turns.count()
  await messageBox.fill(MOVE_MESSAGE)
  await messageBox.press('Enter')
  await expect(turns).toHaveCount(before + 2)
  const moved = turns.nth(before + 1)
  await expect(moved).toContainText(MOVE_ANSWER, { timeout: 15_000 })
  const system =
    bodies.filter((b) => b.messages[0]?.content.startsWith(SCRIBE_SENTINEL) === true).at(-1)
      ?.messages[0]?.content ?? ''
  expect(system).toContain('move_note {"ids"')
  const lines = moved.getByTestId('agent-change')
  await expect(lines).toHaveCount(2)
  await expect(lines.nth(0)).toContainText('New folder: Characters')
  await expect(lines.nth(1)).toContainText('Moved Tash into Characters')
  await expect(lines.nth(1)).toHaveAttribute('data-status', 'applied')
  const characters = (await notebook()).find((item) => item.title === 'Characters')
  expect(characters?.kind).toBe('folder')
  expect((await notebook()).find((item) => item.id === tash.id)?.parentId).toBe(characters?.id)
  // The notes binder: the folder was made in Documents, where Tash was.
  expect(characters?.parentId).toBe(tash.parentId)
  // Undo all: Tash goes back to where it was (Documents) and the folder goes.
  await moved.getByTestId('agent-undo-all').click()
  await expect(lines.nth(0)).toHaveAttribute('data-status', 'undone')
  await expect(lines.nth(1)).toHaveAttribute('data-status', 'undone')
  await expect
    .poll(async () => (await notebook()).find((item) => item.id === tash.id)?.parentId)
    .toBe(tash.parentId)
  await expect
    .poll(async () => (await notebook()).some((item) => item.title === 'Characters'))
    .toBe(false)

  // A delete asks: the card waits and nothing goes until Delete.
  before = await turns.count()
  await messageBox.fill(DELETE_MESSAGE)
  await messageBox.press('Enter')
  await expect(turns).toHaveCount(before + 2)
  const deleting = turns.nth(before + 1)
  await expect(deleting).toContainText(DELETE_ANSWER, { timeout: 15_000 })
  const card = deleting.getByTestId('agent-change')
  await expect(card).toHaveAttribute('data-status', 'pending')
  await expect(card).toContainText('Delete the note “Old ideas”')
  await expect(card.getByTestId('agent-change-skip')).toHaveText('Keep')
  expect((await notebook()).some((item) => item.id === old.id)).toBe(true)
  await card.getByTestId('agent-change-apply').click()
  await expect(card).toHaveAttribute('data-status', 'applied')
  await expect.poll(async () => (await notebook()).some((item) => item.id === old.id)).toBe(false)
})
