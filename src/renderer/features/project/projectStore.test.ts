import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectInfo } from '@shared/ipc/contract'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
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

function fakeClient(): {
  client: IpcClient
  invoke: ReturnType<typeof vi.fn>
  fire: (p: unknown) => void
} {
  let listener: ((p: never) => void) | undefined
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'project:current') return null
    if (channel === 'project:create' || channel === 'project:open') return info
    return null
  })
  const client = {
    invoke,
    on: (_e: string, l: (p: never) => void) => {
      listener = l
      return () => {}
    }
  } as unknown as IpcClient
  return { client, invoke, fire: (p) => listener?.(p as never) }
}

beforeEach(() => {
  useProjectStore.setState({ current: null, ready: false, busy: false })
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
})
