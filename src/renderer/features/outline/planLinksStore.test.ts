import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, EventPayload, Input, Output } from '@shared/ipc/contract'
import { EMPTY_SCENE_META } from '@shared/sceneMeta'
import { resetSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetPlanLinksStore, usePlanLinksStore } from './planLinksStore'

let calls: [Channel, unknown][] = []
let onChanged: ((payload: EventPayload<'planLinks:changed'>) => void) | null = null
let run: Output<'planLinks:run'>

const SUGGESTION = {
  plan: { kind: 'scene' as const, nodeId: 'sc-5' },
  sceneId: 'sc-6',
  reason: 'Same beat.'
}

beforeEach(() => {
  resetPendingSaves()
  resetSceneMetaStore()
  resetPlanLinksStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  calls = []
  onChanged = null
  run = { suggested: 1, applied: 0, changedNodeIds: [], requested: true, costUsd: 0.0001 }
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      if (channel === 'planLinks:get') {
        return { suggestions: [SUGGESTION], aiApplied: [] } as Output<C>
      }
      if (channel === 'planLinks:run') return run as Output<C>
      if (channel === 'sceneMeta:get') {
        const { id } = input as Input<'sceneMeta:get'>
        return { id, meta: { ...EMPTY_SCENE_META } } as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: (channel, listener) => {
      if (channel === 'planLinks:changed') {
        onChanged = listener as (payload: EventPayload<'planLinks:changed'>) => void
      }
      return () => {}
    }
  }
  setIpcClient(client)
})

afterEach(() => {
  resetPlanLinksStore()
  resetSceneMetaStore()
  setIpcClient(null)
})

describe('usePlanLinksStore (F-11.1d)', () => {
  it('loads the suggestions and refetches when the background job says they changed', async () => {
    await usePlanLinksStore.getState().load()
    expect(usePlanLinksStore.getState().suggestions).toEqual([SUGGESTION])
    expect(onChanged).not.toBeNull()
    calls = []
    onChanged?.({ changedNodeIds: [] })
    await Promise.resolve()
    expect(calls.map(([channel]) => channel)).toContain('planLinks:get')
  })

  it('runs the job now with a request id and says what it found', async () => {
    await usePlanLinksStore.getState().run()
    const ran = calls.find(([channel]) => channel === 'planLinks:run')?.[1] as
      Input<'planLinks:run'> | undefined
    expect(ran?.requestId).toMatch(/^plan-/)
    expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual([
      '1 suggested link in the outline.'
    ])
    expect(usePlanLinksStore.getState().running).toBe(false)
  })

  it('says so when there was nothing to ask', async () => {
    run = { suggested: 0, applied: 0, changedNodeIds: [], requested: false, costUsd: 0 }
    await usePlanLinksStore.getState().run()
    expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual([
      'No open plan or summarized scene to link yet.'
    ])
  })
})
