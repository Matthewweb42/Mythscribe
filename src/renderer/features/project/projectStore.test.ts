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
import type { CloudConflict } from '@shared/cloudSync'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
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
    if (channel === 'recovery:list') return []
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
  useDialogStore.setState({ modals: [], toasts: [] })
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

  it('open and a start-up with a project open ask for crash recovery; create does not (F-8.3)', async () => {
    const { client, invoke } = fakeClient()
    setIpcClient(client)
    await useProjectStore.getState().create('Book', 'novel', '/tmp')
    expect(invoke).not.toHaveBeenCalledWith('recovery:list', undefined)
    await useProjectStore.getState().open('/tmp/Book.mythscribe')
    expect(invoke).toHaveBeenCalledWith('recovery:list', undefined)
    invoke.mockClear()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'project:current') return info
      if (channel === 'recovery:list') return []
      return null
    })
    await useProjectStore.getState().init()
    expect(invoke).toHaveBeenCalledWith('recovery:list', undefined)
  })

  describe('a cloud project changed in both places (2026-10-10)', () => {
    const conflict: CloudConflict = {
      folder: '/drive/My Drive/Book.mythscribe',
      provider: 'googleDrive',
      computer: { modifiedAt: '2026-10-10T09:00:00.000Z', bytes: 2_400_000 },
      cloud: { modifiedAt: '2026-10-10T11:00:00.000Z', bytes: 2_300_000 }
    }
    const refused = new IpcRequestError({
      code: 'CLOUD_CONFLICT',
      message: 'This project changed both on this computer and in Google Drive.',
      details: conflict
    })

    function conflicted(): ReturnType<typeof vi.fn> {
      const { client, invoke } = fakeClient()
      invoke.mockImplementation(async (channel: string, input?: unknown) => {
        if (channel === 'project:open') {
          const asked = input as { cloudConflict?: string }
          if (asked.cloudConflict === undefined) throw refused
          return info
        }
        if (channel === 'recovery:list') return []
        return null
      })
      setIpcClient(client)
      return invoke
    }

    it('asks which version to keep, newer first, and opens again with the answer', async () => {
      const invoke = conflicted()
      // Opened from the native dialog: the second open names the folder main reported.
      const opening = useProjectStore.getState().open()
      await vi.waitFor(() => expect(useDialogStore.getState().modals).toHaveLength(1))
      const modal = useDialogStore.getState().modals[0]
      if (modal?.kind !== 'choose') throw new Error('expected a choose dialog')
      expect(modal.options.choices.map((c) => c.label)).toEqual([
        "Keep this computer's",
        "Keep Google Drive's"
      ])
      expect(modal.options.primary).toBe('cloud')
      expect(modal.options.message).toContain('"Book"')
      expect(modal.options.details?.[0]).toMatch(/^This computer: changed .+, 2\.3 MB$/)
      expect(modal.options.details?.[1]).toMatch(/^Google Drive: changed .+, 2\.2 MB$/)
      useDialogStore.getState().resolveChoose(modal.id, 'computer')
      await expect(opening).resolves.toEqual(info)
      expect(invoke).toHaveBeenCalledWith('project:open', {
        path: conflict.folder,
        cloudConflict: 'computer'
      })
      expect(useProjectStore.getState().current).toEqual(info)
    })

    it('opens nothing when the author cancels', async () => {
      const invoke = conflicted()
      useProjectStore.setState({ current: null })
      const opening = useProjectStore.getState().open(conflict.folder)
      await vi.waitFor(() => expect(useDialogStore.getState().modals).toHaveLength(1))
      const modal = useDialogStore.getState().modals[0]
      if (modal?.kind !== 'choose') throw new Error('expected a choose dialog')
      useDialogStore.getState().resolveChoose(modal.id, null)
      await expect(opening).resolves.toBeNull()
      expect(invoke).toHaveBeenCalledTimes(1)
      expect(useProjectStore.getState().current).toBeNull()
    })
  })

  it('restoreBackup flushes, opens the restored copy, and offers no recovery (F-8.4)', async () => {
    const { client, invoke } = fakeClient()
    const restored = { ...info, path: '/tmp/Book (restored 2026-10-04 1200).mythscribe' }
    const order: string[] = []
    registerPendingSave(async () => {
      order.push('flushed')
    })
    invoke.mockImplementation(async (channel: string) => {
      order.push(channel)
      return channel === 'backups:restore' ? restored : null
    })
    setIpcClient(client)
    useProjectStore.setState({ current: info })
    const result = await useProjectStore.getState().restoreBackup('/b/Book 2026-10-04 120000.zip')
    expect(result).toEqual(restored)
    expect(invoke).toHaveBeenCalledWith('backups:restore', {
      file: '/b/Book 2026-10-04 120000.zip'
    })
    expect(order).toEqual(['flushed', 'project:cloudSyncNow', 'backups:restore'])
    expect(useProjectStore.getState()).toMatchObject({ current: restored, busy: false })
  })

  it('restoreBackup keeps the open project when a dialog is cancelled (F-8.4)', async () => {
    const { client } = fakeClient()
    setIpcClient(client)
    useProjectStore.setState({ current: info })
    expect(await useProjectStore.getState().restoreBackup()).toBeNull()
    expect(useProjectStore.getState().current).toEqual(info)
  })

  it('close clears the project even if the request throws', async () => {
    const { client, invoke } = fakeClient()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'project:close') throw new Error('nope')
      return null
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
    // 2026-10-08: a project in a cloud-synced folder is copied there before it closes.
    expect(order).toEqual(['flushed', 'project:cloudSyncNow', 'project:close'])
    expect(useProjectStore.getState()).toMatchObject({ current: null, busy: false })
  })

  it('asks before closing when the copy to the cloud folder failed, and closes on Close anyway', async () => {
    const { client, invoke } = fakeClient()
    setIpcClient(client)
    useProjectStore.setState({ current: info })
    invoke.mockImplementation(async (channel: string) =>
      channel === 'project:cloudSyncNow'
        ? {
            provider: 'googleDrive',
            state: 'failed',
            lastSyncedAt: null,
            error: 'Could not copy the project to Google Drive: EBUSY',
            conflictCopy: null,
            conflictCopyHolds: null
          }
        : null
    )
    const closing = useProjectStore.getState().close()
    await vi.waitFor(() => expect(useDialogStore.getState().modals).toHaveLength(1))
    expect(invoke).not.toHaveBeenCalledWith('project:close', undefined)
    const modal = useDialogStore.getState().modals[0]
    if (modal?.kind !== 'confirm') throw new Error('expected a confirm dialog')
    useDialogStore.getState().resolveConfirm(modal.id, true)
    await closing
    expect(invoke).toHaveBeenCalledWith('project:close', undefined)
  })

  it('does not ask the cloud folder anything when no project is open', async () => {
    const { client, invoke } = fakeClient()
    setIpcClient(client)
    await useProjectStore.getState().open('/tmp/Book.mythscribe')
    expect(invoke).not.toHaveBeenCalledWith('project:cloudSyncNow', undefined)
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
    expect(order).toEqual(['flushed', 'project:cloudSyncNow', 'window:close'])
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
