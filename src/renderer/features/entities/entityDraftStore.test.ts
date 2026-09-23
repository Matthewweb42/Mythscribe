import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Entity, Input, Output } from '@shared/ipc/contract'
import { flushPendingSaves, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import {
  ENTITY_DRAFT_SAVE_DELAY_MS,
  resetEntityDraftStore,
  useEntityDraftStore
} from './entityDraftStore'
import { entityFixture } from './entityFixture'
import { resetEntityStore, useEntityStore } from './entityStore'

type Handler = (input: unknown) => unknown

/** `entity:update` answers like main does: the patch merged over the stored row, fields and all. */
function install(overrides: Partial<Record<Channel, Handler>> = {}): [Channel, unknown][] {
  const calls: [Channel, unknown][] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const override = overrides[channel]
      if (override) return override(input) as Output<C>
      if (channel === 'entity:list') return entityFixture as Output<C>
      if (channel === 'entity:delete') return null as Output<C>
      if (channel === 'entity:update') {
        const patch = input as Input<'entity:update'>
        const stored = useEntityStore.getState().byId[patch.id]
        if (!stored) throw new Error('unknown entity')
        const fields = { ...stored.fields }
        for (const [id, value] of Object.entries(patch.fields ?? {})) {
          if (typeof value !== 'string') continue
          if (value === '') delete fields[id as keyof typeof fields]
          else fields[id as keyof typeof fields] = value
        }
        const merged: Entity = {
          ...stored,
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.template === undefined ? {} : { template: patch.template }),
          ...(patch.body === undefined ? {} : { body: patch.body }),
          fields,
          modified: '2026-09-23T12:00:00.000Z'
        }
        return merged as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
  return calls
}

const failing =
  (message: string, code: 'ALREADY_EXISTS' | 'INTERNAL' = 'INTERNAL') =>
  (): never => {
    throw new IpcRequestError({ code, message })
  }

const draft = (): ReturnType<typeof useEntityDraftStore.getState> => useEntityDraftStore.getState()
const stored = (id: string): Entity => {
  const entity = useEntityStore.getState().byId[id]
  if (!entity) throw new Error(`no entity ${id}`)
  return entity
}
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)
const updates = (calls: [Channel, unknown][]): unknown[] =>
  calls.filter(([channel]) => channel === 'entity:update').map(([, input]) => input)

/** Runs the debounce out and lets the write that follows it settle. */
async function runDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(ENTITY_DRAFT_SAVE_DELAY_MS)
  await vi.advanceTimersByTimeAsync(0)
}

