import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  Channel,
  EventName,
  EventPayload,
  Input,
  Output,
  ProjectInfo
} from '@shared/ipc/contract'
import type { UpdateState } from '@shared/updates'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetUpdateStore, useUpdateStore } from './updateStore'

const IDLE: UpdateState = {
  currentVersion: '0.1.0',
  channel: 'stable',
  autoCheck: true,
  status: { state: 'idle' },
  installedNotes: null,
  unseenNotes: false
}
const UP_TO_DATE: UpdateState = {
  ...IDLE,
  status: { state: 'upToDate', checkedAt: '2026-09-21T10:00:00.000Z' }
}
const BETA: UpdateState = { ...UP_TO_DATE, channel: 'beta' }

const info: ProjectInfo = {
  id: '1',
  name: 'Serial',
  format: 'webnovel',
  path: '/tmp/Serial.mythscribe',
  created: 'c',
  modified: 'm',
  lastOpened: 'l',
  schemaVersion: 1
}

interface Fake {
  client: IpcClient
  calls: { channel: Channel; input: unknown }[]
  /** The `updates:changed` listener the store registered, if any. */
  listener: ((state: UpdateState) => void) | null
  unsubscribed: boolean
  /** Thrown by every channel while set, so the failure path is driven. */
  fail: Error | null
}

function fakeClient(): Fake {
  const fake: Fake = {
    calls: [],
    listener: null,
    unsubscribed: false,
    fail: null,
    client: {
      async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
        fake.calls.push({ channel, input })
        if (fake.fail) throw fake.fail
        switch (channel) {
          case 'updates:getState':
            return IDLE as Output<C>
          case 'updates:check':
            return UP_TO_DATE as Output<C>
          case 'updates:setChannel':
            return BETA as Output<C>
          case 'updates:setAutoCheck':
            return { ...UP_TO_DATE, autoCheck: false } as Output<C>
          case 'updates:markSeen':
            return { ...UP_TO_DATE, unseenNotes: false } as Output<C>
          case 'updates:install':
            return null as Output<C>
          case 'project:close':
            return null as Output<C>
          default:
            throw new Error(`unexpected ${channel}`)
        }
      },
      on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void): () => void {
        if (event !== 'updates:changed') throw new Error(`unexpected ${event}`)
        fake.listener = listener as (state: UpdateState) => void
        return () => {
          fake.unsubscribed = true
          fake.listener = null
        }
      }
    }
  }
  return fake
}

let fake: Fake
const store = (): ReturnType<typeof useUpdateStore.getState> => useUpdateStore.getState()
const channels = (): Channel[] => fake.calls.map((call) => call.channel)

/** Answers the pending confirm modal (File › Close project's). */
function answerConfirm(ok: boolean): void {
  const modal = useDialogStore.getState().modals[0]
  if (modal?.kind !== 'confirm') throw new Error('no confirm modal')
  useDialogStore.getState().resolveConfirm(modal.id, ok)
}

beforeEach(() => {
  resetUpdateStore()
  fake = fakeClient()
  setIpcClient(fake.client)
  useProjectStore.setState({ current: null, ready: true, busy: false, recents: [] })
  useDialogStore.setState({ modals: [], toasts: [] })
})
afterEach(() => {
  resetUpdateStore()
  useDialogStore.setState({ modals: [], toasts: [] })
})

describe('updateStore (F-15.7)', () => {
  it('starts empty and loads the state main answers', async () => {
    expect(store().state).toBeNull()
    await store().load()
    expect(store().state).toEqual(IDLE)
    expect(store().busy).toBe(false)
    expect(channels()).toEqual(['updates:getState'])
  })

  it('forwards the check, the channel, the automatic check, and marking the notes seen', async () => {
    await store().check()
    expect(store().state).toEqual(UP_TO_DATE)
    await store().setChannel('beta')
    expect(store().state?.channel).toBe('beta')
    await store().setAutoCheck(false)
    expect(store().state?.autoCheck).toBe(false)
    await store().markSeen()
    expect(fake.calls).toEqual([
      { channel: 'updates:check', input: undefined },
      { channel: 'updates:setChannel', input: { channel: 'beta' } },
      { channel: 'updates:setAutoCheck', input: { on: false } },
      { channel: 'updates:markSeen', input: undefined }
    ])
  })

  it('keeps a failure beside the controls and clears it on the next action', async () => {
    fake.fail = new IpcRequestError({ code: 'IO', message: 'Could not reach GitHub.' })
    await store().check()
    expect(store().error).toBe('Could not reach GitHub.')
    expect(store().busy).toBe(false)
    fake.fail = null
    await store().check()
    expect(store().error).toBeNull()
    expect(store().state).toEqual(UP_TO_DATE)
  })

  it('subscribes once, loads, and takes what main pushes', async () => {
    const off = store().subscribe()
    expect(channels()).toEqual(['updates:getState'])
    const ready: UpdateState = {
      ...IDLE,
      status: {
        state: 'ready',
        version: '0.2.0',
        notes: { version: '0.2.0', date: null, text: '- Faster' }
      }
    }
    fake.listener?.(ready)
    expect(store().state).toEqual(ready)
    expect(store().error).toBeNull()
    off()
    expect(fake.unsubscribed).toBe(true)
  })

  it('installs straight away when no project is open', async () => {
    await store().installNow()
    expect(channels()).toEqual(['updates:install'])
    expect(store().busy).toBe(false)
  })

  it('closes the project first, and installs nothing when the confirm is refused', async () => {
    useProjectStore.setState({ current: info })
    const refused = store().installNow()
    answerConfirm(false)
    await refused
    expect(channels()).toEqual([])
    expect(useProjectStore.getState().current).toEqual(info)

    const accepted = store().installNow()
    answerConfirm(true)
    await accepted
    expect(channels()).toEqual(['project:close', 'updates:install'])
    expect(useProjectStore.getState().current).toBeNull()
  })

  it('shows why an install was refused', async () => {
    fake.fail = new IpcRequestError({
      code: 'VALIDATION',
      message: 'Close the project first, then install the update.'
    })
    await store().installNow()
    expect(store().error).toBe('Close the project first, then install the update.')
  })
})
