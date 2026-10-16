import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import type { AgentStep } from '@shared/agent'
import { defaultAiSettings, type AssistantMode } from '@shared/aiSettings'
import { notebookDocFromText } from '@shared/notebook'
import type { TiptapNodeT } from '@shared/tiptap'
import { node } from '../db/schema'
import { saveDocument } from '../document/documentStore'
import { createNotebookItem, getNotebookPage } from '../notebook/notebookStore'
import { projectFolderFor, type ProjectSession } from '../project/projectStore'
import { getEditorSettings, setAiSettings, setEditorSettings } from '../project/settingsStore'
import { createEntity } from '../entity/entityStore'
import { addContextFiles } from '../library/libraryStore'
import { createSeededProject } from '../project/testProject'
import { createNode, getNode, listNodes, renameNode, type TreeDb } from '../tree/treeStore'
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
    expect(result.sources.pages).toEqual([{ id: mara.id, title: 'Mara', kind: 'note', quotes: [] }])
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
      scenes: material.scenes,
      used: new Set([page.id, scenes[1]!])
    }
    const ref0 = material.project.refOf.get(scenes[0]!) ?? ''
    const sources = answerSources(run, `It happens in ${ref0} and n9999.`, ['p1', 'nonsense', 3])
    expect(sources.scenes.map((s) => s.nodeId)).toEqual([scenes[0], scenes[1]])
    expect(sources.scenes.every((s) => s.quotes.length === 0)).toBe(true)
    expect(sources.pages).toEqual([{ id: page.id, title: 'Rook', kind: 'note', quotes: [] }])
    expect(readableAnswer(run, `See ${ref0} and p1, not n9999.`)).toBe(
      'See Chapter 1 and Rook, not n9999.'
    )
  })

  it('keeps each quote the scene or page holds, as it stands there, and drops the rest', async () => {
    createNotebookItem(db, {
      parentId: null,
      kind: 'page',
      title: 'Mara',
      content: notebookDocFromText('Eyes: grey. Fears the sea since the flood.')
    })
    const material = await loadScribeSources(db, session.folder, null)
    const run = { ...material, used: new Set<string>() }
    const ref0 = material.project.refOf.get(scenes[0]!) ?? ''
    const ref1 = material.project.refOf.get(scenes[1]!) ?? ''
    const sources = answerSources(run, 'She is alone.', [
      { ref: ref0, quote: 'mara climbed the ridge' },
      { ref: ref0, quote: 'She flew over the ridge' },
      { ref: ref0, quote: '“The sea was grey.”' },
      { ref: ref1, quote: 'Not in this scene at all.' },
      { ref: 'p1', quote: 'fears the sea since the flood' },
      { quote: 'no ref' }
    ])
    expect(sources.scenes).toEqual([
      {
        nodeId: scenes[0],
        title: material.project.titleOf(scenes[0]!),
        quotes: ['Mara climbed the ridge', 'The sea was grey.']
      },
      // The source stays without its spot.
      { nodeId: scenes[1], title: material.project.titleOf(scenes[1]!), quotes: [] }
    ])
    expect(sources.pages.map((p) => p.quotes)).toEqual([['Fears the sea since the flood']])
  })

  it('writes scene refs as their chapters, several in one chapter as one mention', async () => {
    const tash = getNode(db, scenes[0]!)!
    const chapter = tash.parentId!
    renameNode(db, chapter, 'Blades of Alandor')
    renameNode(db, tash.id, 'Tash')
    const sibling = createNode(db, 'novel', {
      parentId: chapter,
      kind: 'document',
      hierarchyLevel: 'scene',
      title: 'Rynna'
    })
    const material = await loadScribeSources(db, session.folder, null)
    const run = { project: material.project, pages: material.pages }
    const refOf = (id: string): string => material.project.refOf.get(id) ?? ''
    const other = material.project.rows.find(
      (row) =>
        row.kind === 'document' &&
        row.parentId !== chapter &&
        getNode(db, row.parentId!)?.sectionType === null
    )!
    const otherChapter = getNode(db, other.parentId!)!.title
    const [t, s, o] = [refOf(tash.id), refOf(sibling.id), refOf(other.id)]
    expect(material.project.titleOf(tash.id)).toBe('Blades of Alandor › Tash')
    expect(readableAnswer(run, `Mara first sees the sea in ${t}.`)).toBe(
      'Mara first sees the sea in the chapter Blades of Alandor.'
    )
    // A sentence that starts with a ref starts with a capital.
    expect(readableAnswer(run, `${t} is where she lies. ${t} ends it.`)).toBe(
      'The chapter Blades of Alandor is where she lies. The chapter Blades of Alandor ends it.'
    )
    // One chapter cited twice reads once; brackets stay.
    expect(readableAnswer(run, `She lies (${t}, ${s}).`)).toBe(
      'She lies (the chapter Blades of Alandor).'
    )
    expect(readableAnswer(run, `From ${t} and ${s}, she lies.`)).toBe(
      'From the chapter Blades of Alandor, she lies.'
    )
    // Two chapters: one mention each, a folder called "Chapter 2" as itself.
    expect(readableAnswer(run, `See ${t}, ${o} and ${s}.`)).toBe(
      `See the chapter Blades of Alandor and ${otherChapter}.`
    )
    // Her v1 habit, the full title then the ref, reads once; a bare scene title is a name, kept.
    expect(readableAnswer(run, `In Blades of Alandor › Tash (${t}), she lies.`)).toBe(
      'In the chapter Blades of Alandor, she lies.'
    )
    expect(readableAnswer(run, `Rynna argues with Tash (${t}).`)).toBe(
      'Rynna argues with Tash (the chapter Blades of Alandor).'
    )
  })

  it('names a scene outside any chapter by its own title', async () => {
    const tash = getNode(db, scenes[0]!)!
    const manuscript = listNodes(db).find((row) => row.sectionType === 'manuscript')!
    db.update(node)
      .set({ parentId: manuscript.id, title: 'Prologue' })
      .where(eq(node.id, tash.id))
      .run()
    const material = await loadScribeSources(db, session.folder, null)
    const run = { project: material.project, pages: material.pages }
    const ref = material.project.refOf.get(tash.id) ?? ''
    expect(readableAnswer(run, `It starts in ${ref}.`)).toBe('It starts in Prologue.')
    expect(
      answerSources({ ...run, scenes: material.scenes, used: new Set() }, ref, []).scenes
    ).toEqual([{ nodeId: tash.id, title: 'Prologue', quotes: [] }])
  })

  it('reads the old story bible’s sheets and uploads only while it is switched back on (fresh start)', async () => {
    createNotebookItem(db, { parentId: null, kind: 'page', title: 'Mara', content: null })
    createEntity(db, { kind: 'character', name: 'Rook' })
    await addContextFiles(db, session.folder, [
      { name: 'Powers.md', read: () => Buffer.from('# Powers\n\nShadow walking costs a memory.') }
    ])
    // A new project keeps the old story bible archived: the notes alone.
    const archived = await loadScribeSources(db, session.folder, null)
    expect(archived.pages.map((page) => [page.kind, page.title])).toEqual([['note', 'Mara']])
    expect(archived.names).toEqual(['Mara'])

    setEditorSettings(db, { ...getEditorSettings(db, 'novel'), unarchived: ['storyBible'] })
    const shown = await loadScribeSources(db, session.folder, null)
    expect(shown.pages.map((page) => [page.kind, page.title])).toEqual([
      ['note', 'Mara'],
      ['sheet', 'Rook'],
      ['library', 'Powers.md']
    ])
    expect(shown.names).toEqual(['Mara', 'Rook'])
  })

  it('reads a page ref after its own title once', async () => {
    createNotebookItem(db, { parentId: null, kind: 'page', title: 'Mara', content: null })
    const material = await loadScribeSources(db, session.folder, null)
    const run = { project: material.project, pages: material.pages }
    expect(readableAnswer(run, 'Mara (p1) fears the sea; see her page (p1).')).toBe(
      'Mara fears the sea; see her page (Mara).'
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
