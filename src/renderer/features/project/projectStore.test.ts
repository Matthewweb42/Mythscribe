import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Channel,
  EventName,
  EventPayload,
  Input,
  Output,
  ProjectInfo,
  RecentProject
} from '@shared/ipc/contract'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { registerPendingSave, resetPendingSaves } from './pendingSaves'
import { useProjectStore } from './projectStore'

const info: ProjectInfo = {
  id: '1',
  name: 'Book',
  format: 'novel',
  path: '/tmp/Book.mythscribe',
  created: 'c',
  modified: 'm',
  lastOpened: 'l',
  schemaVersion: 1
}

const recent: RecentProject = {
  path: info.path,
  name: info.name,
  format: 'novel',
  lastOpened: '2026-09-10T12:00:00.000Z',
  exists: true
}

function fakeClient(): {
  client: IpcClient
  invoke: ReturnType<typeof vi.fn>
  fire: (p: unknown) => void
} {
  let listener: ((p: never) => void) | undefined
  const invoke = vi.fn(async (channel: string, _input?: unknown) => {
    if (channel === 'project:current') return null
    if (channel === 'project:create' || channel === 'project:open') return info
    if (channel === 'recents:list') return [recent]
    if (channel === 'recents:remove') return []
    return null
  })
  const client: IpcClient = {
    invoke: <C extends Channel>(channel: C, input: Input<C>) =>
      invoke(channel, input) as Promise<Output<C>>,
    on: <E extends EventName>(_e: E, l: (p: EventPayload<E>) => void) => {
      listener = l
      return () => {}
    }
  }
  return { client, invoke, fire: (p) => listener?.(p as never) }
}

beforeEach(() => {
  resetPendingSaves()
  useProjectStore.setState({ current: null, ready: false, busy: false, recents: [] })
})

describe('projectStore', () => {
  it('init loads the current project and subscribes to changes', async () => {
    const { client, fire } = fakeClient()
    setIpcClient(client)
    await useProjectStore.getState().init()
    expect(useProjectStore.getState()).toMatchObject({ current: null, ready: true })
    fire(info)
    expect(useProjectStore.getState().current?.name).toBe('Book')
  })

  it('create sets the project and toggles busy', async () => {
    const { client, invoke } = fakeClient()
    setIpcClient(client)
    const result = await useProjectStore.getState().create('Book', 'novel', '/tmp')
    expect(result?.id).toBe('1')
    expect(invoke).toHaveBeenCalledWith('project:create', {
      name: 'Book',
      format: 'novel',
      directory: '/tmp'
    })
    expect(useProjectStore.getState()).toMatchObject({ current: info, busy: false })
  })

  it('close clears the project even if the request throws', async () => {
    const { client, invoke } = fakeClient()
    invoke.mockImplementationOnce(async () => {
      throw new Error('nope')
    })
    setIpcClient(client)
    useProjectStore.setState({ current: info })
    await expect(useProjectStore.getState().close()).rejects.toThrow('nope')
    expect(useProjectStore.getState().busy).toBe(false)
    expect(useProjectStore.getState().current).toEqual(info)
  })

  it('close awaits registered flushers before invoking project:close', async () => {
    const { client, invoke } = fakeClient()
    setIpcClient(client)
    useProjectStore.setState({ current: info })
    const order: string[] = []
    let resolveFlush: () => void = () => {}
    registerPendingSave(
      () =>
        new Promise<void>((resolve) => {
          resolveFlush = () => {
            order.push('flushed')
            resolve()
          }
        })
    )
    invoke.mockImplementation(async (channel: string) => {
      order.push(channel)
      return null
    })
    const closing = useProjectStore.getState().close()
    await Promise.resolve()
    expect(invoke).not.toHaveBeenCalled()
    resolveFlush()
    await closing
    expect(order).toEqual(['flushed', 'project:close'])
    expect(useProjectStore.getState()).toMatchObject({ current: null, busy: false })
  })

  it('close does not invoke project:close when a flusher rejects', async () => {
    const { client, invoke } = fakeClient()
    setIpcClient(client)
    useProjectStore.setState({ current: info })
    registerPendingSave(async () => {
      throw new Error('save failed')
    })
    await expect(useProjectStore.getState().close()).rejects.toThrow('save failed')
    expect(invoke).not.toHaveBeenCalled()
    expect(useProjectStore.getState()).toMatchObject({ current: info, busy: false })
  })

  it('closeWindow awaits registered flushers before invoking window:close', async () => {
    const { client, invoke } = fakeClient()
    setIpcClient(client)
    useProjectStore.setState({ current: info })
    const order: string[] = []
    let resolveFlush: () => void = () => {}
    registerPendingSave(
      () =>
        new Promise<void>((resolve) => {
          resolveFlush = () => {
            order.push('flushed')
            resolve()
          }
        })
    )
    invoke.mockImplementation(async (channel: string) => {
      order.push(channel)
      return null
    })
    const closing = useProjectStore.getState().closeWindow()
    await Promise.resolve()
    expect(invoke).not.toHaveBeenCalled()
    expect(useProjectStore.getState().busy).toBe(true)
    resolveFlush()
    await closing
    expect(order).toEqual(['flushed', 'window:close'])
    expect(useProjectStore.getState().busy).toBe(false)
  })

  it('closeWindow reports a cancelled close instead of window:close when a flusher rejects', async () => {
    const { client, invoke } = fakeClient()
    setIpcClient(client)
    useProjectStore.setState({ current: info })
    registerPendingSave(async () => {
      throw new Error('save failed')
    })
    await expect(useProjectStore.getState().closeWindow()).rejects.toThrow('save failed')
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('window:close-cancelled', undefined)
    expect(useProjectStore.getState()).toMatchObject({ current: info, busy: false })
  })

  it('loadRecents fills recents without toggling busy', async () => {
    const { client, invoke } = fakeClient()
    setIpcClient(client)
    const busyStates: boolean[] = []
    const stop = useProjectStore.subscribe((s) => busyStates.push(s.busy))
    await useProjectStore.getState().loadRecents()
    stop()
    expect(invoke).toHaveBeenCalledWith('recents:list', undefined)
    expect(useProjectStore.getState().recents).toEqual([recent])
    expect(busyStates.every((b) => !b)).toBe(true)
  })

  it('removeRecent replaces recents from the response without toggling busy', async () => {
    const { client, invoke } = fakeClient()
    setIpcClient(client)
    useProjectStore.setState({ recents: [recent] })
    const busyStates: boolean[] = []
    const stop = useProjectStore.subscribe((s) => busyStates.push(s.busy))
    await useProjectStore.getState().removeRecent(recent.path)
    stop()
    expect(invoke).toHaveBeenCalledWith('recents:remove', { path: recent.path })
    expect(useProjectStore.getState().recents).toEqual([])
    expect(busyStates.every((b) => !b)).toBe(true)
  })
})
