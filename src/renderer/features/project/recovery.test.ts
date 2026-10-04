import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, EventName, Input, Output } from '@shared/ipc/contract'
import type { RecoveryItem } from '@shared/recovery'
import type { TiptapNodeT } from '@shared/tiptap'
import { resetDocumentStore, useDocumentStore } from '@renderer/features/editor/documentStore'
import { resetNotesStore } from '@renderer/features/editor/notesStore'
import { resetGoalsStore } from '@renderer/features/goals/goalsStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetPendingSaves } from './pendingSaves'
import { describeRecoveryItems, offerRecovery } from './recovery'

const para = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

const ITEMS: RecoveryItem[] = [
  { kind: 'document', id: 'sc-2', title: 'Scene 2' },
  { kind: 'notes', id: 'ch-2', title: 'Chapter 2' }
]

let stored: Record<string, TiptapNodeT | null>
let listed: RecoveryItem[]

function install(): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async (channel: string, input: unknown) => {
    if (channel === 'recovery:list') return listed
    if (channel === 'recovery:restore') {
      stored['sc-2'] = para('Lost words here.')
      return [
        { kind: 'document', id: 'sc-2', wordCount: 3 },
        { kind: 'notes', id: 'ch-2', wordCount: null }
      ]
    }
    if (channel === 'document:get') {
      const { id } = input as { id: string }
      return { id, content: stored[id] ?? null }
    }
    return null
  })
  const client: IpcClient = {
    invoke: <C extends Channel>(channel: C, value: Input<C>) =>
      invoke(channel, value) as Promise<Output<C>>,
    on:
      <E extends EventName>(_event: E) =>
      () =>
        undefined
  }
  setIpcClient(client)
  return invoke
}

/** Answers the confirm dialog that is open now. */
async function answer(ok: boolean): Promise<string> {
  await vi.waitFor(() => expect(useDialogStore.getState().modals).toHaveLength(1))
  const modal = useDialogStore.getState().modals[0]
  if (modal?.kind !== 'confirm') throw new Error('expected a confirm dialog')
  useDialogStore.getState().resolveConfirm(modal.id, ok)
  return `${modal.options.title} ${modal.options.message}`
}

const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

beforeEach(() => {
  resetDocumentStore()
  resetNotesStore()
  resetGoalsStore()
  resetPendingSaves()
  useTreeStore.getState().clear()
  useDialogStore.setState({ modals: [], toasts: [] })
  stored = {}
  listed = ITEMS
})
afterEach(() => {
  resetDocumentStore()
  resetNotesStore()
  useTreeStore.getState().clear()
  setIpcClient(null)
})

describe('describeRecoveryItems', () => {
  it('names up to five records, then counts the rest', () => {
    expect(describeRecoveryItems(ITEMS)).toBe('"Scene 2" (text), "Chapter 2" (notes)')
    const many = Array.from({ length: 7 }, (_, i) => ({
      kind: 'document' as const,
      id: `s${i}`,
      title: i === 0 ? '' : `S${i}`
    }))
    expect(describeRecoveryItems(many)).toBe(
      '"Untitled" (text), "S1" (text), "S2" (text), "S3" (text), "S4" (text) and 2 more'
    )
  })
})

describe('offerRecovery (F-8.3)', () => {
  it('does nothing when the journal is empty', async () => {
    listed = []
    const invoke = install()
    await offerRecovery()
    expect(useDialogStore.getState().modals).toEqual([])
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('recovers: restores, merges word counts, reloads open editors, and confirms', async () => {
    const invoke = install()
    useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
    stored['sc-2'] = para('Old.')
    await useDocumentStore.getState().load('sc-2')
    const offering = offerRecovery()
    expect(await answer(true)).toBe(
      'Recover unsaved changes? MythScribe closed before these changes were saved: "Scene 2" (text), "Chapter 2" (notes).'
    )
    await offering
    expect(invoke).toHaveBeenCalledWith('recovery:restore', undefined)
    expect(useTreeStore.getState().byId['sc-2']?.wordCount).toBe(3)
    expect(useDocumentStore.getState().docs['sc-2']?.content).toEqual(para('Lost words here.'))
    expect(toasts()).toEqual(['Recovered 2 unsaved changes.'])
  })

  it('discards only after the second confirmation, and keeps the journal otherwise', async () => {
    const invoke = install()
    let offering = offerRecovery()
    await answer(false)
    expect(await answer(false)).toBe(
      'Discard unsaved changes? They cannot be recovered afterwards.'
    )
    await offering
    expect(invoke).not.toHaveBeenCalledWith('recovery:discard', undefined)
    expect(invoke).not.toHaveBeenCalledWith('recovery:restore', undefined)

    offering = offerRecovery()
    await answer(false)
    await answer(true)
    await offering
    expect(invoke).toHaveBeenCalledWith('recovery:discard', undefined)
  })

  it('toasts the cause when the journal cannot be read', async () => {
    const invoke = install()
    invoke.mockImplementation(async () => {
      throw new Error('disk gone')
    })
    await offerRecovery()
    expect(toasts()).toEqual(['disk gone'])
  })
})
