import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAiModels, defaultLocalAiSettings } from '@shared/ai'
import { defaultAiSettings, type AiDial } from '@shared/aiSettings'
import type { ImportDetectProgress, ImportDetectResult } from '@shared/importStructure'
import type {
  Channel,
  EventName,
  EventPayload,
  Input,
  Output,
  ProjectInfo,
  TreeNode
} from '@shared/ipc/contract'
import { resetAiActivityStore, useAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetAiStore, useAiStore } from '@renderer/features/ai/aiStore'
import { resetProposalStore } from '@renderer/features/ai/proposalStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { resetDocumentStore } from '@renderer/features/editor/documentStore'
import { resetGoalsStore } from '@renderer/features/goals/goalsStore'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { draftFixture, mixedDraftFixture } from './draftFixture'
import { resetImportStore, useImportStore } from './importStore'

let invoke: ReturnType<typeof vi.fn<(channel: string, input: unknown) => Promise<unknown>>>
/** The listener `import:detectProgress` was subscribed with, so a test can push a chunk. */
let progress: ((payload: ImportDetectProgress) => void) | null = null
let settles: Input<'proposal:settle'>[] = []
let cancels: string[] = []

/** The rows main answers `import:commit` with: a part, its chapter, and two scenes after the seed. */
function importedRows(): TreeNode[] {
  const row = (
    id: string,
    parentId: string,
    position: number,
    title: string,
    kind: 'folder' | 'document',
    hierarchyLevel: 'part' | 'chapter' | 'scene' | null,
    wordCount = 0
  ): TreeNode => ({
    id,
    parentId,
    sectionType: null,
    kind,
    hierarchyLevel,
    title,
    position,
    wordCount,
    matterType: null,
    preset: null,
    created: '2026-09-22T10:00:00.000Z',
    modified: '2026-09-22T10:00:00.000Z'
  })
  return [
    row('i-part', 'manuscript', 2, 'Part One', 'folder', 'part'),
    row('i-ch', 'i-part', 0, 'Chapter One', 'folder', 'chapter'),
    row('i-s1', 'i-ch', 0, 'Scene 1', 'document', 'scene', 6),
    row('i-s2', 'i-ch', 1, 'Scene 2', 'document', 'scene', 3)
  ]
}

function install(overrides: Partial<Record<string, unknown>> = {}): void {
  settles = []
  cancels = []
  invoke = vi.fn(async (channel: string, input: unknown) => {
    if (channel in overrides) {
      const value = overrides[channel]
      if (value instanceof Error) throw value
      return value
    }
    if (channel === 'tree:list') return treeFixture
    if (channel === 'import:open') return draftFixture()
    if (channel === 'import:commit') {
      return {
        nodes: importedRows(),
        words: 9,
        tree: [...treeFixture, ...importedRows()],
        rewritten: []
      }
    }
    if (channel === 'import:createProject') return project
    if (channel === 'proposal:settle') {
      settles.push(input as Input<'proposal:settle'>)
      return null
    }
    if (channel === 'ai:cancel') {
      cancels.push((input as Input<'ai:cancel'>).requestId)
      return { cancelled: true }
    }
    throw new Error(`unexpected ${channel}`)
  })
  const client: IpcClient = {
    invoke: <C extends Channel>(channel: C, input: Input<C>) =>
      invoke(channel, input) as Promise<Output<C>>,
    on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void) {
      if (event === 'import:detectProgress') {
        progress = listener as (payload: ImportDetectProgress) => void
      }
      return () => {
        progress = null
      }
    }
  }
  setIpcClient(client)
}

/** Turns the AI pass on: the dial at Suggest (its `minDial`) with the fast model the tab shows. */
function allowDetect(dial: AiDial = 2): void {
  useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial } })
  useAiStore.setState({
    status: {
      provider: 'openai',
      hasKey: true,
      hint: 'sk-…1234',
      encryption: 'os',
      models: defaultAiModels(),
      local: defaultLocalAiSettings()
    }
  })
}

