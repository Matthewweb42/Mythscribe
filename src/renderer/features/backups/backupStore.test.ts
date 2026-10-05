import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultBackupSettings, type BackupState } from '@shared/backups'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { registerPendingSave, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetBackupStore, useBackupStore } from './backupStore'

const STATE: BackupState = {
  settings: defaultBackupSettings(),
  folder: '/backups',
  defaultFolder: '/backups',
  backups: [],
  lastBackupAt: null,
  lastError: null
}

const ENTRY = {
  file: '/backups/Ridge (01234567)/Ridge 2026-10-04 120000.zip',
  name: 'Ridge 2026-10-04 120000.zip',
  createdAt: '2026-10-04T12:00:00.000Z',
  bytes: 4096
}

let calls: string[]
let fail: string | null
let pushChanged: ((state: BackupState) => void) | null

const client: IpcClient = {
  async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
    calls.push(channel)
    if (fail === channel) throw new Error('The disk is full')
    switch (channel) {
      case 'backups:get':
      case 'backups:chooseFolder':
        return STATE as Output<C>
      case 'backups:setSettings': {
        const { patch } = input as Input<'backups:setSettings'>
        const state: BackupState = {
          ...STATE,
          settings: { ...STATE.settings, keep: patch.keep ?? STATE.settings.keep }
        }
        return state as Output<C>
      }
      case 'backups:now': {
        const state: BackupState = { ...STATE, backups: [ENTRY], lastBackupAt: ENTRY.createdAt }
        return state as Output<C>
      }
      case 'backups:reveal':
        return null as Output<C>
      default:
        throw new Error(`unexpected ${channel}`)
    }
  },
  on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void): () => void {
    if (event === 'backups:changed') {
      pushChanged = (state) => listener(state as EventPayload<E>)
    }
    return () => {
      pushChanged = null
    }
  }
}

beforeEach(() => {
  resetBackupStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  calls = []
  fail = null
  pushChanged = null
  setIpcClient(client)
})
afterEach(() => {
  resetBackupStore()
  resetPendingSaves()
})

describe('backupStore (F-8.4)', () => {
  it('loads on subscribe and takes what main pushes', async () => {
    const off = useBackupStore.getState().subscribe()
    await expect.poll(() => useBackupStore.getState().state).toEqual(STATE)
    pushChanged?.({ ...STATE, backups: [ENTRY] })
    expect(useBackupStore.getState().state?.backups).toEqual([ENTRY])
    off()
    expect(pushChanged).toBeNull()
  })

  it('toasts a pushed automatic failure once per new cause', async () => {
    useBackupStore.getState().subscribe()
    await expect.poll(() => useBackupStore.getState().state).toEqual(STATE)
    pushChanged?.({ ...STATE, lastError: 'EACCES: permission denied' })
    pushChanged?.({ ...STATE, lastError: 'EACCES: permission denied' })
    expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual([
      'Automatic backup failed: EACCES: permission denied'
    ])
    pushChanged?.({ ...STATE, lastError: null })
    pushChanged?.({ ...STATE, lastError: 'ENOSPC: no space left' })
    expect(useDialogStore.getState().toasts).toHaveLength(2)
  })

  it('writes pending saves before backing up now', async () => {
    registerPendingSave(async () => {
      calls.push('flushed')
    })
    await useBackupStore.getState().backUpNow()
    expect(calls).toEqual(['flushed', 'backups:now'])
    expect(useBackupStore.getState().state?.backups).toEqual([ENTRY])
  })

  it('forwards settings and keeps a failed action in error, cleared by the next', async () => {
    await useBackupStore.getState().setSettings({ keep: 20 })
    expect(useBackupStore.getState().state?.settings.keep).toBe(20)
    fail = 'backups:reveal'
    await useBackupStore.getState().reveal()
    expect(useBackupStore.getState().error).toBe('The disk is full')
    expect(useBackupStore.getState().busy).toBe(false)
    fail = null
    await useBackupStore.getState().chooseFolder()
    expect(useBackupStore.getState().error).toBeNull()
  })
})
