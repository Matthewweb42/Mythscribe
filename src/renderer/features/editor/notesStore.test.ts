import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'
import { flushPendingSaves, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetDocumentStore } from './documentStore'
import { AUTOSAVE_DELAY_MS, resetNotesStore, useNotesStore } from './notesStore'

const para = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

interface PendingGet {
  id: string
  resolve: (notes: TiptapNodeT | null) => void
  reject: (err: Error) => void
}

interface PendingSave {
  id: string
  notes: TiptapNodeT
  resolve: () => void
  reject: (err: Error) => void
}

/** A client whose `notes:get` and `notes:save` calls resolve only when the test says so; anything else is a failure. */
function deferredClient(): { client: IpcClient; gets: PendingGet[]; saves: PendingSave[] } {
  const gets: PendingGet[] = []
  const saves: PendingSave[] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'notes:get') {
        const { id } = input as Input<'notes:get'>
        return new Promise<Output<C>>((resolve, reject) => {
          gets.push({ id, resolve: (notes) => resolve({ id, notes } as Output<C>), reject })
        })
      }
      if (channel === 'notes:save') {
        const { id, notes } = input as Input<'notes:save'>
        return new Promise<Output<C>>((resolve, reject) => {
          saves.push({ id, notes, resolve: () => resolve({ modified: 'm' } as Output<C>), reject })
        })
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  return { client, gets, saves }
}

let gets: PendingGet[]
let saves: PendingSave[]

async function loaded(id: string, notes: TiptapNodeT | null = para('Stored')): Promise<void> {
  const loading = useNotesStore.getState().load(id)
  gets[gets.length - 1]?.resolve(notes)
  await loading
}

const store = (): ReturnType<typeof useNotesStore.getState> => useNotesStore.getState()
const record = (id: string): { content: TiptapNodeT | null; dirty: boolean } | undefined =>
  store().docs[id]
const edit = (id: string, text: string): void => store().edit(id, para(text))

const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

beforeEach(() => {
  vi.useFakeTimers()
  resetNotesStore()
  resetDocumentStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  const deferred = deferredClient()
  gets = deferred.gets
  saves = deferred.saves
  setIpcClient(deferred.client)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('useNotesStore (F-3.7)', () => {
  it('loads through notes:get, with never-written notes as the empty document', async () => {
    const loading = store().load('ch-1')
    expect(record('ch-1')).toEqual({ content: null, dirty: false })
    expect(gets.map((g) => g.id)).toEqual(['ch-1'])
    gets[0]?.resolve(null)
    await loading
    expect(record('ch-1')).toEqual({ content: EMPTY_DOC, dirty: false })
    await loaded('sc-1', para('Ends on the cliff'))
    expect(record('sc-1')).toEqual({ content: para('Ends on the cliff'), dirty: false })
  })

  it('propagates a failed load', async () => {
    const loading = store().load('sc-1')
    gets[0]?.reject(new Error('Stored notes are not valid JSON'))
    await expect(loading).rejects.toThrow('Stored notes are not valid JSON')
  })

  it('edit marks dirty and writes the latest notes through notes:save after the debounce', async () => {
    await loaded('sc-1')
    edit('sc-1', 'a')
    edit('sc-1', 'ab')
    expect(record('sc-1')).toEqual({ content: para('ab'), dirty: true })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1)
    expect(saves).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(saves.map((s) => [s.id, s.notes])).toEqual([['sc-1', para('ab')]])
    saves[0]?.resolve()
    await settle()
    expect(record('sc-1')).toEqual({ content: para('ab'), dirty: false })
  })

  it('saveNow (Ctrl+S) writes at once and a failure toasts and keeps the notes dirty', async () => {
    await loaded('sc-1')
    edit('sc-1', 'now')
    const saving = store().saveNow()
    expect(saves.map((s) => s.notes)).toEqual([para('now')])
    saves[0]?.reject(new Error('Database is locked'))
    await saving
    expect(toasts()).toEqual(['Database is locked'])
    expect(record('sc-1')?.dirty).toBe(true)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(saves).toHaveLength(1)
  })

  it('unload writes the pending edit at once and forgets the record', async () => {
    await loaded('sc-1')
    edit('sc-1', 'unsaved')
    store().unload('sc-1')
    expect(saves.map((s) => [s.id, s.notes])).toEqual([['sc-1', para('unsaved')]])
    expect(store().docs).toEqual({})
    saves[0]?.resolve()
    await settle()
    expect(toasts()).toEqual([])
  })

  it('flushPendingSaves writes pending notes once a record has loaded and no longer after clear()', async () => {
    await flushPendingSaves()
    expect(saves).toHaveLength(0)
    await loaded('ch-1')
    edit('ch-1', 'pending')
    const flushing = flushPendingSaves()
    expect(saves.map((s) => [s.id, s.notes])).toEqual([['ch-1', para('pending')]])
    saves[0]?.resolve()
    await flushing
    expect(record('ch-1')?.dirty).toBe(false)
    store().clear()
    expect(store().docs).toEqual({})
    await flushPendingSaves()
    expect(saves).toHaveLength(1)
  })
})
