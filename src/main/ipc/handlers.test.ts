import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ipcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TreeNode,
  type Channel,
  type Input,
  type IpcResult,
  type Output
} from '@shared/ipc/contract'
import { z } from 'zod'
import { AppStateStore } from '../appState/appStateStore'
import type { ProjectDialogs } from '../dialogs'
import { ProjectManager } from '../project/manager'
import { projectFolderFor } from '../project/projectStore'
import { registerHandlers } from './handlers'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0' },
  ipcMain: { handle: vi.fn() }
}))

type Invoke = <C extends Channel>(channel: C, input: Input<C>) => Promise<Output<C>>

let tmp: string
let manager: ProjectManager
let invoke: Invoke

const dialogs: ProjectDialogs = {
  chooseProjectSavePath: async () => null,
  chooseProjectToOpen: async () => null
}

beforeEach(() => {
  vi.mocked(ipcMain.handle).mockClear()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-handlers-'))
  manager = new ProjectManager()
  registerHandlers({
    manager,
    appState: new AppStateStore(path.join(tmp, 'userData', 'app-state.json')),
    dialogs,
    windows: () => []
  })
  const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<IpcResult<unknown>>>()
  for (const [channel, fn] of vi.mocked(ipcMain.handle).mock.calls) {
    handlers.set(channel, fn as (event: unknown, raw: unknown) => Promise<IpcResult<unknown>>)
  }
  invoke = async (channel, input) => {
    const fn = handlers.get(channel)
    if (!fn) throw new Error(`No handler registered for ${channel}`)
    const result = await fn(undefined, input)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.data as Output<typeof channel>
  }
})
afterEach(() => {
  manager.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('recents handlers', () => {
  it('records created and opened projects newest first', async () => {
    const a = await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    const b = await invoke('project:create', { name: 'B', format: 'epic', directory: tmp })
    const list = await invoke('recents:list', undefined)
    expect(list).toEqual([
      { path: b?.path, name: 'B', format: 'epic', lastOpened: b?.lastOpened, exists: true },
      { path: a?.path, name: 'A', format: 'novel', lastOpened: a?.lastOpened, exists: true }
    ])
  })

  it('moves a reopened project to the front without duplicating it', async () => {
    const a = await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    await invoke('project:create', { name: 'B', format: 'novel', directory: tmp })
    const reopened = await invoke('project:open', { path: a?.path ?? '' })
    const list = await invoke('recents:list', undefined)
    expect(list.map((r) => r.name)).toEqual(['A', 'B'])
    expect(list[0]?.lastOpened).toBe(reopened?.lastOpened)
  })

  it('flags entries whose folder is no longer a project', async () => {
    await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    await invoke('project:close', undefined)
    fs.rmSync(projectFolderFor(tmp, 'A'), { recursive: true, force: true })
    const list = await invoke('recents:list', undefined)
    expect(list.map((r) => r.exists)).toEqual([false])
  })

  it('removes an entry and returns the remaining list', async () => {
    const a = await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    await invoke('project:create', { name: 'B', format: 'novel', directory: tmp })
    const remaining = await invoke('recents:remove', { path: a?.path ?? '' })
    expect(remaining.map((r) => r.name)).toEqual(['B'])
    expect((await invoke('recents:list', undefined)).map((r) => r.name)).toEqual(['B'])
  })

  it('treats removing an unknown path as a no-op', async () => {
    await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    const remaining = await invoke('recents:remove', { path: path.join(tmp, 'nowhere') })
    expect(remaining.map((r) => r.name)).toEqual(['A'])
  })

  it('persists recents across store instances', async () => {
    await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    const fresh = new AppStateStore(path.join(tmp, 'userData', 'app-state.json'))
    expect(fresh.get().recents.map((r) => r.name)).toEqual(['A'])
  })
})

describe('tree:list', () => {
  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('tree:list', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('returns the seeded skeleton of the open project (F-1.3)', async () => {
    await invoke('project:create', { name: 'Seeded', format: 'webnovel', directory: tmp })
    const rows = z.array(TreeNode).parse(await invoke('tree:list', undefined))
    expect(rows).toHaveLength(17)
    expect(rows.filter((r) => r.sectionType !== null)).toHaveLength(3)
    expect(rows.map((r) => r.title)).toContain('Arc 1')
    expect(rows.filter((r) => r.kind === 'document')).toHaveLength(6)
  })
})
