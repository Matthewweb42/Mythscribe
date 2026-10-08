import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudSyncStatus } from '@shared/cloudSync'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { confirmCloudCopy, resetCloudSyncStore, useCloudSyncStore } from './cloudSyncStore'

const synced: CloudSyncStatus = {
  provider: 'googleDrive',
  state: 'synced',
  lastSyncedAt: '2026-10-08T12:00:00.000Z',
  error: null,
  conflictCopy: null
}
const failed: CloudSyncStatus = {
  ...synced,
  state: 'failed',
  error: 'Could not copy the project to Google Drive: EBUSY'
}

let pushed: ((status: CloudSyncStatus | null) => void) | null

function install(answers: (CloudSyncStatus | null)[]): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async (channel: string, _input?: unknown) => {
    if (channel === 'project:cloudSyncNow') return answers.shift() ?? null
    if (channel === 'project:cloudSyncStatus') return null
    return null
  })
  const client: IpcClient = {
    invoke: <C extends Channel>(channel: C, input: Input<C>) =>
      invoke(channel, input) as Promise<Output<C>>,
    on: <E extends EventName>(_event: E, listener: (payload: EventPayload<E>) => void) => {
      pushed = listener as (status: CloudSyncStatus | null) => void
      return () => {
        pushed = null
      }
    }
  }
  setIpcClient(client)
  return invoke
}

/** Answers the confirm dialog on screen; true = the confirm button. */
async function answer(value: boolean): Promise<void> {
  await vi.waitFor(() => expect(useDialogStore.getState().modals).toHaveLength(1))
  const modal = useDialogStore.getState().modals[0]
  if (modal?.kind !== 'confirm') throw new Error('expected a confirm dialog')
  useDialogStore.getState().resolveConfirm(modal.id, value)
}

beforeEach(() => {
  pushed = null
  resetCloudSyncStore()
  useDialogStore.setState({ modals: [], toasts: [] })
})
afterEach(() => {
  resetCloudSyncStore()
  useDialogStore.setState({ modals: [], toasts: [] })
})

describe('confirmCloudCopy', () => {
  it('goes on at once for a plain folder or a copy that worked', async () => {
    const invoke = install([null])
    await confirmCloudCopy('close')
    install([synced])
    await confirmCloudCopy('close')
    expect(invoke).toHaveBeenCalledWith('project:cloudSyncNow', undefined)
    expect(useDialogStore.getState().modals).toEqual([])
  })

  it('asks after a failed copy, retries on Retry, and goes on once it works', async () => {
    const invoke = install([failed, synced])
    const done = confirmCloudCopy('close')
    await answer(false) // Retry
    await done
    expect(invoke.mock.calls.filter(([c]) => c === 'project:cloudSyncNow')).toHaveLength(2)
  })

  it('names the cloud and the cause, and lets the author close anyway', async () => {
    install([failed])
    const done = confirmCloudCopy('close')
    await vi.waitFor(() => expect(useDialogStore.getState().modals).toHaveLength(1))
    const modal = useDialogStore.getState().modals[0]
    expect(modal?.kind === 'confirm' && modal.options).toMatchObject({
      title: 'Google Drive does not have your latest changes',
      confirmLabel: 'Close anyway',
      cancelLabel: 'Retry'
    })
    expect(modal?.kind === 'confirm' && modal.options.message).toContain('EBUSY')
    await answer(true)
    await done
  })

  it('says Continue anyway when another project is about to open', async () => {
    install([failed])
    const done = confirmCloudCopy('switch')
    await vi.waitFor(() => expect(useDialogStore.getState().modals).toHaveLength(1))
    const modal = useDialogStore.getState().modals[0]
    expect(modal?.kind === 'confirm' && modal.options.confirmLabel).toBe('Continue anyway')
    await answer(true)
    await done
  })
})

describe('useCloudSyncStore', () => {
  it('keeps what main pushes and toasts a conflict copy once', async () => {
    install([])
    const off = useCloudSyncStore.getState().subscribe()
    await vi.waitFor(() => expect(pushed).not.toBeNull())
    const conflict = {
      ...synced,
      conflictCopy: 'G:\\My Drive\\Book (conflict 2026-10-08 1405).mythscribe'
    }
    pushed?.(conflict)
    pushed?.({ ...conflict, state: 'copying' })
    expect(useCloudSyncStore.getState().status?.state).toBe('copying')
    const toasts = useDialogStore.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.message).toContain('"Book (conflict 2026-10-08 1405).mythscribe"')
    pushed?.(null)
    expect(useCloudSyncStore.getState().status).toBeNull()
    off()
  })
})
