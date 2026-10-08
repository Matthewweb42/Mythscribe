import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLOUD_SYNC_INTERVAL_MS,
  CLOUD_SYNC_RETRY_MS,
  type CloudSyncStatus
} from '@shared/cloudSync'
import { CloudSyncService } from './cloudSyncService'
import { ProjectManager } from './manager'
import { DB_FILE, projectFolderFor } from './projectStore'

interface Timer {
  run: () => void
  ms: number
  cancelled: boolean
}

let tmp: string
let manager: ProjectManager
let service: CloudSyncService
let timers: Timer[]
let pushed: (CloudSyncStatus | null)[]

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-sync-'))
  fs.mkdirSync(path.join(tmp, 'My Drive'))
  manager = new ProjectManager({ workingRoot: () => path.join(tmp, 'working') })
  timers = []
  pushed = []
  service = new CloudSyncService({
    projects: manager,
    onChange: (status) => pushed.push(status),
    schedule: (run, ms) => {
      const timer: Timer = { run, ms, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    }
  })
  // The same wiring as `registerHandlers`.
  manager.onChange((info) => {
    if (info) service.projectOpened()
    else service.projectClosed()
  })
  manager.onBeforeClose(() => service.projectClosing())
})

afterEach(() => {
  vi.restoreAllMocks()
  service.dispose()
  manager.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function armed(): Timer[] {
  return timers.filter((t) => !t.cancelled)
}

/** Runs the one armed timer and waits for the copy it starts. */
async function fire(): Promise<void> {
  const [timer] = armed()
  if (!timer) throw new Error('no timer armed')
  timer.cancelled = true
  timer.run()
  await vi.waitFor(() => expect(service.status()?.state).not.toBe('copying'))
}

function cloudName(folder: string): string {
  const db = new Database(fs.readFileSync(path.join(folder, DB_FILE)))
  try {
    return db.prepare<[], { name: string }>('SELECT name FROM project').get()?.name ?? ''
  } finally {
    db.close()
  }
}

function rename(to: string): void {
  manager.require().connection.sqlite.prepare('UPDATE project SET name = ?').run(to)
}

describe('CloudSyncService', () => {
  it('stays out of the way for a project in a plain folder', async () => {
    manager.create(projectFolderFor(tmp, 'Plain'), 'Plain', 'novel')
    expect(service.status()).toBeNull()
    expect(armed()).toEqual([])
    await expect(service.syncNow()).resolves.toBeNull()
  })

  it('copies a changed project back on the schedule', async () => {
    const folder = projectFolderFor(path.join(tmp, 'My Drive'), 'Book')
    manager.create(folder, 'Book', 'novel')
    expect(service.status()).toMatchObject({ provider: 'googleDrive', state: 'synced' })
    expect(armed().map((t) => t.ms)).toEqual([CLOUD_SYNC_INTERVAL_MS])
    rename('Changed')
    await fire()
    expect(cloudName(folder)).toBe('Changed')
    expect(pushed.some((s) => s?.state === 'copying')).toBe(true)
    expect(service.status()?.state).toBe('synced')
    expect(armed().map((t) => t.ms)).toEqual([CLOUD_SYNC_INTERVAL_MS])
  })

  it('does not copy when nothing changed since the last copy', async () => {
    const folder = projectFolderFor(path.join(tmp, 'My Drive'), 'Book')
    manager.create(folder, 'Book', 'novel')
    const before = fs.statSync(path.join(folder, DB_FILE)).mtimeMs
    await fire()
    expect(fs.statSync(path.join(folder, DB_FILE)).mtimeMs).toBe(before)
    expect(pushed.some((s) => s?.state === 'copying')).toBe(false)
  })

  it('reports a failed copy quietly and retries with a growing delay', async () => {
    const folder = projectFolderFor(path.join(tmp, 'My Drive'), 'Book')
    manager.create(folder, 'Book', 'novel')
    rename('Changed')
    const real = fs.promises.writeFile
    const write = vi
      .spyOn(fs.promises, 'writeFile')
      .mockRejectedValue(new Error('EIO: i/o error, write'))
    await fire()
    expect(service.status()).toMatchObject({ state: 'failed' })
    expect(service.status()?.error).toMatch(/Could not copy the project to Google Drive: EIO/)
    expect(armed().map((t) => t.ms)).toEqual([CLOUD_SYNC_RETRY_MS])
    await fire()
    expect(armed().map((t) => t.ms)).toEqual([CLOUD_SYNC_RETRY_MS * 2])
    expect(cloudName(folder)).toBe('Book')

    write.mockImplementation(real)
    await fire()
    expect(service.status()).toMatchObject({ state: 'synced', error: null })
    expect(cloudName(folder)).toBe('Changed')
    expect(armed().map((t) => t.ms)).toEqual([CLOUD_SYNC_INTERVAL_MS])
  })

  it('answers the status after copying now, for the close flow', async () => {
    const folder = projectFolderFor(path.join(tmp, 'My Drive'), 'Book')
    manager.create(folder, 'Book', 'novel')
    rename('Before closing')
    const status = await service.syncNow()
    expect(status?.state).toBe('synced')
    expect(status?.lastSyncedAt).not.toBeNull()
    expect(cloudName(folder)).toBe('Before closing')
  })

  it('copies again after a copy that was already running when asked', async () => {
    const folder = projectFolderFor(path.join(tmp, 'My Drive'), 'Book')
    manager.create(folder, 'Book', 'novel')
    rename('First')
    service.changed()
    rename('Second')
    await service.syncNow()
    expect(cloudName(folder)).toBe('Second')
  })

  it('copies at once after opening a project that carried changes', async () => {
    const folder = projectFolderFor(path.join(tmp, 'My Drive'), 'Book')
    manager.create(folder, 'Book', 'novel')
    rename('Carried')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('Drive is offline')
    })
    manager.close()
    write.mockRestore()
    warn.mockRestore()
    expect(cloudName(folder)).toBe('Book')

    manager.open(folder)
    await service.syncNow()
    expect(cloudName(folder)).toBe('Carried')
  })

  it('pushes null when the project closes and stops the schedule', () => {
    manager.create(projectFolderFor(path.join(tmp, 'My Drive'), 'Book'), 'Book', 'novel')
    manager.close()
    expect(pushed.at(-1)).toBeNull()
    expect(armed()).toEqual([])
  })
})
