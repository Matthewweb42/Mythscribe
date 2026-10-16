import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import type { EditFlowRun, EditFlowSpec } from '@shared/editFlow'
import { notebookDocFromText } from '@shared/notebook'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { listChanges, listPassRows, pendingChangesFor } from '../editPass/editPassStore'
import {
  createNotebookItem,
  getNotebookPage,
  listNotebook,
  listNotebookPages,
  listNotebookVersions,
  restoreNotebookVersion,
  updateNotebookItem
} from '../notebook/notebookStore'
import { projectFolderFor, type ProjectSession } from '../project/projectStore'
import { setAiSettings } from '../project/settingsStore'
import { createSeededProject } from '../project/testProject'
import { getNode, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { defaultAiUsageState, dayOf } from '../ai/dailyCap'
import { loadAgentProject } from '../ai/agentTools'
import { resetInflight } from '../ai/inflight'
import { EDIT_FLOW_SENTINEL } from '../ai/prompts/editFlow.v1'
import type { CompletionRequest, CompletionResult, Provider } from '../ai/providers/types'
import type { AiRequestDeps } from '../ai/request'
import type { UsageEntry } from '../ai/usageStore'
import { resetVoiceProfileCache } from '../voice/versionCache'
import { flowDetail, listFlowRuns, markNoteEditUndone } from './flowStore'
import { createEditFlowRunner, prepareFlow, type EditFlowRunner } from './run'

const NOW = new Date(2026, 9, 15, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>

let tmp: string
let session: ProjectSession
let db: TreeDb | null
let complete: ReturnType<typeof vi.fn<Complete>>
let deps: AiRequestDeps
let ledger: UsageEntry[]
let scenes: string[]
let moves: EditFlowRun[]
let changed: string[][]
let runner: EditFlowRunner

const SCENE_ONE = ['Mara climbed the ridge alone.', 'Her eyes were brown as river mud.', 'She teh sea below.']
const SCENE_TWO = ['Rook waited at the quay with the ledger.']

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

function openDb(): TreeDb {
  if (db === null) throw new Error('closed')
  return db
}

function replies(...values: unknown[]): void {
  for (const value of values) {
    complete.mockResolvedValueOnce({
      text: JSON.stringify(value),
      model: 'deepseek-v4-flash',
      usage: { inputTokens: 1_000, outputTokens: 100 }
    })
  }
}

const request = (call: number): CompletionRequest => {
  const value = complete.mock.calls[call]?.[0]
  if (!value) throw new Error(`no request ${call}`)
  return value
}

const refOf = (nodeId: string): string =>
  loadAgentProject(openDb(), null, 'v1').refOf.get(nodeId) ?? ''

const sceneSpec = (over: Partial<EditFlowSpec> = {}): EditFlowSpec => ({
  categories: ['copy'],
  depth: 'quick',
  scope: { kind: 'scene', nodeId: scenes[0] ?? null },
  ...over
})

beforeEach(() => {
  resetInflight()
  resetVoiceProfileCache()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-editflow-'))
  session = createSeededProject(projectFolderFor(tmp, 'Flow'), 'Flow', 'novel')
  db = session.connection.orm
  scenes = manuscriptDocuments(db).map((row) => row.id)
  saveDocument(db, scenes[0]!, doc(...SCENE_ONE))
  saveDocument(db, scenes[1]!, doc(...SCENE_TWO))
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  complete = vi.fn<Complete>()
  ledger = []
  moves = []
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
  runner = createEditFlowRunner({
    db: () => db,
    folder: () => (db === null ? null : session.folder),
    requestDeps: () => deps,
    onChange: (run) => void moves.push(run),
    notebookChanged: (ids) => void changed.push(ids),
    now: () => '2026-10-15T10:00:00.000Z'
  })
})

afterEach(() => {
  runner.clear()
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the edit flow’s plan and price (editFlow:plan)', () => {
  it('counts one request per stage and one for the checks together, with the notes and map in the prefix', async () => {
    createNotebookItem(openDb(), {
      parentId: null,
      kind: 'page',
      title: 'Style guide',
      content: notebookDocFromText('Serial comma.')
    })
    const spec = sceneSpec({ categories: ['copy', 'line', 'continuity', 'voice'] })
    const plan = await runner.plan(spec)
    expect(plan).toMatchObject({ scenes: 1, words: 16, requests: 3 })
    expect(plan.tokensIn).toBeGreaterThan(plan.tokensOut)
    const prep = await prepareFlow(openDb(), session.folder, spec)
    expect(prep.requests.map((r) => r.family)).toEqual(['line', 'copy', 'checks'])
    expect(prep.styleGuide).toEqual({ ref: 'p1', title: 'Style guide' })
    expect(prep.notes).toContain('Serial comma.')
    expect(complete).not.toHaveBeenCalled()
  })

  it('a chapter covers the scenes under it; an empty scope says so', async () => {
    const chapter = getNode(openDb(), scenes[0]!)?.parentId ?? null
    const plan = await runner.plan(sceneSpec({ scope: { kind: 'chapter', nodeId: chapter } }))
    expect(plan.scopeTitle).toBe(getNode(openDb(), chapter!)?.title)
    expect(plan.scenes).toBeGreaterThanOrEqual(1)
    await expect(
      runner.plan(sceneSpec({ scope: { kind: 'scene', nodeId: scenes[2] ?? 'missing' } }))
    ).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('an edit-flow run (editFlow:start)', () => {
  it('a Quick copyedit keeps a fix as a pending tracked change and an issue without one, on fast', async () => {
    const ref = refOf(scenes[0]!)
    replies({
      issues: [
        { scene: ref, quote: 'She teh sea below.', problem: 'Typo.', fix: 'She saw the sea below.' },
        { scene: ref, quote: 'brown as river mud', problem: 'Grey on her page?', fix: null },
        { scene: ref, quote: 'Not in the scene at all', problem: 'x', fix: null }
      ]
    })
    const started = await runner.start(sceneSpec())
    expect(started.status).toBe('running')
    await runner.idle()
    expect(request(0).messages[0]?.content.startsWith(EDIT_FLOW_SENTINEL)).toBe(true)
    expect(request(0).messages[1]?.content).toContain('Copyediting:')
    expect(request(0).messages[1]?.content).toContain('She has no style guide page')
    expect(request(0).messages[1]?.content).toContain(`### ${ref} `)
    expect(ledger.map((row) => [row.feature, row.tier])).toEqual([['editFlow', 'fast']])

    const run = listFlowRuns(openDb())[0]
    expect(run).toMatchObject({ status: 'done', done: 1, total: 1, dropped: 1 })
    expect(run?.counts.pending).toBe(2)
    // The fix is an edit-pass change the editor draws; the classic list never shows the run.
    expect(pendingChangesFor(openDb(), scenes[0]!)).toMatchObject([
      { original: 'She teh sea below.', replacement: 'She saw the sea below.', kind: 'change' }
    ])
    expect(listPassRows(openDb()).every((row) => row.flow !== null)).toBe(true)

    const detail = flowDetail(openDb(), started.id, () => SCENE_ONE.join('\n\n'), () => 'Scene 1')
    expect(detail.issues.map((issue) => [issue.flowCategory, issue.kind, issue.textChanged])).toEqual(
      [
        ['copy', 'note', false],
        ['copy', 'change', false]
      ]
    )
    // The author's edits moved a passage: it reads "text changed".
    const edited = flowDetail(openDb(), started.id, () => 'Mara climbed.', () => 'Scene 1')
    expect(edited.issues.every((issue) => issue.textChanged)).toBe(true)
    expect(moves.at(-1)?.status).toBe('done')
  })

  it('keeps the latest run per scope: a second run of the same scope replaces the first', async () => {
    replies({ issues: [] }, { issues: [] }, { issues: [] })
    const first = await runner.start(sceneSpec())
    await runner.idle()
    const other = await runner.start(sceneSpec({ scope: { kind: 'book', nodeId: null } }))
    await runner.idle()
    const second = await runner.start(sceneSpec({ categories: ['proofread'] }))
    await runner.idle()
    expect(listFlowRuns(openDb()).map((run) => run.id)).toEqual([second.id, other.id])
    expect(listFlowRuns(openDb()).map((run) => run.id)).not.toContain(first.id)
  })

  it('Developmental writes the overview and issues with no fix; Deep goes out on strong', async () => {
    replies({
      overview: 'The opening works; the quay scene has no stakes.',
      issues: [{ scene: refOf(scenes[1]!), quote: 'Rook waited at the quay', problem: 'Why now?', fix: 'x' }]
    })
    const run = await runner.start(
      sceneSpec({ categories: ['developmental'], depth: 'deep', scope: { kind: 'book', nodeId: null } })
    )
    await runner.idle()
    expect(ledger.map((row) => row.tier)).toEqual(['strong'])
    const detail = flowDetail(openDb(), run.id, () => SCENE_TWO.join('\n\n'), () => 'Scene 2')
    expect(detail.run.overview).toBe('The opening works; the quay scene has no stakes.')
    expect(detail.issues).toMatchObject([
      { flowCategory: 'developmental', kind: 'note', replacement: null }
    ])
  })

  it('Deep on one scene reads the rest of the book for reference, never Quick', async () => {
    const deep = await prepareFlow(openDb(), session.folder, sceneSpec({ depth: 'deep' }))
    expect(deep.reference).toContain('Rook waited at the quay with the ledger.')
    expect(deep.reference).not.toContain('Mara climbed the ridge alone.')
    const quick = await prepareFlow(openDb(), session.folder, sceneSpec())
    expect(quick.reference).toBeNull()
    const book = await prepareFlow(
      openDb(),
      session.folder,
      sceneSpec({ depth: 'deep', scope: { kind: 'book', nodeId: null } })
    )
    expect(book.reference).toBeNull()
  })

  it('Update notes edits a page and makes one, each with its Undo kept', async () => {
    const mara = createNotebookItem(openDb(), {
      parentId: null,
      kind: 'page',
      title: 'Mara',
      content: notebookDocFromText('Eyes: grey.')
    })
    replies({
      notes: [
        { page: 'p1', add: 'Climbs the ridge alone (Chapter 1).' },
        { title: 'Rook', folder: '', text: 'Waits at the quay with the ledger.' }
      ]
    })
    const run = await runner.start(sceneSpec({ categories: ['updateNotes'] }))
    await runner.idle()
    expect(request(0).messages[1]?.content).toContain('Update her notes')
    expect(getNotebookPage(openDb(), mara.id).plain).toBe(
      'Eyes: grey.\nClimbs the ridge alone (Chapter 1).'
    )
    expect(listNotebookVersions(openDb(), mara.id).map((v) => v.author)).toEqual(['ai'])
    expect(listNotebookPages(openDb()).map((page) => page.title).sort()).toEqual(['Mara', 'Rook'])
    expect(changed.flat()).toContain(mara.id)
    const kept = listFlowRuns(openDb()).find((r) => r.id === run.id)
    expect(kept?.noteEdits.map((entry) => [entry.edit.kind, entry.undone])).toEqual([
      ['notebook', false],
      ['notebook', false]
    ])
    expect(markNoteEditUndone(openDb(), run.id, 0)).toBe(true)
    expect(markNoteEditUndone(openDb(), run.id, 0)).toBe(false)
    expect(listFlowRuns(openDb())[0]?.noteEdits[0]?.undone).toBe(true)
  })

  it('Update notes (editNotes.v2) makes the Story timeline page in Timeline once, then inserts events in story order with Undo', async () => {
    replies({
      notes: [],
      timeline: [
        { line: 'Ch 1 · Mara climbs the ridge alone.', after: '' },
        { line: 'Ch 1 · Mara sees the sea.', after: 'Ch 1 · Mara climbs the ridge alone.' }
      ]
    })
    const first = await runner.start(sceneSpec({ categories: ['updateNotes'] }))
    await runner.idle()
    expect(request(0).messages[1]?.content).toContain('Story timeline')
    const timelineRoot = listNotebook(openDb()).find((item) => item.role === 'timeline')
    const pages = listNotebook(openDb()).filter((item) => item.title === 'Story timeline')
    expect(pages).toHaveLength(1)
    expect(pages[0]?.parentId).toBe(timelineRoot?.id)
    const pageId = pages[0]?.id ?? ''
    expect(getNotebookPage(openDb(), pageId).plain).toBe(
      'Ch 1 · Mara climbs the ridge alone.\nCh 1 · Mara sees the sea.'
    )
    expect(listFlowRuns(openDb()).find((r) => r.id === first.id)?.noteEdits).toMatchObject([
      { edit: { kind: 'notebook', pageId, created: true }, undone: false }
    ])

    // The author adds her own line; a flashback's event goes where it happened, hers stay.
    updateNotebookItem(openDb(), {
      id: pageId,
      content: notebookDocFromText(
        'Ch 1 · Mara climbs the ridge alone.\nCh 1 · Mara sees the sea.\nMy note: the storm comes later.'
      )
    })
    replies({
      notes: [],
      timeline: [
        { line: 'Ch 2 · Years before, Rook burns the first ledger.', after: '' },
        { line: 'Ch 1 · Mara sees the sea.', after: '' }
      ]
    })
    const second = await runner.start(sceneSpec({ categories: ['updateNotes'] }))
    await runner.idle()
    // The page goes whole into the notes the request carries.
    expect(request(1).messages[0]?.content).toContain('Story timeline')
    expect(getNotebookPage(openDb(), pageId).plain).toBe(
      [
        'Ch 2 · Years before, Rook burns the first ledger.',
        'Ch 1 · Mara climbs the ridge alone.',
        'Ch 1 · Mara sees the sea.',
        'My note: the storm comes later.'
      ].join('\n')
    )
    expect(listNotebook(openDb()).filter((item) => item.title === 'Story timeline')).toHaveLength(1)
    const kept = listFlowRuns(openDb()).find((r) => r.id === second.id)?.noteEdits[0]?.edit
    if (kept?.kind !== 'notebook' || kept.versionId === null) throw new Error('no version kept')
    expect(kept.created).toBe(false)
    restoreNotebookVersion(openDb(), kept.versionId)
    expect(getNotebookPage(openDb(), pageId).plain).toContain('My note: the storm comes later.')
    expect(getNotebookPage(openDb(), pageId).plain).not.toContain('Rook')
  })

  it('Update notes makes no Story timeline page when there is no event', async () => {
    replies({ notes: [], timeline: [] })
    await runner.start(sceneSpec({ categories: ['updateNotes'] }))
    await runner.idle()
    expect(listNotebook(openDb()).some((item) => item.title === 'Story timeline')).toBe(false)
  })

  it('a stopped run keeps what came back; one run at a time', async () => {
    const chapterSpec = sceneSpec({ categories: ['copy', 'proofread'] })
    let release: () => void = () => undefined
    complete.mockResolvedValueOnce({
      text: JSON.stringify({
        issues: [{ scene: refOf(scenes[0]!), quote: 'She teh sea below.', problem: 'Typo.', fix: 'She saw the sea below.' }]
      }),
      model: 'deepseek-v4-flash',
      usage: { inputTokens: 1_000, outputTokens: 100 }
    })
    complete.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ text: '{"issues":[]}', model: 'deepseek-v4-flash', usage: { inputTokens: 1, outputTokens: 1 } })
        })
    )
    const run = await runner.start(chapterSpec)
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2))
    await expect(runner.start(chapterSpec)).rejects.toMatchObject({ code: 'VALIDATION' })
    runner.cancel(run.id)
    release()
    await runner.idle()
    const kept = listFlowRuns(openDb())[0]
    expect(kept).toMatchObject({ id: run.id, status: 'cancelled', done: 1, total: 2 })
    expect(listChanges(openDb(), { passId: run.id })).toHaveLength(1)
  })

  it('refuses when the feature is off', async () => {
    setAiSettings(openDb(), {
      ...defaultAiSettings(),
      dial: 1,
      features: { ...defaultAiSettings().features, editFlow: false }
    })
    await expect(runner.start(sceneSpec())).rejects.toMatchObject({ code: 'DISABLED' })
    expect(complete).not.toHaveBeenCalled()
  })
})
