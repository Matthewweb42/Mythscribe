import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import type {
  ReplaceCommitRequest,
  ReplaceCommitResult,
  ReplacePreview,
  ReplaceUndoResult
} from '@shared/replace'
import type { TiptapNodeT } from '@shared/tiptap'
import { resetDocumentStore, useDocumentStore } from '@renderer/features/editor/documentStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { registerPendingSave, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { REPLACE_DEBOUNCE_MS, resetReplaceStore, useReplaceStore } from './replaceStore'

const state = (): ReturnType<typeof useReplaceStore.getState> => useReplaceStore.getState()

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

const item = (id: string, count = 1): ReplacePreview['items'][number] => ({
  id,
  title: id,
  location: 'Chapter 1',
  count,
  samples: [
    {
      before: { text: 'A lantern.', range: [2, 9] },
      after: { text: 'A lamp.', range: [2, 6] }
    }
  ]
})

const previewOf = (...ids: string[]): ReplacePreview => ({
  items: ids.map((id) => item(id)),
  total: ids.length,
  truncated: false
})

/** Everything that reached main or the pending-save registry, in order. */
let log: string[]
let previews: Input<'replace:preview'>[]
let commits: ReplaceCommitRequest[]
/** One resolver per preview request, in order, so a test decides which answer lands first. */
let pendingPreviews: ((answer: ReplacePreview | Error) => void)[]
let commitAnswer: ReplaceCommitResult | Error
let undoAnswer: ReplaceUndoResult | Error
/** What `document:get` answers per id. */
let stored: Record<string, TiptapNodeT>
let saves: Input<'document:save'>[]

function install(): void {
  const client: IpcClient = {
    invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      log.push(channel)
      if (channel === 'replace:preview') {
        previews.push(input as Input<'replace:preview'>)
        return new Promise<Output<C>>((resolve, reject) => {
          pendingPreviews.push((answer) => {
            if (answer instanceof Error) reject(answer)
            else resolve(answer as Output<C>)
          })
        })
      }
      if (channel === 'replace:commit') {
        commits.push(input as ReplaceCommitRequest)
        return commitAnswer instanceof Error
          ? Promise.reject(commitAnswer)
          : Promise.resolve(commitAnswer as Output<C>)
      }
      if (channel === 'replace:undo') {
        return undoAnswer instanceof Error
          ? Promise.reject(undoAnswer)
          : Promise.resolve(undoAnswer as Output<C>)
      }
      if (channel === 'document:get') {
        const { id } = input as Input<'document:get'>
        return Promise.resolve({ id, content: stored[id] ?? null } as Output<C>)
      }
      if (channel === 'document:save') {
        saves.push(input as Input<'document:save'>)
        return Promise.resolve({ wordCount: 1, modified: 'm' } as Output<C>)
      }
      return Promise.reject(new Error(`unexpected ${channel}`))
    },
    on: () => () => {}
  }
  setIpcClient(client)
}

const rest = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(REPLACE_DEBOUNCE_MS)
}
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

/** Answers the oldest unanswered preview request. */
async function answer(response: ReplacePreview | Error): Promise<void> {
  const resolve = pendingPreviews.shift()
  if (!resolve) throw new Error('no preview is waiting')
  resolve(response)
  await settle()
}

/** The dialog open on an answered preview of `ids` for lantern → lamp. */
async function previewed(...ids: string[]): Promise<void> {
  state().openReplace()
  state().setQuery('lantern')
  state().setReplacement('lamp')
  await rest()
  await answer(previewOf(...ids))
  log.length = 0
}

const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