/** What main answers a finished pass with: one break inside the fixture's first scene, one title. */
const detectOk = (over: Partial<Extract<ImportDetectResult, { ok: true }>> = {}) =>
  ({
    ok: true,
    suggestions: {
      breaks: [{ before: 1, kind: 'scene', reason: 'time skip' }],
      scenes: [{ start: 1, title: 'Nobody Moves', tags: ['mara'] }]
    },
    chunks: 1,
    usage: { inputTokens: 900, outputTokens: 40 },
    costUsd: 0.0004,
    model: 'gpt-5.4-mini',
    promptVersion: 'importStructure.v1',
    proposalIds: ['pr-1'],
    ...over
  }) satisfies ImportDetectResult

const detect = () => useImportStore.getState().detect

/** The open project an import writes into (and the one `import:createProject` answers). */
const project: ProjectInfo = {
  id: 'p-1',
  name: 'Book',
  format: 'novel',
  path: '/tmp/Book.mythscribe',
  created: 'c',
  modified: 'm',
  lastOpened: 'l',
  schemaVersion: 1
}

const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

// The project store is app-wide: other files expect it to start with no project open.
afterEach(() => {
  useProjectStore.setState({ current: null, busy: false })
})

beforeEach(() => {
  install()
  resetImportStore()
  resetAiSettingsStore()
  resetAiStore()
  resetAiActivityStore()
  resetProposalStore()
  progress = null
  resetPendingSaves()
  // A commit that rewrote scenes reloads their loaded copies: none may be left from another file.
  resetDocumentStore()
  resetGoalsStore()
  useProjectStore.setState({ current: project, busy: false })
  useTreeStore.getState().clear()
  useDialogStore.setState({ modals: [], toasts: [] })
})