describe('entityDraftStore (F-9.3)', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    resetPendingSaves()
    resetEntityDraftStore()
    resetEntityStore()
    useDialogStore.setState({ modals: [], toasts: [] })
    install()
    await useEntityStore.getState().load()
  })
  afterEach(() => {
    resetEntityDraftStore()
    resetPendingSaves()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('opens from the stored row and writes nothing until an edit lands', async () => {
    const calls = install()
    draft().open(stored('e-mara'))
    expect(draft().draft).toEqual({
      id: 'e-mara',
      name: 'Mara',
      fields: { age: '27', appearance: 'Tall, with a scar across her left palm.' },
      body: ''
    })
    expect(draft().status).toBe('idle')
    await runDebounce()
    expect(updates(calls)).toEqual([])
  })

  it('a field edit is written after the debounce, and only the part that changed', async () => {
    const calls = install()
    draft().open(stored('e-mara'))
    draft().edit({ fields: { age: '3' } })
    draft().edit({ fields: { age: '31' } })
    expect(draft().status).toBe('dirty')
    await vi.advanceTimersByTimeAsync(ENTITY_DRAFT_SAVE_DELAY_MS - 1)
    expect(updates(calls)).toEqual([]) // one write per burst, not one per keystroke
    await runDebounce()
    expect(updates(calls)).toEqual([{ id: 'e-mara', fields: { age: '31' } }])
    expect(stored('e-mara').fields.age).toBe('31')
    expect(draft().status).toBe('saved')
  })

  it('an emptied field is sent as "" so main removes it, and the blank page as null', async () => {
    const calls = install()
    draft().open(stored('e-mara'))
    draft().edit({ fields: { appearance: '' } })
    await runDebounce()
    expect(updates(calls)).toEqual([{ id: 'e-mara', fields: { appearance: '' } }])
    expect(stored('e-mara').fields.appearance).toBeUndefined()

    draft().open(stored('e-aldous'))
    draft().edit({ body: '' })
    await runDebounce()
    expect(updates(calls).at(-1)).toEqual({ id: 'e-aldous', body: null })
  })

  it('a rename is trimmed, and a cleared name box is never sent', async () => {
    const calls = install()
    draft().open(stored('e-mara'))
    draft().edit({ name: '  Mara Vell ' })
    await runDebounce()
    expect(updates(calls)).toEqual([{ id: 'e-mara', name: 'Mara Vell' }])

    draft().edit({ name: '   ' })
    await runDebounce()
    expect(updates(calls)).toHaveLength(1)
    expect(stored('e-mara').name).toBe('Mara Vell')
  })

  it('a name clash toasts and puts the stored name back in the box', async () => {
    install({
      'entity:update': failing('A character named "Aldous" already exists', 'ALREADY_EXISTS')
    })
    draft().open(stored('e-mara'))
    draft().edit({ name: 'Aldous', fields: { age: '31' } })
    await runDebounce()
    expect(toasts()).toEqual(['A character named "Aldous" already exists'])
    expect(draft().draft?.name).toBe('Mara')
    expect(draft().draft?.fields.age).toBe('31') // the rest of the draft is kept
    expect(draft().status).toBe('dirty')
  })

  it('any other failure toasts and keeps the draft for the next attempt', async () => {
    install({ 'entity:update': failing('Database is locked') })
    draft().open(stored('e-mara'))
    draft().edit({ fields: { age: '31' } })
    await runDebounce()
    expect(toasts()).toEqual(['Database is locked'])
    expect(draft().draft?.fields.age).toBe('31')
    expect(draft().status).toBe('dirty')

    const calls = install()
    await draft().flush()
    expect(updates(calls)).toEqual([{ id: 'e-mara', fields: { age: '31' } }])
    expect(draft().status).toBe('saved')
  })

  it('flush writes at once and cancels the pending debounce', async () => {
    const calls = install()
    draft().open(stored('e-mara'))
    draft().edit({ fields: { goals: 'Find the cartographer.' } })
    await draft().flush()
    expect(updates(calls)).toEqual([{ id: 'e-mara', fields: { goals: 'Find the cartographer.' } }])
    await runDebounce()
    expect(updates(calls)).toHaveLength(1)
  })

  it('close writes the pending edit and empties the draft', async () => {
    const calls = install()
    draft().open(stored('e-mara'))
    draft().edit({ fields: { age: '31' } })
    draft().close()
    expect(draft().draft).toBeNull()
    expect(draft().status).toBe('idle')
    await vi.advanceTimersByTimeAsync(0)
    expect(updates(calls)).toEqual([{ id: 'e-mara', fields: { age: '31' } }])
    expect(stored('e-mara').fields.age).toBe('31')
  })

  it('opening another entity writes the one that was open', async () => {
    const calls = install()
    draft().open(stored('e-mara'))
    draft().edit({ fields: { age: '31' } })
    draft().open(stored('e-forest'))
    await vi.advanceTimersByTimeAsync(0)
    expect(updates(calls)).toEqual([{ id: 'e-mara', fields: { age: '31' } }])
    expect(draft().draft?.id).toBe('e-forest')
    expect(draft().status).toBe('idle')
  })

  it('the project close path flushes the open page through the pending-save registry', async () => {
    const calls = install()
    draft().open(stored('e-mara'))
    draft().edit({ body: 'Notes on the scar.' })
    await flushPendingSaves()
    expect(updates(calls)).toEqual([{ id: 'e-mara', body: 'Notes on the scar.' }])
    draft().close()
    await flushPendingSaves() // unregistered: nothing left to write
    expect(updates(calls)).toHaveLength(1)
  })

  it('an entity deleted under the open page writes nothing', async () => {
    const calls = install()
    draft().open(stored('e-mara'))
    draft().edit({ fields: { age: '31' } })
    await useEntityStore.getState().remove('e-mara')
    await runDebounce()
    expect(updates(calls)).toEqual([])
  })
})