beforeEach(() => {
  vi.useFakeTimers()
  resetReplaceStore()
  resetDocumentStore()
  resetPendingSaves()
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true, selectedId: null })
  useDialogStore.setState({ modals: [], toasts: [] })
  log = []
  previews = []
  commits = []
  pendingPreviews = []
  saves = []
  stored = {}
  commitAnswer = { changed: [], total: 0 }
  undoAnswer = { restored: [], skipped: [] }
  registerPendingSave(async () => {
    log.push('flush')
  })
  install()
})
afterEach(() => {
  // A debounce left pending by a file's last test would fire into the next file's IPC fake.
  resetReplaceStore()
  resetDocumentStore()
  resetPendingSaves()
  useTreeStore.getState().clear()
  setIpcClient(null)
  vi.useRealTimers()
})

describe('replaceStore (F-10.2): the dialog', () => {
  it('starts closed and idle; opening with nothing selected offers no scope', () => {
    expect(state()).toMatchObject({
      open: false,
      query: '',
      replacement: '',
      matchCase: false,
      wholeWord: false,
      scope: 'all',
      scopeNode: null,
      preview: null,
      status: 'idle',
      undoable: null
    })
    state().openReplace()
    expect(state()).toMatchObject({ open: true, scopeNode: null, status: 'idle' })
    expect(previews).toEqual([])
  })

  it('captures the tree selection as the scope it can narrow to, and takes a query to start from', async () => {
    useTreeStore.setState({ selectedId: 'ch-1' })
    state().openReplace('storm')
    expect(state()).toMatchObject({
      open: true,
      query: 'storm',
      scope: 'all',
      scopeNode: { id: 'ch-1', title: useTreeStore.getState().byId['ch-1']?.title }
    })
    await settle()
    expect(previews).toEqual([
      { query: 'storm', replacement: '', matchCase: false, wholeWord: false, scopeId: null }
    ])
    await answer(previewOf('sc-1'))
    state().setScope('selection')
    await settle()
    expect(previews[1]?.scopeId).toBe('ch-1')
    await answer(previewOf('sc-1'))
    // Reopened on another selection, "this and everything in it" no longer means the same thing.
    state().close()
    useTreeStore.setState({ selectedId: 'sc-2' })
    state().openReplace()
    expect(state()).toMatchObject({ scope: 'all', scopeNode: { id: 'sc-2' } })
  })

  it('a second arrival of the open action changes nothing', async () => {
    await previewed('sc-1')
    state().openReplace()
    state().openReplace('')
    await settle()
    expect(log).toEqual([])
    expect(state().preview).toEqual(previewOf('sc-1'))
  })

  it('close keeps the fields; reset forgets everything and drops a pending answer', async () => {
    await previewed('sc-1')
    state().close()
    expect(state()).toMatchObject({ open: false, query: 'lantern', replacement: 'lamp' })
    state().setQuery('storm')
    await rest()
    state().reset()
    await answer(previewOf('sc-9'))
    expect(state()).toMatchObject({ open: false, query: '', preview: null, status: 'idle' })
  })
})

