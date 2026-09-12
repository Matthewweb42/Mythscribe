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
import { registerHandlers, type ClosableWindow } from './handlers'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0' },
  ipcMain: { handle: vi.fn() }
}))

type Invoke = <C extends Channel>(channel: C, input: Input<C>) => Promise<Output<C>>

let tmp: string
let manager: ProjectManager
let invoke: Invoke
let handlerFor: (channel: Channel) => (event: unknown, raw: unknown) => Promise<IpcResult<unknown>>
let fakeWin: ClosableWindow

const dialogs: ProjectDialogs = {
  chooseProjectSavePath: async () => null,
  chooseProjectToOpen: async () => null
}

beforeEach(() => {
  vi.mocked(ipcMain.handle).mockClear()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-handlers-'))
  manager = new ProjectManager()
  fakeWin = { close: vi.fn(), isDestroyed: () => false, webContents: { send: vi.fn() } }
  registerHandlers({
    manager,
    appState: new AppStateStore(path.join(tmp, 'userData', 'app-state.json')),
    dialogs,
    windows: () => [fakeWin]
  })
  const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<IpcResult<unknown>>>()
  for (const [channel, fn] of vi.mocked(ipcMain.handle).mock.calls) {
    handlers.set(channel, fn as (event: unknown, raw: unknown) => Promise<IpcResult<unknown>>)
  }
  handlerFor = (channel) => {
    const fn = handlers.get(channel)
    if (!fn) throw new Error(`No handler registered for ${channel}`)
    return fn
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

describe('tree:create / tree:rename / tree:duplicate / tree:delete', () => {
  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(
      invoke('tree:create', { parentId: 'x', kind: 'document', hierarchyLevel: null })
    ).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('creates a node that tree:list then shows at the expected position', async () => {
    await invoke('project:create', { name: 'Tree', format: 'webnovel', directory: tmp })
    const before = await invoke('tree:list', undefined)
    const manuscript = before.find((r) => r.sectionType === 'manuscript')
    const arc1 = before.find((r) => r.parentId === manuscript?.id && r.position === 0)
    const created = await invoke('tree:create', {
      parentId: manuscript?.id ?? '',
      kind: 'folder',
      hierarchyLevel: 'part',
      afterId: arc1?.id
    })
    expect(created).toMatchObject({ title: 'Untitled Arc', position: 1, parentId: manuscript?.id })
    const after = await invoke('tree:list', undefined)
    const parts = after.filter((r) => r.parentId === manuscript?.id)
    expect(parts.map((r) => [r.title, r.position])).toEqual([
      ['Arc 1', 0],
      ['Untitled Arc', 1],
      ['Arc 2', 2]
    ])
  })

  it('renames a node and the change shows in tree:list', async () => {
    await invoke('project:create', { name: 'Tree', format: 'novel', directory: tmp })
    const scene = (await invoke('tree:list', undefined)).find((r) => r.kind === 'document')
    const renamed = await invoke('tree:rename', { id: scene?.id ?? '', title: '  Opening  ' })
    expect(renamed).toMatchObject({ id: scene?.id, title: 'Opening' })
    const listed = (await invoke('tree:list', undefined)).find((r) => r.id === scene?.id)
    expect(listed?.title).toBe('Opening')
  })

  it('duplicates a node and its subtree; tree:list shows the copy after the original', async () => {
    await invoke('project:create', { name: 'Tree', format: 'webnovel', directory: tmp })
    const before = await invoke('tree:list', undefined)
    const chapter = before.find((r) => r.hierarchyLevel === 'chapter' && r.position === 0)
    const rows = await invoke('tree:duplicate', { id: chapter?.id ?? '' })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ title: 'Chapter 1 (Copy)', parentId: chapter?.parentId })
    expect(rows[1]).toMatchObject({ title: 'Scene 1', parentId: rows[0]?.id })
    const after = await invoke('tree:list', undefined)
    expect(after).toHaveLength(19)
    const siblings = after.filter((r) => r.parentId === chapter?.parentId)
    expect(siblings.map((r) => [r.title, r.position])).toEqual([
      ['Chapter 1', 0],
      ['Chapter 1 (Copy)', 1],
      ['Chapter 2', 2],
      ['Chapter 3', 3]
    ])
  })

  it('deletes a node with its subtree and closes the sibling gap', async () => {
    await invoke('project:create', { name: 'Tree', format: 'webnovel', directory: tmp })
    const before = await invoke('tree:list', undefined)
    const chapter = before.find((r) => r.hierarchyLevel === 'chapter' && r.position === 1)
    expect(await invoke('tree:delete', { id: chapter?.id ?? '' })).toBeNull()
    const after = await invoke('tree:list', undefined)
    expect(after).toHaveLength(15)
    expect(after.find((r) => r.id === chapter?.id)).toBeUndefined()
    expect(after.filter((r) => r.parentId === chapter?.id)).toHaveLength(0)
    const siblings = after.filter((r) => r.parentId === chapter?.parentId)
    expect(siblings.map((r) => [r.title, r.position])).toEqual([
      ['Chapter 1', 0],
      ['Chapter 3', 1]
    ])
  })

  it('rejects an empty title at the contract boundary', async () => {
    await invoke('project:create', { name: 'Tree', format: 'novel', directory: tmp })
    const scene = (await invoke('tree:list', undefined)).find((r) => r.kind === 'document')
    await expect(invoke('tree:rename', { id: scene?.id ?? '', title: '   ' })).rejects.toThrowError(
      /^VALIDATION: /
    )
  })
})

describe('tree:move', () => {
  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('tree:move', { id: 'x', parentId: 'y' })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
  })

  it('moves a chapter into another arc and tree:list shows both parents contiguous', async () => {
    await invoke('project:create', { name: 'Tree', format: 'webnovel', directory: tmp })
    const before = await invoke('tree:list', undefined)
    const manuscript = before.find((r) => r.sectionType === 'manuscript')
    const arc1 = before.find((r) => r.parentId === manuscript?.id && r.position === 0)
    const arc2 = before.find((r) => r.parentId === manuscript?.id && r.position === 1)
    const chapter3 = before.find((r) => r.parentId === arc1?.id && r.position === 2)
    const moved = await invoke('tree:move', {
      id: chapter3?.id ?? '',
      parentId: arc2?.id ?? '',
      afterId: null
    })
    expect(moved).toMatchObject({ id: chapter3?.id, parentId: arc2?.id, position: 0 })
    const after = await invoke('tree:list', undefined)
    expect(after).toHaveLength(17)
    // Each arc numbers its chapters 1–3, so assert by id rather than title.
    const ids = (parentId: string | undefined): [string | undefined, number][] =>
      after.filter((r) => r.parentId === parentId).map((r) => [r.id, r.position])
    const arc1Before = before.filter((r) => r.parentId === arc1?.id).map((r) => r.id)
    const arc2Before = before.filter((r) => r.parentId === arc2?.id).map((r) => r.id)
    expect(ids(arc1?.id)).toEqual([
      [arc1Before[0], 0],
      [arc1Before[1], 1]
    ])
    expect(ids(arc2?.id)).toEqual([
      [chapter3?.id, 0],
      [arc2Before[0], 1],
      [arc2Before[1], 2],
      [arc2Before[2], 3]
    ])
    expect(after.filter((r) => r.parentId === chapter3?.id)).toHaveLength(1)
  })

  it('reorders within the same parent when afterId is a later sibling', async () => {
    await invoke('project:create', { name: 'Tree', format: 'webnovel', directory: tmp })
    const before = await invoke('tree:list', undefined)
    const arc1 = before.find((r) => r.hierarchyLevel === 'part' && r.position === 0)
    const chapters = before.filter((r) => r.parentId === arc1?.id)
    const [c1, c2] = chapters
    await invoke('tree:move', { id: c1?.id ?? '', parentId: arc1?.id ?? '', afterId: c2?.id })
    const after = await invoke('tree:list', undefined)
    expect(after.filter((r) => r.parentId === arc1?.id).map((r) => [r.title, r.position])).toEqual([
      ['Chapter 2', 0],
      ['Chapter 1', 1],
      ['Chapter 3', 2]
    ])
  })

  it('rejects a cross-section move with VALIDATION', async () => {
    await invoke('project:create', { name: 'Tree', format: 'novel', directory: tmp })
    const before = await invoke('tree:list', undefined)
    const front = before.find((r) => r.sectionType === 'front')
    const doc = await invoke('tree:create', {
      parentId: front?.id ?? '',
      kind: 'document',
      hierarchyLevel: null
    })
    const chapter = before.find((r) => r.hierarchyLevel === 'chapter')
    await expect(
      invoke('tree:move', { id: doc.id, parentId: chapter?.id ?? '' })
    ).rejects.toThrowError(/^VALIDATION: Moves are restricted to within a section/)
  })
})

