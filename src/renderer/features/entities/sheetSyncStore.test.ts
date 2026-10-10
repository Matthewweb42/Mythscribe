import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import type { SheetSyncStatus } from '@shared/sheetSync'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetEntityDraftStore } from './entityDraftStore'
import { entityFixture } from './entityFixture'
import { resetEntityStore, useEntityStore } from './entityStore'
import { resetSheetSyncStore, useSheetSyncStore } from './sheetSyncStore'

const WAITING: SheetSyncStatus = { entityId: 'e-mara', phase: 'waiting', failure: null }

let push: ((list: SheetSyncStatus[]) => void) | null = null

function install(): [Channel, unknown][] {
  const calls: [Channel, unknown][] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      if (channel === 'entity:list') return entityFixture as Output<C>
      if (channel === 'sheetSync:status') return [WAITING] as Output<C>
      if (channel === 'sheetSync:run') return true as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: (event, listener) => {
      if (event === 'sheetSync:changed') {
        push = (list) => (listener as (payload: SheetSyncStatus[]) => void)(list)
      }
      return () => {
        push = null
      }
    }
  }
  setIpcClient(client)
  return calls
}

describe('sheetSyncStore (F-9.18)', () => {
  beforeEach(() => {
    resetSheetSyncStore()
    resetEntityStore()
    resetEntityDraftStore()
  })
  afterEach(() => {
    resetSheetSyncStore()
    resetEntityDraftStore()
  })

  it('loads the statuses and follows the event that carries the whole list', async () => {
    install()
    await useSheetSyncStore.getState().load()
    expect(useSheetSyncStore.getState().byId).toEqual({ 'e-mara': WAITING })
    push?.([])
    expect(useSheetSyncStore.getState().byId).toEqual({})
    useSheetSyncStore.getState().clear()
    expect(push).toBeNull()
  })

  it('runs a sheet now', async () => {
    const calls = install()
    await useEntityStore.getState().load()
    expect(await useSheetSyncStore.getState().run('e-mara')).toBe(true)
    expect(calls).toContainEqual(['sheetSync:run', { id: 'e-mara' }])
  })
})