describe('replaceStore (F-10.2): the preview', () => {
  it('debounces typing, flushes the pending saves, then asks main', async () => {
    state().openReplace()
    state().setQuery('lan')
    state().setQuery('lantern')
    expect(state().status).toBe('searching')
    expect(log).toEqual([])
    await rest()
    expect(log).toEqual(['flush', 'replace:preview'])
    expect(previews).toEqual([
      { query: 'lantern', replacement: '', matchCase: false, wholeWord: false, scopeId: null }
    ])
    await answer(previewOf('sc-1', 'sc-2'))
    expect(state()).toMatchObject({
      status: 'done',
      preview: previewOf('sc-1', 'sc-2'),
      answered: previews[0]
    })
  })

  it('asks nothing for an empty query and keeps whitespace as typed', async () => {
    state().openReplace()
    state().setReplacement('lamp')
    await rest()
    expect(previews).toEqual([])
    expect(state().status).toBe('idle')
    state().setQuery('  ')
    await rest()
    expect(previews[0]?.query).toBe('  ')
  })

  it('asks at once when an option changes', async () => {
    await previewed('sc-1')
    state().setMatchCase(true)
    expect(state().preview).toBeNull()
    await settle()
    expect(previews[previews.length - 1]).toMatchObject({ matchCase: true, wholeWord: false })
    await answer(previewOf('sc-1'))
    state().setWholeWord(true)
    await settle()
    expect(previews[previews.length - 1]).toMatchObject({ matchCase: true, wholeWord: true })
  })

  it('drops an answer a newer request overtook', async () => {
    state().openReplace()
    state().setQuery('lantern')
    await rest()
    state().setQuery('storm')
    await rest()
    expect(previews.map((each) => each.query)).toEqual(['lantern', 'storm'])
    const [first, second] = pendingPreviews.splice(0)
    second?.(previewOf('storm-doc'))
    await settle()
    first?.(previewOf('lantern-doc'))
    await settle()
    expect(state().preview).toEqual(previewOf('storm-doc'))
    expect(state().answered?.query).toBe('storm')
  })

  it('has nothing to commit while a newer preview is on its way', async () => {
    await previewed('sc-1')
    state().setReplacement('torch')
    expect(state()).toMatchObject({ preview: null, answered: null, status: 'searching' })
    expect(await state().commit()).toBeNull()
    expect(commits).toEqual([])
  })

  it('reports a failed preview', async () => {
    state().openReplace()
    state().setQuery('lantern')
    await rest()
    await answer(new Error('Scope not found'))
    expect(state()).toMatchObject({ status: 'error', error: 'Scope not found', preview: null })
  })

  it('keeps a document unticked across previews while it is still listed', async () => {
    await previewed('sc-1', 'sc-2', 'sc-3')
    state().toggleDocument('sc-2')
    state().toggleDocument('sc-3')
    state().toggleDocument('sc-3')
    expect(state().excluded).toEqual(['sc-2'])
    state().setReplacement('torch')
    await rest()
    await answer(previewOf('sc-1', 'sc-2'))
    expect(state().excluded).toEqual(['sc-2'])
    state().setReplacement('lamp')
    await rest()
    await answer(previewOf('sc-1'))
    expect(state().excluded).toEqual([])
  })
})