describe('document:get', () => {
  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('document:get', { id: 'x' })).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('returns null content for a seeded scene and refuses folders (F-3.1)', async () => {
    await invoke('project:create', { name: 'Doc', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
    const chapter = rows.find((r) => r.hierarchyLevel === 'chapter')
    expect(await invoke('document:get', { id: scene?.id ?? '' })).toEqual({
      id: scene?.id,
      content: null
    })
    await expect(invoke('document:get', { id: chapter?.id ?? '' })).rejects.toThrowError(
      /^VALIDATION: /
    )
    await expect(invoke('document:get', { id: 'missing' })).rejects.toThrowError(/^NOT_FOUND: /)
  })
})

describe('document:save', () => {
  const para = (text: string): Input<'document:save'>['content'] => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  })

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('document:save', { id: 'x', content: para('x') })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
  })

  it('saves a seeded scene so document:get and tree:list reflect it (F-3.2)', async () => {
    await invoke('project:create', { name: 'Doc', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
    const saved = await invoke('document:save', {
      id: scene?.id ?? '',
      content: para('The storm broke at dusk.')
    })
    expect(saved.wordCount).toBe(5)
    expect(typeof saved.modified).toBe('string')
    expect(await invoke('document:get', { id: scene?.id ?? '' })).toEqual({
      id: scene?.id,
      content: para('The storm broke at dusk.')
    })
    const listed = (await invoke('tree:list', undefined)).find((r) => r.id === scene?.id)
    expect(listed).toMatchObject({ wordCount: 5, modified: saved.modified })
  })

  it('refuses folders with VALIDATION and unknown ids with NOT_FOUND', async () => {
    await invoke('project:create', { name: 'Doc', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const chapter = rows.find((r) => r.hierarchyLevel === 'chapter')
    await expect(
      invoke('document:save', { id: chapter?.id ?? '', content: para('x') })
    ).rejects.toThrowError(/^VALIDATION: /)
    await expect(
      invoke('document:save', { id: 'missing', content: para('x') })
    ).rejects.toThrowError(/^NOT_FOUND: /)
  })

  it('rejects content that is not a Tiptap document at the contract boundary', async () => {
    await invoke('project:create', { name: 'Doc', format: 'novel', directory: tmp })
    const scene = (await invoke('tree:list', undefined)).find((r) => r.kind === 'document')
    const raw = handlerFor('document:save')
    const result = await raw(undefined, { id: scene?.id, content: { content: [] } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
  })
})

describe('window:close', () => {
  it('closes the project and every window', async () => {
    await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    expect(manager.current()).not.toBeNull()
    await invoke('window:close', undefined)
    expect(manager.current()).toBeNull()
    expect(fakeWin.close).toHaveBeenCalledTimes(1)
    expect(fakeWin.webContents.send).toHaveBeenLastCalledWith('project:changed', null)
  })

  it('closes the windows even when no project is open', async () => {
    await invoke('window:close', undefined)
    expect(fakeWin.close).toHaveBeenCalledTimes(1)
  })

  it('skips windows that are already destroyed', async () => {
    fakeWin.isDestroyed = () => true
    await invoke('window:close', undefined)
    expect(fakeWin.close).not.toHaveBeenCalled()
  })
})
