import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output, TreeNode } from '@shared/ipc/contract'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { draftFixture } from './draftFixture'
import { resetImportStore, useImportStore } from './importStore'

let invoke: ReturnType<typeof vi.fn<(channel: string, input: unknown) => Promise<unknown>>>

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
  invoke = vi.fn(async (channel: string, _input: unknown) => {
    if (channel in overrides) {
      const value = overrides[channel]
      if (value instanceof Error) throw value
      return value
    }
    if (channel === 'tree:list') return treeFixture
    if (channel === 'import:open') return draftFixture()
    if (channel === 'import:commit') return { nodes: importedRows(), words: 9 }
    throw new Error(`unexpected ${channel}`)
  })
  const client: IpcClient = {
    invoke: <C extends Channel>(channel: C, input: Input<C>) =>
      invoke(channel, input) as Promise<Output<C>>,
    on: () => () => {}
  }
  setIpcClient(client)
}

const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

beforeEach(() => {
  install()
  resetImportStore()
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
    store.setExcluded('p1c2', true)
    store.setPlacement('p1c1', 'front')
    store.move('p2', -1)
    store.splitScene('p2c1s1', 1)
    const draft = useImportStore.getState().draft
    expect(draft?.parts.map((p) => p.id)).toEqual(['p2', 'p1'])
    expect(draft?.parts[0]?.chapters[0]?.title).toBe('The Return')
    expect(draft?.parts[0]?.chapters[0]?.scenes).toHaveLength(2)
    expect(draft?.parts[1]?.chapters[0]?.placement).toBe('front')
    expect(draft?.parts[1]?.chapters[1]?.excluded).toBe(true)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('ends an inline rename and clears the split pane when the scene is merged away', async () => {
    await useImportStore.getState().open()
    useImportStore.getState().startRename('p1')
    expect(useImportStore.getState().renamingId).toBe('p1')
    useImportStore.getState().rename('p1', 'Book One')
    expect(useImportStore.getState().renamingId).toBeNull()

    useImportStore.getState().selectScene('p1c1s2')
    useImportStore.getState().mergeScene('p1c1s2')
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