describe('replaceStore (F-10.2): commit and undo', () => {
  it('flushes the pending saves, then commits the previewed request for the ticked documents', async () => {
    await previewed('sc-1', 'sc-2', 'sc-3')
    state().toggleDocument('sc-2')
    commitAnswer = {
      changed: [
        { id: 'sc-1', count: 2, wordCount: 11 },
        { id: 'sc-3', count: 1, wordCount: 7 }
      ],
      total: 3
    }
    const committing = state().commit()
    expect(state().busy).toBe(true)
    await settle()
    expect(await committing).toEqual(commitAnswer)
    expect(log.slice(0, 2)).toEqual(['flush', 'replace:commit'])
    expect(commits).toEqual([
      {
        query: 'lantern',
        replacement: 'lamp',
        matchCase: false,
        wholeWord: false,
        scopeId: null,
        ids: ['sc-1', 'sc-3']
      }
    ])
    expect(state()).toMatchObject({ busy: false, undoable: { total: 3, documents: 2 } })
    expect(toasts()).toEqual(['Replaced 3 occurrences in 2 documents.'])
    // The tree's cached counts follow main's answer without a reload.
    expect(useTreeStore.getState().byId['sc-1']?.wordCount).toBe(11)
    expect(useTreeStore.getState().byId['sc-3']?.wordCount).toBe(7)
    // And what is left to replace is asked again.
    expect(log).toContain('replace:preview')
  })

  it('reads the changed documents that are loaded again, and only those', async () => {
    stored = { 'sc-1': doc('A lantern.'), 'sc-2': doc('A lantern.') }
    await useDocumentStore.getState().load('sc-1')
    await previewed('sc-1', 'sc-2')
    stored = { 'sc-1': doc('A lamp.'), 'sc-2': doc('A lamp.') }
    commitAnswer = {
      changed: [
        { id: 'sc-1', count: 1, wordCount: 2 },
        { id: 'sc-2', count: 1, wordCount: 2 }
      ],
      total: 2
    }
    await state().commit()
    expect(log.filter((channel) => channel === 'document:get')).toHaveLength(1)
    expect(useDocumentStore.getState().docs).toEqual({
      'sc-1': { content: doc('A lamp.'), dirty: false }
    })
  })

  it('commits nothing with every document unticked', async () => {
    await previewed('sc-1')
    state().toggleDocument('sc-1')
    expect(await state().commit()).toBeNull()
    expect(log).toEqual([])
  })

  it('toasts a failed commit, offers no undo, and asks for the preview again', async () => {
    await previewed('sc-1')
    commitAnswer = new Error('database is locked')
    expect(await state().commit()).toBeNull()
    expect(toasts()).toEqual(['database is locked'])
    expect(state()).toMatchObject({ busy: false, undoable: null })
    await settle()
    expect(log[log.length - 1]).toBe('replace:preview')
  })

  it('does not write when the flush before it fails', async () => {
    await previewed('sc-1')
    registerPendingSave(() => Promise.reject(new Error('disk full')))
    expect(await state().commit()).toBeNull()
    expect(commits).toEqual([])
    expect(toasts()).toEqual(['disk full'])
  })

  it('says so when the text had changed and nothing was replaced', async () => {
    await previewed('sc-1')
    await state().commit()
    expect(toasts()).toEqual(['Nothing was replaced: the text had changed since the preview.'])
    expect(state().undoable).toBeNull()
  })

  it('undo flushes, restores, reads the loaded documents again, and is spent', async () => {
    stored = { 'sc-1': doc('A lantern.') }
    await useDocumentStore.getState().load('sc-1')
    await previewed('sc-1', 'sc-2')
    commitAnswer = {
      changed: [
        { id: 'sc-1', count: 1, wordCount: 2 },
        { id: 'sc-2', count: 1, wordCount: 2 }
      ],
      total: 2
    }
    stored = { 'sc-1': doc('A lamp.') }
    await state().commit()
    await settle()
    log.length = 0
    useDialogStore.setState({ toasts: [] })

    stored = { 'sc-1': doc('A lantern.') }
    undoAnswer = { restored: [{ id: 'sc-1', wordCount: 5 }], skipped: ['sc-2'] }
    expect(await state().undo()).toEqual(undoAnswer)
    expect(log.slice(0, 3)).toEqual(['flush', 'replace:undo', 'document:get'])
    expect(useDocumentStore.getState().docs['sc-1']).toEqual({
      content: doc('A lantern.'),
      dirty: false
    })
    expect(useTreeStore.getState().byId['sc-1']?.wordCount).toBe(5)
    expect(state().undoable).toBeNull()
    expect(toasts()).toEqual([
      'Restored 1 document. 1 document changed since the replace and was left as it is.'
    ])
    // Spent: a second undo asks nothing.
    log.length = 0
    expect(await state().undo()).toBeNull()
    expect(log).not.toContain('replace:undo')
  })

  it('keeps the undo on offer when it fails', async () => {
    await previewed('sc-1')
    commitAnswer = { changed: [{ id: 'sc-1', count: 1, wordCount: 2 }], total: 1 }
    await state().commit()
    useDialogStore.setState({ toasts: [] })
    undoAnswer = new Error('database is locked')
    expect(await state().undo()).toBeNull()
    expect(toasts()).toEqual(['database is locked'])
    expect(state().undoable).toEqual({ total: 1, documents: 1 })
  })

  it('forgets the undo with the project', async () => {
    await previewed('sc-1')
    commitAnswer = { changed: [{ id: 'sc-1', count: 1, wordCount: 2 }], total: 1 }
    await state().commit()
    state().reset()
    expect(state().undoable).toBeNull()
  })
})