describe('useImportStore (F-12.2)', () => {
  it('holds the draft main answers with, and keeps nothing when the file dialog is cancelled', async () => {
    await useImportStore.getState().open()
    expect(invoke).toHaveBeenCalledWith('import:open', {})
    expect(useImportStore.getState().draft?.source.name).toBe('novel.docx')
    expect(useImportStore.getState().busy).toBe(false)

    resetImportStore()
    install({ 'import:open': null })
    await useImportStore.getState().open()
    expect(useImportStore.getState().draft).toBeNull()
    expect(toasts()).toEqual([])
  })

  it('passes a path straight through, for the file the caller already picked', async () => {
    await useImportStore.getState().open('/tmp/book.md')
    expect(invoke).toHaveBeenCalledWith('import:open', { path: '/tmp/book.md' })
  })

  it('toasts an unreadable file and leaves no draft behind', async () => {
    install({ 'import:open': new Error('The file has no text to import.') })
    await useImportStore.getState().open()
    expect(toasts()).toEqual(['The file has no text to import.'])
    expect(useImportStore.getState().draft).toBeNull()
    expect(useImportStore.getState().busy).toBe(false)
  })

  it('edits the draft through the pure helpers, without touching main', async () => {
    await useImportStore.getState().open()
    const store = useImportStore.getState()
    store.rename('p2c1', 'The Return')
    store.remove('p1c2')
    store.setPlacement('p1c1', 'front')
    store.move('p2', -1)
    store.splitScene('p2c1s1', 1)
    const draft = useImportStore.getState().draft
    expect(draft?.parts.map((p) => p.id)).toEqual(['p2', 'p1'])
    expect(draft?.parts[0]?.chapters[0]?.title).toBe('The Return')
    expect(draft?.parts[0]?.chapters[0]?.scenes).toHaveLength(2)
    expect(draft?.parts[1]?.chapters.map((c) => [c.id, c.placement])).toEqual([['p1c1', 'front']])
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('ends an inline rename and clears the split pane when the scene is merged away', async () => {
    await useImportStore.getState().open()
    useImportStore.getState().startRename('p1')
    expect(useImportStore.getState().renamingId).toBe('p1')
    useImportStore.getState().rename('p1', 'Book One')
    expect(useImportStore.getState().renamingId).toBeNull()

    useImportStore.getState().selectScene('p1c1s2')
    useImportStore.getState().mergeWithNext('p1c1s1')
    expect(useImportStore.getState().sceneId).toBeNull()
    expect(useImportStore.getState().draft?.parts[0]?.chapters[0]?.scenes).toHaveLength(1)
  })

  it('commits the edited draft, merges the rows into the tree, and selects the first scene', async () => {
    await useTreeStore.getState().load()
    await useImportStore.getState().open()
    useImportStore.getState().rename('p2c1', 'The Return')
    const edited = useImportStore.getState().draft
    await useImportStore.getState().commit()

    expect(invoke).toHaveBeenCalledWith('import:commit', { draft: edited })
    const tree = useTreeStore.getState()
    expect(tree.childrenOf.manuscript).toEqual(['arc-1', 'arc-2', 'i-part'])
    expect(tree.childrenOf['i-ch']).toEqual(['i-s1', 'i-s2'])
    expect(tree.sectionOf['i-s1']).toBe('manuscript')
    expect(tree.wordCountRollup['i-part']).toBe(9)
    expect(tree.selectedId).toBe('i-s1')
    // The ancestors of the first imported scene are open, so it is visible.
    expect(tree.collapsed['i-ch']).toBe(false)
    expect(tree.collapsed['i-part']).toBe(false)
    expect(tree.collapsed.manuscript).toBe(false)
    // The existing rows and their words are untouched.
    expect(tree.byId['sc-1']?.wordCount).toBe(1200)
    expect(toasts()).toEqual(['Imported 2 scenes (9 words)'])
    expect(useImportStore.getState().draft).toBeNull()
    expect(useImportStore.getState().busy).toBe(false)
  })

  it('keeps the draft and toasts when the commit fails, so nothing the author corrected is lost', async () => {
    install({ 'import:commit': new Error('Nothing selected to import.') })
    await useImportStore.getState().open()
    await useImportStore.getState().commit()
    expect(toasts()).toEqual(['Nothing selected to import.'])
    expect(useImportStore.getState().draft).not.toBeNull()
    expect(useImportStore.getState().busy).toBe(false)
  })

  it('drops the draft on cancel and ignores a response that arrives after it', async () => {
    let release: (value: unknown) => void = () => {}
    install({ 'import:open': new Promise((resolve) => (release = resolve)) })
    const pending = useImportStore.getState().open()
    useImportStore.getState().cancel()
    release(draftFixture())
    await pending
    expect(useImportStore.getState().draft).toBeNull()
    expect(useImportStore.getState().busy).toBe(false)
  })
})

describe('useImportStore, selection, undo, and the combined outline (F-12.2 rework)', () => {
  it('ticks rows, extends a range with Shift within one level, and merges the ticked scenes', async () => {
    await useImportStore.getState().open()
    const store = useImportStore.getState()
    store.toggleSelect('p1c1s1', false)
    store.toggleSelect('p1c2s1', true)
    expect(useImportStore.getState().selected).toEqual(['p1c1s1', 'p1c1s2', 'p1c2s1'])
    // A range never crosses levels: Shift on a chapter just ticks it.
    store.toggleSelect('p2c1', true)
    expect(useImportStore.getState().selected).toContain('p2c1')
    store.toggleSelect('p2c1', false)
    store.mergeSelected()
    const scenes = useImportStore.getState().draft?.parts[0]?.chapters
    expect(scenes?.map((c) => c.scenes.length)).toEqual([1, 0])
    expect(useImportStore.getState().selected).toEqual([])
  })

  it('refuses to merge a mix of levels and deletes the selection instead when asked', async () => {
    await useImportStore.getState().open()
    const store = useImportStore.getState()
    store.toggleSelect('p1c1s1', false)
    store.toggleSelect('p2c1', false)
    const before = useImportStore.getState().draft
    store.mergeSelected()
    expect(useImportStore.getState().draft).toBe(before)
    store.removeSelected()
    const draft = useImportStore.getState().draft
    expect(draft?.parts[0]?.chapters[0]?.scenes.map((s) => s.id)).toEqual(['p1c1s2'])
    expect(draft?.parts[1]?.chapters).toEqual([])
  })

  it('undoes edits one at a time and drops ids that left the draft from the selection', async () => {
    await useImportStore.getState().open()
    const original = useImportStore.getState().draft
    useImportStore.getState().toggleSelect('p1c1s2', false)
    useImportStore.getState().remove('p1c1s2')
    expect(useImportStore.getState().selected).toEqual([])
    useImportStore.getState().rename('p1', 'Book One')
    expect(useImportStore.getState().history).toHaveLength(2)
    useImportStore.getState().undo()
    useImportStore.getState().undo()
    expect(useImportStore.getState().draft).toBe(original)
    useImportStore.getState().undo()
    expect(useImportStore.getState().draft).toBe(original)
  })

  it('moves a dropped row through the pure edit', async () => {
    await useImportStore.getState().open()
    useImportStore.getState().moveTo('p2c1s1', 'p1c1s1', 'before')
    const first = useImportStore.getState().draft?.parts[0]?.chapters[0]?.scenes[0]
    expect(first?.id).toBe('p2c1s1')
  })

  it('rebuilds the tree from main’s answer, so deleted and moved rows follow', async () => {
    install({
      'import:open': mixedDraftFixture(),
      'import:commit': {
        nodes: importedRows(),
        words: 9,
        tree: [...treeFixture.filter((row) => row.id !== 'sc-1'), ...importedRows()],
        rewritten: ['sc-2']
      }
    })
    await useTreeStore.getState().load()
    useTreeStore.getState().select('sc-1')
    await useImportStore.getState().open()
    await useImportStore.getState().commit()
    const tree = useTreeStore.getState()
    expect(tree.byId['sc-1']).toBeUndefined()
    expect(tree.selectedId).toBe('i-s1')
    expect(useImportStore.getState().draft).toBeNull()
  })
})

describe('useImportStore, import to start (F-12.2)', () => {
  it('reviews into a new project named after the file, and creates and opens it at Import', async () => {
    useProjectStore.setState({ current: null })
    allowDetect()
    await useImportStore.getState().open()
    expect(useImportStore.getState()).toMatchObject({
      target: 'new',
      projectName: 'novel',
      projectFormat: 'novel',
      // The new project has no AI settings yet: no pass is offered.
      detect: null
    })
    useImportStore.getState().setProjectName('The Storm')
    useImportStore.getState().setProjectFormat('epic')
    const draft = useImportStore.getState().draft
    await useImportStore.getState().commit()
    expect(invoke).toHaveBeenCalledWith('import:createProject', {
      draft,
      name: 'The Storm',
      format: 'epic'
    })
    expect(useProjectStore.getState().current).toEqual(project)
    expect(useImportStore.getState().draft).toBeNull()
    expect(toasts()).toEqual(['Created "Book" from novel.docx'])
  })

  it('keeps the review when the save dialog is cancelled, and refuses a blank name', async () => {
    useProjectStore.setState({ current: null })
    install({ 'import:createProject': null })
    await useImportStore.getState().open()
    await useImportStore.getState().commit()
    expect(useImportStore.getState().draft).not.toBeNull()
    expect(useImportStore.getState().busy).toBe(false)
    expect(useProjectStore.getState().current).toBeNull()

    useImportStore.getState().setProjectName('   ')
    invoke.mockClear()
    await useImportStore.getState().commit()
    expect(invoke).not.toHaveBeenCalled()
    expect(toasts()).toEqual(['Give the project a name first.'])
  })
})

describe('useImportStore, the AI structure pass (F-12.3)', () => {
  it('offers the pass with an estimate, and nothing at all when the feature is not allowed', async () => {
    // No settings loaded: no offer, and nothing about AI in the dialog.
    await useImportStore.getState().open()
    expect(detect()).toBeNull()

    resetImportStore()
    allowDetect(1) // Ask: below the feature's minimum.
    await useImportStore.getState().open()
    expect(detect()).toBeNull()

    resetImportStore()
    allowDetect()
    await useImportStore.getState().open()
    expect(detect()).toMatchObject({ status: 'offer', words: 22, proposalIds: [], rejected: 0 })
    expect(detect()?.estimate).toMatchObject({ chunks: 1, priced: true })
    expect(detect()?.estimate.costUsd).toBeGreaterThan(0)
  })

  it('follows the author’s deletions, so the price is for what would really be sent', async () => {
    allowDetect()
    await useImportStore.getState().open()
    const before = detect()?.words ?? 0
    useImportStore.getState().remove('p2')
    expect(detect()?.words).toBe(before - 9)
    expect(detect()?.status).toBe('offer')
  })

  it('keeps the heuristic draft when the author skips, and sends nothing', async () => {
    allowDetect()
    await useImportStore.getState().open()
    useImportStore.getState().skipDetect()
    expect(detect()?.status).toBe('skipped')
    await useImportStore.getState().startDetect()
    expect(invoke).not.toHaveBeenCalledWith('import:detectStructure', expect.anything())
  })

  it('runs the pass, shows the chunks as they land, freezes the draft, and merges the result', async () => {
    let release: (result: ImportDetectResult) => void = () => {}
    install({
      'import:detectStructure': new Promise<ImportDetectResult>((resolve) => (release = resolve))
    })
    allowDetect()
    await useImportStore.getState().open()
    const pending = useImportStore.getState().startDetect()

    const requestId = detect()?.requestId
    expect(detect()?.status).toBe('running')
    expect(typeof requestId).toBe('string')
    expect(invoke).toHaveBeenCalledWith('import:detectStructure', {
      draft: useImportStore.getState().draft,
      requestId
    })
    // Tracked, so the header indicator shows it and its Stop can find it (F-5.10).
    expect(Object.keys(useAiActivityStore.getState().inflight)).toEqual([requestId])

    progress?.({ done: 1, total: 3, costUsd: 0.0002 })
    expect(detect()?.progress).toEqual({ done: 1, total: 3, costUsd: 0.0002 })

    // The suggestions index the draft main was given, so nothing may move under them.
    const frozen = useImportStore.getState().draft
    useImportStore.getState().rename('p1', 'Book One')
    useImportStore.getState().splitScene('p2c1s1', 1)
    expect(useImportStore.getState().draft).toBe(frozen)

    release(detectOk())
    await pending
    const scenes = useImportStore.getState().draft?.parts[0]?.chapters[0]?.scenes ?? []
    expect(scenes.map((s) => s.title)).toEqual(['Scene 1', 'Nobody Moves', 'Scene 2'])
    expect(scenes[1]?.tags).toEqual(['mara'])
    expect(scenes[1]?.ai).toEqual({ break: true, title: true, reason: 'time skip' })
    expect(detect()).toMatchObject({
      status: 'done',
      requestId: null,
      progress: null,
      proposalIds: ['pr-1'],
      outcome: { added: 1, titled: 1, chunks: 1, model: 'gpt-5.4-mini', costUsd: 0.0004 }
    })
    expect(useAiActivityStore.getState().inflight).toEqual({})
  })

  it('settles the chunk proposals accepted at Import, and acceptedPart when a suggestion is rejected', async () => {
    install({ 'import:detectStructure': detectOk() })
    allowDetect()
    await useTreeStore.getState().load()
    await useImportStore.getState().open()
    await useImportStore.getState().startDetect()
    await useImportStore.getState().commit()
    expect(settles).toEqual([{ id: 'pr-1', status: 'accepted', note: null }])

    resetProposalStore()
    install({ 'import:detectStructure': detectOk() })
    await useImportStore.getState().open()
    await useImportStore.getState().startDetect()
    useImportStore.getState().rejectSuggestion('p1c1s1-x1')
    expect(detect()?.rejected).toBe(1)
    expect(useImportStore.getState().draft?.parts[0]?.chapters[0]?.scenes).toHaveLength(2)
    await useImportStore.getState().commit()
    expect(settles).toEqual([{ id: 'pr-1', status: 'acceptedPart', note: null }])
  })

  it('rejects the chunk proposals when the draft is dropped, and stops a pass still running', async () => {
    let release: (result: ImportDetectResult) => void = () => {}
    install({
      'import:detectStructure': new Promise<ImportDetectResult>((resolve) => (release = resolve))
    })
    allowDetect()
    await useImportStore.getState().open()
    const pending = useImportStore.getState().startDetect()
    const requestId = detect()?.requestId
    useImportStore.getState().cancel()
    expect(cancels).toEqual([requestId])
    expect(detect()).toBeNull()

    // The reply lands after the draft is gone: what it did spend is rejected, not left pending.
    release(detectOk())
    await pending
    expect(settles).toEqual([{ id: 'pr-1', status: 'rejected', note: null }])
    expect(useImportStore.getState().draft).toBeNull()
  })

  it('shows an expected failure with its next step, and puts the offer back when the author stops it', async () => {
    install({
      'import:detectStructure': {
        ok: false,
        code: 'NO_KEY',
        message: 'No OpenAI key is saved.',
        nextStep: 'Add a key above and save it.'
      }
    })
    allowDetect()
    await useImportStore.getState().open()
    await useImportStore.getState().startDetect()
    expect(detect()).toMatchObject({
      status: 'failed',
      requestId: null,
      error: { message: 'No OpenAI key is saved.', nextStep: 'Add a key above and save it.' }
    })
    // The draft is untouched and the author can edit it again.
    useImportStore.getState().rename('p1', 'Book One')
    expect(useImportStore.getState().draft?.parts[0]?.title).toBe('Book One')

    install({
      'import:detectStructure': { ok: false, code: 'CANCELLED', message: 'Stopped.', nextStep: '' }
    })
    await useImportStore.getState().startDetect()
    expect(detect()).toMatchObject({ status: 'offer', error: null, progress: null })
    expect(settles).toEqual([])
  })

  it('cancels the request the author stops, and keeps the draft as the heuristics left it', async () => {
    let release: (result: ImportDetectResult) => void = () => {}
    install({
      'import:detectStructure': new Promise<ImportDetectResult>((resolve) => (release = resolve))
    })
    allowDetect()
    await useImportStore.getState().open()
    const pending = useImportStore.getState().startDetect()
    const requestId = detect()?.requestId
    useImportStore.getState().cancelDetect()
    expect(cancels).toEqual([requestId])

    release({ ok: false, code: 'CANCELLED', message: 'Stopped.', nextStep: '' })
    await pending
    expect(detect()?.status).toBe('offer')
    expect(useImportStore.getState().draft?.parts[0]?.chapters[0]?.scenes).toHaveLength(2)
  })

  it('toasts a bridge failure and leaves the pass failed rather than stuck running', async () => {
    install({ 'import:detectStructure': new Error('The bridge is down.') })
    allowDetect()
    await useImportStore.getState().open()
    await useImportStore.getState().startDetect()
    expect(detect()).toMatchObject({
      status: 'failed',
      error: { message: 'The bridge is down.', nextStep: '' }
    })
  })
})
