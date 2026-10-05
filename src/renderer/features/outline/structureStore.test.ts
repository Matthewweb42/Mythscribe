import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import type { ProjectStructure } from '@shared/structure'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetStructureStore, useStructureStore } from './structureStore'

interface PendingSet {
  value: ProjectStructure
  resolve: () => void
  reject: (err: Error) => void
}

let sets: PendingSet[] = []
let stored: ProjectStructure = { template: 'threeAct' }

/** `structure:get` answers with `stored`; `structure:set` resolves only when the test says so. */
function install(): void {
  sets = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'structure:get') return stored as Output<C>
      if (channel === 'structure:set') {
        const value = input as Input<'structure:set'>
        return new Promise<Output<C>>((resolve, reject) => {
          sets.push({ value, resolve: () => resolve(value as Output<C>), reject })
        })
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
}

const store = (): ReturnType<typeof useStructureStore.getState> => useStructureStore.getState()
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

beforeEach(() => {
  resetStructureStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  stored = { template: 'threeAct' }
  install()
})
afterEach(() => {
  resetStructureStore()
  setIpcClient(null)
})

describe('useStructureStore (F-11.1b)', () => {
  it('loads the stored template and clears back to none', async () => {
    expect(store()).toMatchObject({ template: null, loaded: false })
    await store().load()
    expect(store()).toMatchObject({ template: 'threeAct', loaded: true })
    store().clear()
    expect(store()).toMatchObject({ template: null, loaded: false })
  })

  it('applies a new template at once and writes it at once', async () => {
    await store().load()
    const done = store().setTemplate('saveTheCat')
    expect(store().template).toBe('saveTheCat')
    expect(sets.map((s) => s.value)).toEqual([{ template: 'saveTheCat' }])
    sets[0]?.resolve()
    await done
    expect(store().template).toBe('saveTheCat')
    expect(toasts()).toEqual([])
  })

  it('writes nothing for the same template or before the load', async () => {
    await store().setTemplate('saveTheCat')
    expect(store().template).toBeNull()
    await store().load()
    await store().setTemplate('threeAct')
    expect(sets).toHaveLength(0)
  })

  it('reverts and toasts when the write fails', async () => {
    await store().load()
    const done = store().setTemplate(null)
    expect(store().template).toBeNull()
    sets[0]?.reject(new Error('Database is locked'))
    await done
    expect(store().template).toBe('threeAct')
    expect(toasts()).toHaveLength(1)
  })

  it('drops a failed write once the project has closed', async () => {
    await store().load()
    const done = store().setTemplate('herosJourney')
    store().clear()
    sets[0]?.reject(new Error('gone'))
    await done
    expect(store()).toMatchObject({ template: null, loaded: false })
    expect(toasts()).toEqual([])
  })

  it('drops a load answered after the project closed', async () => {
    const loading = store().load()
    store().clear()
    await loading
    expect(store()).toMatchObject({ template: null, loaded: false })
  })
})
