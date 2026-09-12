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
import { defaultEditorSettings } from '@shared/editorSettings'
import { defaultLayout } from '@shared/layout'
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
let onCloseCancelled: ReturnType<typeof vi.fn<() => void>>

const dialogs: ProjectDialogs = {
  chooseProjectSavePath: async () => null,
  chooseProjectToOpen: async () => null
}

beforeEach(() => {
  vi.mocked(ipcMain.handle).mockClear()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-handlers-'))
  manager = new ProjectManager()
  fakeWin = { close: vi.fn(), isDestroyed: () => false, webContents: { send: vi.fn() } }
  onCloseCancelled = vi.fn<() => void>()
  registerHandlers({
    manager,
    appState: new AppStateStore(path.join(tmp, 'userData', 'app-state.json')),
    dialogs,
    windows: () => [fakeWin],
    onCloseCancelled
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

  it('rejects an unknown template id at the contract boundary and fills a known one (F-2.6)', async () => {
    await invoke('project:create', { name: 'Tree', format: 'novel', directory: tmp })
    const front = (await invoke('tree:list', undefined)).find((r) => r.sectionType === 'front')
    const raw = handlerFor('tree:create')
    const result = await raw(undefined, {
      parentId: front?.id,
      kind: 'document',
      hierarchyLevel: null,
      template: 'colophon'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    const created = await invoke('tree:create', {
      parentId: front?.id ?? '',
      kind: 'document',
      hierarchyLevel: null,
      template: 'title-page'
    })
    expect(created).toMatchObject({ title: 'Title Page', matterType: 'title-page', position: 0 })
    expect(created.wordCount).toBeGreaterThan(0)
    const doc = await invoke('document:get', { id: created.id })
    expect(doc.content?.type).toBe('doc')
    const listed = (await invoke('tree:list', undefined)).find((r) => r.id === created.id)
    expect(listed).toMatchObject({ matterType: 'title-page', wordCount: created.wordCount })
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

describe('notes:get / notes:save', () => {
  const para = (text: string): Input<'notes:save'>['notes'] => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  })

  it('reports NO_PROJECT for both when nothing is open', async () => {
    await expect(invoke('notes:get', { id: 'x' })).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('notes:save', { id: 'x', notes: para('x') })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
  })

  it('round-trips folder notes and leaves the document content alone (F-3.7)', async () => {
    await invoke('project:create', { name: 'Notes', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const chapter = rows.find((r) => r.hierarchyLevel === 'chapter')
    expect(await invoke('notes:get', { id: chapter?.id ?? '' })).toEqual({
      id: chapter?.id,
      notes: null
    })
    const saved = await invoke('notes:save', { id: chapter?.id ?? '', notes: para('Chapter goal') })
    expect(typeof saved.modified).toBe('string')
    expect(await invoke('notes:get', { id: chapter?.id ?? '' })).toEqual({
      id: chapter?.id,
      notes: para('Chapter goal')
    })
    const listed = (await invoke('tree:list', undefined)).find((r) => r.id === chapter?.id)
    expect(listed).toMatchObject({ wordCount: 0, modified: saved.modified })
    await expect(invoke('document:get', { id: chapter?.id ?? '' })).rejects.toThrowError(
      /^VALIDATION: /
    )
  })

  it('refuses section roots with VALIDATION and unknown ids with NOT_FOUND', async () => {
    await invoke('project:create', { name: 'Notes', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const manuscript = rows.find((r) => r.sectionType === 'manuscript')
    await expect(invoke('notes:get', { id: manuscript?.id ?? '' })).rejects.toThrowError(
      /^VALIDATION: /
    )
    await expect(
      invoke('notes:save', { id: manuscript?.id ?? '', notes: para('x') })
    ).rejects.toThrowError(/^VALIDATION: /)
    await expect(invoke('notes:get', { id: 'missing' })).rejects.toThrowError(/^NOT_FOUND: /)
  })
})

describe('editorSettings:get / editorSettings:set', () => {
  it('reports NO_PROJECT for both when nothing is open', async () => {
    await expect(invoke('editorSettings:get', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('editorSettings:set', defaultEditorSettings('novel'))).rejects.toThrowError(
      /^NO_PROJECT: /
    )
  })

  it("returns the seeded defaults for the project's format (F-3.6)", async () => {
    await invoke('project:create', { name: 'Serial', format: 'webnovel', directory: tmp })
    expect(await invoke('editorSettings:get', undefined)).toEqual(defaultEditorSettings('webnovel'))
  })

  it('persists a change so get returns it, also after a reopen', async () => {
    const created = await invoke('project:create', { name: 'Fmt', format: 'novel', directory: tmp })
    const next = {
      ...defaultEditorSettings('novel'),
      fontSize: 20,
      maxWidth: 900,
      sceneBreak: '###'
    }
    expect(await invoke('editorSettings:set', next)).toEqual(next)
    expect(await invoke('editorSettings:get', undefined)).toEqual(next)
    await invoke('project:close', undefined)
    await invoke('project:open', { path: created?.path ?? '' })
    expect(await invoke('editorSettings:get', undefined)).toEqual(next)
  })

  it('refuses out-of-range values with VALIDATION and keeps the stored value', async () => {
    await invoke('project:create', { name: 'Fmt', format: 'novel', directory: tmp })
    const raw = handlerFor('editorSettings:set')
    const result = await raw(undefined, { ...defaultEditorSettings('novel'), fontSize: 40 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    expect(await invoke('editorSettings:get', undefined)).toEqual(defaultEditorSettings('novel'))
  })
})

describe('layout:get / layout:set (F-7.2)', () => {
  it('returns the default layout before anything is saved, with no project needed', async () => {
    expect(await invoke('layout:get', undefined)).toEqual(defaultLayout())
  })

  it('persists a layout so get returns it, also from a fresh store over the same file', async () => {
    const next = {
      sidebar: { open: false, size: 0.3, tab: 'manuscript' as const },
      notes: { open: true, size: 0.4 }
    }
    expect(await invoke('layout:set', next)).toEqual(next)
    expect(await invoke('layout:get', undefined)).toEqual(next)
    const reread = new AppStateStore(path.join(tmp, 'userData', 'app-state.json')).get()
    expect(reread.layout).toEqual(next)
    expect(reread.recents).toEqual([])
  })

  it('refuses out-of-range or malformed layouts with VALIDATION and keeps the stored one', async () => {
    const stored = {
      sidebar: { open: true, size: 0.2, tab: 'manuscript' as const },
      notes: { open: false, size: 0.25 }
    }
    await invoke('layout:set', stored)
    const raw = handlerFor('layout:set')
    for (const bad of [
      { ...stored, sidebar: { open: true, size: 0.5, tab: 'manuscript' as const } },
      { ...stored, notes: { open: true, size: 0.1 } },
      { sidebar: { open: true, size: 0.2, tab: 'manuscript' as const } },
      { ...stored, sidebar: { open: 'yes', size: 0.2 } },
      null
    ]) {
      const result = await raw(undefined, bad)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    }
    expect(await invoke('layout:get', undefined)).toEqual(stored)
  })

  it('keeps the recents when the layout changes and vice versa', async () => {
    const created = await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    const next = {
      sidebar: { open: true, size: 0.3, tab: 'manuscript' as const },
      notes: { open: true, size: 0.3 }
    }
    await invoke('layout:set', next)
    const list = await invoke('recents:list', undefined)
    expect(list.map((r) => r.path)).toEqual([created?.path])
    await invoke('recents:remove', { path: created?.path ?? '' })
    expect(await invoke('layout:get', undefined)).toEqual(next)
  })

  // The spec's "editor keeps at least 30 %" is enforced jointly here, not only by the renderer's
  // clampForEditorMin: each size may be in range while both together squeeze the editor.
  it('refuses a layout that leaves the editor under its minimum even if each panel is individually in range', async () => {
    const bothMaxed = {
      sidebar: { open: true, size: 0.35, tab: 'manuscript' as const },
      notes: { open: true, size: 0.5 }
    }
    const raw = handlerFor('layout:set')
    const result = await raw(undefined, bothMaxed)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    // A closed panel does not count.
    const notesClosed = { ...bothMaxed, notes: { open: false, size: 0.5 } }
    expect(await invoke('layout:set', notesClosed)).toEqual(notesClosed)
  })

  it('layout:get normalizes an over-wide layout from a hand-edited app-state file', async () => {
    const file = path.join(tmp, 'userData', 'app-state.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        recents: [],
        layout: {
          sidebar: { open: true, size: 0.35, tab: 'manuscript' as const },
          notes: { open: true, size: 0.5 }
        }
      })
    )
    const got = await invoke('layout:get', undefined)
    expect(got.sidebar.size).toBe(0.35)
    expect(got.notes.size).toBeCloseTo(0.35, 9)
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

describe('window:close-cancelled (F-8.3)', () => {
  it('tells main the close was abandoned and leaves the project and windows alone', async () => {
    await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    expect(await invoke('window:close-cancelled', undefined)).toBeNull()
    expect(onCloseCancelled).toHaveBeenCalledTimes(1)
    expect(manager.current()).not.toBeNull()
    expect(fakeWin.close).not.toHaveBeenCalled()
  })
})
