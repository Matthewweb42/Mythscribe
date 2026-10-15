import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import type { AgentStep } from '@shared/agent'
import { defaultAiSettings, type AssistantMode } from '@shared/aiSettings'
import { notebookDocFromText } from '@shared/notebook'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { createNotebookItem, getNotebookPage } from '../notebook/notebookStore'
import { projectFolderFor, type ProjectSession } from '../project/projectStore'
import { setAiSettings } from '../project/settingsStore'
import { createSeededProject } from '../project/testProject'
import type { TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { defaultAiUsageState, dayOf } from '../ai/dailyCap'
import { loadAgentProject } from '../ai/agentTools'
import { resetInflight } from '../ai/inflight'
import { SCRIBE_SENTINEL } from '../ai/prompts/scribe.v1'
import type { CompletionRequest, CompletionResult, Provider } from '../ai/providers/types'
import type { AiRequestDeps } from '../ai/request'
import type { UsageEntry } from '../ai/usageStore'
import { resetVoiceProfileCache } from '../voice/versionCache'
import { loadScribeSources } from './source'
import { answerSources, fitScribePrompt, readableAnswer, runScribe2 } from './run'

const NOW = new Date(2026, 9, 15, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>

let tmp: string
let session: ProjectSession
let db: TreeDb
let complete: ReturnType<typeof vi.fn<Complete>>
let deps: AiRequestDeps
let ledger: UsageEntry[]
let scenes: string[]
let steps: AgentStep[]
let changed: string[][]

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

function replies(...values: unknown[]): void {
  for (const value of values) {
    complete.mockResolvedValueOnce({
      text: JSON.stringify(value),
      model: 'deepseek-v4-pro',
      usage: { inputTokens: 1_000, outputTokens: 50 }
    })
  }
}

const request = (call: number): CompletionRequest => {
  const value = complete.mock.calls[call]?.[0]
  if (!value) throw new Error(`no request ${call}`)
  return value
}

const ask = (message: string, mode: AssistantMode = 'write', wholeBook = false) =>
  runScribe2(
    db,
    deps,
    session.folder,
    {
      nodeId: scenes[0] ?? null,
      message,
      history: [],
      mode,
      focus: { beforeCaret: '', selection: '' },
      wholeBook
    },
    (step) => steps.push(step),
    {},
    (ids) => changed.push(ids)
  )

beforeEach(() => {
  resetInflight()
  resetVoiceProfileCache()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-scribe2-run-'))
  session = createSeededProject(projectFolderFor(tmp, 'Scribe'), 'Scribe', 'novel')
  db = session.connection.orm
  scenes = manuscriptDocuments(db).map((row) => row.id)
  saveDocument(db, scenes[0]!, doc('Mara climbed the ridge alone.', 'The sea was grey.'))
  saveDocument(db, scenes[1]!, doc('Rook waited at the quay.'))
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  complete = vi.fn<Complete>()
  ledger = []
  steps = []
  changed = []
  const provider: Provider = {
    id: 'openai',
    resolveModel: (tier) => (tier === 'fast' ? 'deepseek-v4-flash' : 'deepseek-v4-pro'),
    complete,
    stream: async function* (req) {
      const reply = await complete(req)
      yield { delta: reply.text, usage: reply.usage }
    },
    testConnection: () => Promise.resolve({ model: 'deepseek-v4-flash' })
  }
  deps = {
    providers: { get: () => provider },
    ledger: { insert: (entry) => void ledger.push(entry) },
    cache: { get: () => undefined, put: () => {} },
    dailyCap: {
      get: () => ({ ...defaultAiUsageState(), spentDate: dayOf(NOW) }),
      spend: () => {}
    },
    session: { spend: () => {} },
    now: () => NOW,
    price: priceFor
  }
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('runScribe2 (notes redesign phase 1)', () => {
  it('answers in Write with the notes and the whole book in view, edits a note, and lists its sources', async () => {
    const mara = createNotebookItem(db, {
      parentId: null,
      kind: 'page',
      title: 'Mara',
      content: notebookDocFromText('Eyes: grey')
    })
    const ref0 = loadAgentProject(db, null, 'v1').refOf.get(scenes[0]!) ?? ''
    replies(
      { tool: 'edit_note', args: { id: 'p1', text: 'Fears the sea', append: true } },
      { answer: `Added to Mara (p1); she looks at the sea in ${ref0}.`, sources: [ref0, 'p1'] }
    )
    const result = await ask('Put that Mara fears the sea in her page.')
    expect(request(0).messages[0]?.content.startsWith(SCRIBE_SENTINEL)).toBe(true)
    // Every note page and the whole book go along (the book is far under the line).
    expect(request(0).messages[0]?.content).toContain('## p1 Mara (note)\nEyes: grey')
    expect(request(0).messages[0]?.content).toContain('# The book\n')
    expect(request(0).messages[0]?.content).toContain('Rook waited at the quay.')
    expect(request(0).maxTokens).toBe(3_000)
    expect(steps.map((s) => s.tool)).toEqual(['edit_note'])
    expect(getNotebookPage(db, mara.id).plain).toBe('Eyes: grey\nFears the sea')
    expect(changed).toEqual([[mara.id]])
    expect(result.changes).toMatchObject([
      { applied: true, violation: null, edit: { kind: 'notebook', pageId: mara.id } }
    ])
    expect(result.answer).not.toContain('(p1)')
    expect(result.answer).toContain('Mara')
    expect(result.sources.pages).toEqual([{ id: mara.id, title: 'Mara', kind: 'note' }])
    expect(result.sources.scenes.map((s) => s.nodeId)).toEqual([scenes[0]])
    expect(ledger.map((row) => row.feature)).toEqual(['scribe', 'scribe'])
    expect(ledger.every((row) => row.tier === 'strong')).toBe(true)
  })

  it('Brainstorm changes nothing: no write tools are offered, and a write the model tries is refused', async () => {
    createNotebookItem(db, { parentId: null, kind: 'page', title: 'Mara', content: null })
    replies(
      { tool: 'edit_note', args: { id: 'p1', text: 'x' } },
      { answer: 'Two options: a storm, or a stranger.', sources: [] }
    )
    const result = await ask('What could happen next?', 'brainstorm')
    expect(request(0).messages[0]?.content).not.toContain('edit_note {')
    expect(request(0).messages[0]?.content).toContain('Mode Brainstorm')
    expect(result.changes).toEqual([])
    expect(changed).toEqual([])
  })

  it('Brainstorm asked to save gets the note tools and writes the page', async () => {
    replies(
      { tool: 'create_note', args: { title: 'Ideas', text: 'A storm at the quay.' } },
      { answer: 'Saved it in Ideas.', sources: [] }
    )
    const result = await ask('Save that to my notes.', 'brainstorm')
    expect(request(0).messages[0]?.content).toContain('create_note {')
    expect(request(0).messages[0]?.content).not.toContain('propose_prose_edit {')
    expect(result.changes).toMatchObject([
      { applied: true, edit: { kind: 'notebook', created: true } }
    ])
  })

  it('refuses when the feature is off', async () => {
    setAiSettings(db, {
      ...defaultAiSettings(),
      dial: 1,
      features: { ...defaultAiSettings().features, scribe: false }
    })
    await expect(ask('Hello')).rejects.toMatchObject({ code: 'DISABLED' })
    expect(complete).not.toHaveBeenCalled()
  })
})

describe('Ms Scribe’s sources and refs', () => {
  it('lists the sources she named, the refs in the text, then what she opened, each once', async () => {
    const page = createNotebookItem(db, {
      parentId: null,
      kind: 'page',
      title: 'Rook',
      content: null
    })
    const material = await loadScribeSources(db, session.folder, null)
    const run = {
      project: material.project,
      pages: material.pages,
      used: new Set([page.id, scenes[1]!])
    }
    const ref0 = material.project.refOf.get(scenes[0]!) ?? ''
    const sources = answerSources(run, `It happens in ${ref0} and n9999.`, ['p1', 'nonsense', 3])
    expect(sources.scenes.map((s) => s.nodeId)).toEqual([scenes[0], scenes[1]])
    expect(sources.pages).toEqual([{ id: page.id, title: 'Rook', kind: 'note' }])
    expect(readableAnswer(run, `See ${ref0} and p1, not n9999.`)).toMatch(
      /^See .+ and Rook, not n9999\.$/
    )
  })

  it('drops the oldest tool results first when a step would go over the input budget', () => {
    const big = 'x'.repeat(600_000)
    const built = fitScribePrompt({
      mode: 'write',
      access: { notes: true, prose: true },
      context: { notes: '', map: '', book: '', bookMode: 'whole', moment: '' },
      history: [{ role: 'user', content: 'Earlier.' }],
      message: 'Now?',
      steps: [
        { call: '{"tool":"open_scene"}', result: big },
        { call: '{"tool":"open_note"}', result: 'small' }
      ],
      final: false
    })
    const contents = built.messages.map((m) => m.content)
    expect(contents).not.toContain(big)
    expect(contents).toContain('small')
    expect(contents).toContain('Earlier.')
  })
})
