import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUILTIN_COMPILE_FORMATS, DEFAULT_COMPILE_FORMAT_ID } from '@shared/compileFormat'
import { resetDocumentStore } from '@renderer/features/editor/documentStore'
import { resetNotesStore } from '@renderer/features/editor/notesStore'
import { resetSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { callsTo, installFakeCompileMain, type FakeCompileMain } from './compileTestIpc'
import { resetCompileWindowStore, useCompileWindowStore } from './compileWindowStore'

let fake: FakeCompileMain
const store = () => useCompileWindowStore.getState()
const toasts = () => useDialogStore.getState().toasts.map((t) => `${t.kind}: ${t.message}`)
/** Lets the queued compile state writes land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function reset(): void {
  resetCompileWindowStore()
  resetDocumentStore()
  resetSceneMetaStore()
  resetNotesStore()
  useDialogStore.setState({ modals: [], toasts: [] })
}

beforeEach(() => {
  reset()
  fake = installFakeCompileMain()
})
afterEach(() => {
  reset()
  setIpcClient(null)
})

describe('useCompileWindowStore (F-12.4 compile window)', () => {
  it('loads the stored state once and resolves its format', async () => {
    const mine = { ...structuredClone(BUILTIN_COMPILE_FORMATS[1]!), id: 'user:a', name: 'Mine' }
    fake.library = [mine]
    fake.state = {
      formatId: 'user:a',
      output: 'pdf',
      scope: { kind: 'chapters', ids: ['ch-1'] },
      excluded: ['sc-9']
    }
    await Promise.all([store().ensureState(), store().ensureState()])
    expect(callsTo(fake, 'compileState:get')).toHaveLength(1)
    expect(store()).toMatchObject({
      stateLoaded: true,
      formatId: 'user:a',
      output: 'pdf',
      scopeKind: 'chapters',
      chapterIds: ['ch-1'],
      excluded: ['sc-9'],
      dirty: false
    })
    expect(store().draft.name).toBe('Mine')
  })

  it('falls back to the default format when the stored one is gone', async () => {
    fake.state = { ...fake.state, formatId: 'user:gone' }
    await store().open()
    expect(store().formatId).toBe(DEFAULT_COMPILE_FORMAT_ID)
    expect(store().ready).toBe(true)
    expect(store().source?.manuscript).toHaveLength(2)
  })

  it('writes every choice through to the project, in order', async () => {
    await store().ensureState()
    store().selectFormat('builtin:ebook')
    store().setOutput('html')
    store().setScopeKind('chapters')
    store().toggleChapter('ch-2', true)
    store().setIncluded('sc-1', false)
    await settle()
    expect(fake.state).toEqual({
      formatId: 'builtin:ebook',
      output: 'html',
      scope: { kind: 'chapters', ids: ['ch-2'] },
      excluded: ['sc-1']
    })
    store().setIncluded('sc-1', true)
    store().toggleChapter('ch-2', false)
    await settle()
    // A chapters pick with nothing ticked is stored as the whole manuscript.
    expect(fake.state.scope).toEqual({ kind: 'manuscript' })
    expect(fake.state.excluded).toEqual([])
    // Choosing a format goes back to its own default output.
    store().selectFormat('builtin:paperback-6x9')
    expect(store().output).toBeNull()
  })

  it('keeps built-ins read-only and copies what is shown into My formats', async () => {
    await store().ensureState()
    store().edit((f) => ({ ...f, name: 'Changed' }))
    expect(store().dirty).toBe(false)
    const created = await store().duplicate()
    expect(created.name).toBe('Standard Manuscript copy')
    expect(store().formatId).toBe(created.id)
    expect(store().library.map((f) => f.name)).toEqual(['Standard Manuscript copy'])

    store().edit((f) => ({ ...f, typography: { ...f.typography, size: 13 } }))
    expect(store().dirty).toBe(true)
    // A copy of an edited format carries the edits; the original keeps its stored settings.
    const second = await store().duplicate('Bigger')
    expect(fake.library.find((f) => f.id === second.id)?.typography.size).toBe(13)
    expect(fake.library.find((f) => f.id === created.id)?.typography.size).toBe(12)
    expect(store().dirty).toBe(false)
  })

  it('saves, reverts, renames, and deletes a library format', async () => {
    await store().ensureState()
    const created = await store().duplicate()
    store().edit((f) => ({ ...f, sceneSeparator: { kind: 'blankLine' } }))
    await store().save()
    expect(store().dirty).toBe(false)
    expect(fake.library[0]?.sceneSeparator).toEqual({ kind: 'blankLine' })

    store().edit((f) => ({ ...f, sceneSeparator: { kind: 'pageBreak' } }))
    store().revert()
    expect(store().draft.sceneSeparator).toEqual({ kind: 'blankLine' })

    store().edit((f) => ({ ...f, sceneSeparator: { kind: 'pageBreak' } }))
    await store().rename('Agent copy')
    // The rename stores the name only; the unsaved edit stays unsaved.
    expect(fake.library[0]).toMatchObject({
      name: 'Agent copy',
      sceneSeparator: { kind: 'blankLine' }
    })
    expect(store().draft).toMatchObject({
      name: 'Agent copy',
      sceneSeparator: { kind: 'pageBreak' }
    })

    await store().remove()
    expect(fake.library).toEqual([])
    expect(store().library).toEqual([])
    expect(store().formatId).toBe(DEFAULT_COMPILE_FORMAT_ID)
    expect(callsTo(fake, 'compileFormat:delete')).toEqual([{ id: created.id }])
  })

  it('compiles the shown format after the include ticks are stored, and toasts the file', async () => {
    await store().open()
    store().setIncluded('sc-2', false)
    expect(await store().compile({ kind: 'manuscript' })).toBe(true)
    const writes = fake.calls.map((c) => c.channel)
    expect(writes.lastIndexOf('compileState:set')).toBeLessThan(writes.indexOf('compile:run'))
    expect(callsTo(fake, 'compile:run')[0]).toMatchObject({
      format: { id: DEFAULT_COMPILE_FORMAT_ID },
      output: 'docx',
      scope: { kind: 'manuscript' }
    })
    expect(toasts()).toEqual(['success: Compiled to /books/Book.docx'])
    expect(store().status).toBe('idle')

    fake.runPath = null
    expect(await store().compile({ kind: 'manuscript' })).toBe(false)
    expect(toasts()).toHaveLength(1)
  })

  it('keeps a failed compile for the window and clears everything with the project', async () => {
    await store().open()
    setIpcClient({
      invoke: () => Promise.reject(new Error('VALIDATION: Nothing to export.')),
      on: () => () => {}
    })
    expect(await store().compile({ kind: 'manuscript' })).toBe(false)
    expect(store()).toMatchObject({ status: 'error', error: 'VALIDATION: Nothing to export.' })
    store().clear()
    expect(store()).toMatchObject({
      status: 'idle',
      stateLoaded: false,
      ready: false,
      excluded: []
    })
  })
})
