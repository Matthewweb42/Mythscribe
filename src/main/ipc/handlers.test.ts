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
  type Output,
  type Tag
} from '@shared/ipc/contract'
import { z } from 'zod'
import { DEFAULT_MODELS } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import { builtinParams, defaultWritingPresets } from '@shared/presets'
import { defaultEditorSettings } from '@shared/editorSettings'
import { defaultLayout } from '@shared/layout'
import { EMPTY_SCENE_META } from '@shared/sceneMeta'
import { DEFAULT_CATEGORY_COLOR } from '@shared/tags'
import { TAG_TEMPLATES } from '@shared/tagTemplates'
import { AiKeyStore } from '../ai/keyStore'
import { fakeSafeStorage } from '../ai/keyStoreFixture'
import {
  AiProviderError,
  InvalidKeyError,
  type CompletionRequest,
  type CompletionResult,
  type Provider
} from '../ai/providers/types'
import { AiProviderRegistry } from '../ai/registry'
import { insertUsage } from '../ai/usageStore'
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
let safe: ReturnType<typeof fakeSafeStorage>
let keyFile: string
/** What the fake provider's `testConnection` does; the registry builds it for any saved key. */
let testConnection: ReturnType<typeof vi.fn<() => Promise<{ model: string }>>>
/** What the fake provider's `complete` answers (F-4.7); tests replace it per case. */
let complete: ReturnType<typeof vi.fn<(request: CompletionRequest) => Promise<CompletionResult>>>

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
  safe = fakeSafeStorage()
  keyFile = path.join(tmp, 'userData', 'ai-keys.json')
  const keyStore = new AiKeyStore(keyFile, safe, 'win32')
  testConnection = vi.fn<() => Promise<{ model: string }>>(() =>
    Promise.resolve({ model: 'gpt-fake' })
  )
  complete = vi.fn<(request: CompletionRequest) => Promise<CompletionResult>>(() =>
    Promise.resolve({
      text: '{"tags":["dark-forest","protagonist"]}',
      model: 'gpt-fake',
      usage: { inputTokens: 40, outputTokens: 10 }
    })
  )
  const provider: Provider = {
    id: 'openai',
    resolveModel: () => 'gpt-fake',
    complete,
    stream: async function* () {},
    testConnection
  }
  const appState = new AppStateStore(path.join(tmp, 'userData', 'app-state.json'))
  registerHandlers({
    manager,
    appState,
    keyStore,
    ai: new AiProviderRegistry(
      keyStore,
      () => appState.get().models,
      () => provider
    ),
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

describe('sceneMeta:get / sceneMeta:set (F-4.5)', () => {
  const filled = { location: 'dark-forest', pov: 'mara', timeline: 'Day 3, after the storm' }

  it('reports NO_PROJECT for both when nothing is open', async () => {
    await expect(invoke('sceneMeta:get', { id: 'x' })).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('sceneMeta:set', { id: 'x', meta: filled })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
  })

  it('round-trips scene and chapter metadata and stamps modified', async () => {
    await invoke('project:create', { name: 'Meta', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.hierarchyLevel === 'scene')
    const chapter = rows.find((r) => r.hierarchyLevel === 'chapter')
    expect(await invoke('sceneMeta:get', { id: scene?.id ?? '' })).toEqual({
      id: scene?.id,
      meta: EMPTY_SCENE_META
    })
    const saved = await invoke('sceneMeta:set', { id: scene?.id ?? '', meta: filled })
    expect(typeof saved.modified).toBe('string')
    expect(await invoke('sceneMeta:get', { id: scene?.id ?? '' })).toEqual({
      id: scene?.id,
      meta: filled
    })
    await invoke('sceneMeta:set', {
      id: chapter?.id ?? '',
      meta: { ...EMPTY_SCENE_META, location: 'the coast' }
    })
    expect((await invoke('sceneMeta:get', { id: chapter?.id ?? '' })).meta).toEqual({
      ...EMPTY_SCENE_META,
      location: 'the coast'
    })
    const listed = (await invoke('tree:list', undefined)).find((r) => r.id === scene?.id)
    expect(listed).toMatchObject({ modified: saved.modified })
  })

  it('surfaces VALIDATION for section roots and over-length fields, NOT_FOUND for unknown ids', async () => {
    await invoke('project:create', { name: 'Meta', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const manuscript = rows.find((r) => r.sectionType === 'manuscript')
    const scene = rows.find((r) => r.hierarchyLevel === 'scene')
    await expect(invoke('sceneMeta:get', { id: manuscript?.id ?? '' })).rejects.toThrowError(
      /^VALIDATION: /
    )
    await expect(
      invoke('sceneMeta:set', { id: manuscript?.id ?? '', meta: filled })
    ).rejects.toThrowError(/^VALIDATION: /)
    await expect(invoke('sceneMeta:get', { id: 'missing' })).rejects.toThrowError(/^NOT_FOUND: /)
    const raw = handlerFor('sceneMeta:set')
    const result = await raw(undefined, {
      id: scene?.id,
      meta: { ...filled, location: 'x'.repeat(201) }
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    expect((await invoke('sceneMeta:get', { id: scene?.id ?? '' })).meta).toEqual(EMPTY_SCENE_META)
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

describe('aiSettings:get / aiSettings:set (F-14.4)', () => {
  it('reports NO_PROJECT for both when nothing is open', async () => {
    await expect(invoke('aiSettings:get', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('aiSettings:set', defaultAiSettings())).rejects.toThrowError(
      /^NO_PROJECT: /
    )
  })

  it('answers the defaults (dial Off) for a new project, then what set wrote, also after a reopen', async () => {
    const created = await invoke('project:create', {
      name: 'Dial',
      format: 'novel',
      directory: tmp
    })
    expect(await invoke('aiSettings:get', undefined)).toEqual(defaultAiSettings())
    const next = {
      ...defaultAiSettings(),
      dial: 2 as const,
      features: { ...defaultAiSettings().features, ghostText: false }
    }
    expect(await invoke('aiSettings:set', next)).toEqual(next)
    expect(await invoke('aiSettings:get', undefined)).toEqual(next)
    await invoke('project:close', undefined)
    await invoke('project:open', { path: created?.path ?? '' })
    expect(await invoke('aiSettings:get', undefined)).toEqual(next)
  })

  it('refuses a dial outside 0–3 with VALIDATION and keeps the stored value', async () => {
    await invoke('project:create', { name: 'Dial', format: 'novel', directory: tmp })
    const raw = handlerFor('aiSettings:set')
    const result = await raw(undefined, { ...defaultAiSettings(), dial: 4 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    expect(await invoke('aiSettings:get', undefined)).toEqual(defaultAiSettings())
  })
})

describe('presets:get / presets:set (F-5.2)', () => {
  it('reports NO_PROJECT for both when nothing is open', async () => {
    await expect(invoke('presets:get', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('presets:set', defaultWritingPresets())).rejects.toThrowError(
      /^NO_PROJECT: /
    )
  })

  it('answers the defaults (General) for a new project, then what set wrote, also after a reopen', async () => {
    const created = await invoke('project:create', {
      name: 'Presets',
      format: 'novel',
      directory: tmp
    })
    expect(await invoke('presets:get', undefined)).toEqual(defaultWritingPresets())
    const next = {
      active: 'custom' as const,
      custom: { ...builtinParams('dialogue'), styleInstruction: 'Keep it clipped.' }
    }
    expect(await invoke('presets:set', next)).toEqual(next)
    expect(await invoke('presets:get', undefined)).toEqual(next)
    await invoke('project:close', undefined)
    await invoke('project:open', { path: created?.path ?? '' })
    expect(await invoke('presets:get', undefined)).toEqual(next)
  })

  it('refuses a temperature outside 0–1.5 with VALIDATION and keeps the stored value', async () => {
    await invoke('project:create', { name: 'Presets', format: 'novel', directory: tmp })
    const raw = handlerFor('presets:set')
    const defaults = defaultWritingPresets()
    const result = await raw(undefined, {
      ...defaults,
      custom: { ...defaults.custom, temperature: 4 }
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    expect(await invoke('presets:get', undefined)).toEqual(defaults)
  })
})

describe('tag handlers (F-4.1)', () => {
  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('tag:list', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('tag:create', { name: 'x', category: 'custom' })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
  })

  it('creates a tag that tag:list then shows with the category color and no usage', async () => {
    await invoke('project:create', { name: 'Tags', format: 'novel', directory: tmp })
    const created = await invoke('tag:create', { name: 'Dark Forest', category: 'setting' })
    expect(created).toMatchObject({
      name: 'dark-forest',
      category: 'setting',
      color: DEFAULT_CATEGORY_COLOR.setting,
      parentId: null,
      usageCount: 0
    })
    expect(await invoke('tag:list', undefined)).toEqual([created])
  })

  it('recolors and renames through tag:update and removes through tag:delete', async () => {
    await invoke('project:create', { name: 'Tags', format: 'novel', directory: tmp })
    const created = await invoke('tag:create', { name: 'Rain', category: 'tone' })
    const updated = await invoke('tag:update', {
      id: created.id,
      color: '#112233',
      name: 'Heavy Rain'
    })
    expect(updated).toMatchObject({ id: created.id, color: '#112233', name: 'heavy-rain' })
    expect((await invoke('tag:list', undefined)).map((t) => t.name)).toEqual(['heavy-rain'])
    expect(await invoke('tag:delete', { id: created.id })).toBeNull()
    expect(await invoke('tag:list', undefined)).toEqual([])
  })

  it('survives a reopen', async () => {
    const project = await invoke('project:create', {
      name: 'Tags',
      format: 'novel',
      directory: tmp
    })
    const created = await invoke('tag:create', { name: 'Rain', category: 'tone' })
    await invoke('project:close', undefined)
    await invoke('project:open', { path: project?.path ?? '' })
    expect(await invoke('tag:list', undefined)).toEqual([created])
  })

  it('surfaces VALIDATION, ALREADY_EXISTS, and NOT_FOUND through the envelope', async () => {
    await invoke('project:create', { name: 'Tags', format: 'novel', directory: tmp })
    await invoke('tag:create', { name: 'Rain', category: 'tone' })
    await expect(invoke('tag:create', { name: '—', category: 'tone' })).rejects.toThrowError(
      /^VALIDATION: /
    )
    await expect(invoke('tag:create', { name: 'rain!', category: 'custom' })).rejects.toThrowError(
      /^ALREADY_EXISTS: /
    )
    await expect(invoke('tag:update', { id: 'missing', color: '#000000' })).rejects.toThrowError(
      /^NOT_FOUND: /
    )
    await expect(invoke('tag:delete', { id: 'missing' })).rejects.toThrowError(/^NOT_FOUND: /)
    // Contract boundary: a bad color or category never reaches the store.
    const raw = handlerFor('tag:create')
    for (const bad of [
      { name: 'x', category: 'tone', color: '#FFF' },
      { name: 'x', category: 'plot-thread' },
      { name: '   ', category: 'tone' }
    ]) {
      const result = await raw(undefined, bad)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    }
    expect((await invoke('tag:list', undefined)).map((t) => t.name)).toEqual(['rain'])
  })
})

describe('tag:loadTemplate (F-4.3)', () => {
  const standard = TAG_TEMPLATES.find((t) => t.id === 'standard-fiction')!

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('tag:loadTemplate', { template: 'fantasy' })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
  })

  it('creates the template tags once, then skips them all on a reload', async () => {
    await invoke('project:create', { name: 'Tags', format: 'novel', directory: tmp })
    const first = await invoke('tag:loadTemplate', { template: 'standard-fiction' })
    expect(first.skipped).toEqual([])
    expect(first.created).toHaveLength(standard.tags.length)
    expect(first.created[0]).toMatchObject({
      name: 'protagonist',
      category: 'character',
      color: DEFAULT_CATEGORY_COLOR.character,
      usageCount: 0
    })
    expect(await invoke('tag:list', undefined)).toHaveLength(standard.tags.length)

    const again = await invoke('tag:loadTemplate', { template: 'standard-fiction' })
    expect(again.created).toEqual([])
    expect(again.skipped).toEqual(standard.tags.map((t) => t.name))
    expect(await invoke('tag:list', undefined)).toHaveLength(standard.tags.length)

    // Contract boundary: an unknown template id never reaches the store.
    const result = await handlerFor('tag:loadTemplate')(undefined, { template: 'western' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
  })
})

describe('documentTag handlers (F-4.4)', () => {
  /** The first seeded scene's id and the id of its chapter (a folder). */
  async function seeded(): Promise<{ scene: string; folder: string; section: string }> {
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
    const folder = rows.find((r) => r.kind === 'folder' && r.sectionType === null)
    const section = rows.find((r) => r.sectionType !== null)
    if (!scene || !folder || !section) throw new Error('skeleton not seeded')
    return { scene: scene.id, folder: folder.id, section: section.id }
  }

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('documentTag:list', { nodeId: 'x' })).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('documentTag:add', { nodeId: 'x', tagId: 'y' })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
    await expect(invoke('documentTag:remove', { nodeId: 'x', tagId: 'y' })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
  })

  it('links and unlinks a tag, moving the usage count tag:list reports, idempotently', async () => {
    await invoke('project:create', { name: 'Tags', format: 'novel', directory: tmp })
    const { scene } = await seeded()
    const rain = await invoke('tag:create', { name: 'Rain', category: 'tone' })
    expect(await invoke('documentTag:list', { nodeId: scene })).toEqual([])
    const linked = await invoke('documentTag:add', { nodeId: scene, tagId: rain.id })
    expect(linked).toEqual({ ...rain, usageCount: 1 })
    expect(await invoke('documentTag:add', { nodeId: scene, tagId: rain.id })).toEqual(linked)
    expect(await invoke('documentTag:list', { nodeId: scene })).toEqual([linked])
    expect(await invoke('tag:list', undefined)).toEqual([linked])
    const unlinked = await invoke('documentTag:remove', { nodeId: scene, tagId: rain.id })
    expect(unlinked).toEqual({ ...rain, usageCount: 0 })
    expect(await invoke('documentTag:remove', { nodeId: scene, tagId: rain.id })).toEqual(unlinked)
    expect(await invoke('documentTag:list', { nodeId: scene })).toEqual([])
    expect(await invoke('tag:list', undefined)).toEqual([unlinked])
  })

  it('links a tag to a folder too (a chapter carries tags, F-4.5)', async () => {
    await invoke('project:create', { name: 'Tags', format: 'novel', directory: tmp })
    const { folder } = await seeded()
    const rain = await invoke('tag:create', { name: 'Rain', category: 'tone' })
    expect(await invoke('documentTag:list', { nodeId: folder })).toEqual([])
    expect(await invoke('documentTag:add', { nodeId: folder, tagId: rain.id })).toEqual({
      ...rain,
      usageCount: 1
    })
    expect(await invoke('documentTag:list', { nodeId: folder })).toEqual([
      { ...rain, usageCount: 1 }
    ])
  })

  it('surfaces NOT_FOUND and VALIDATION through the envelope', async () => {
    await invoke('project:create', { name: 'Tags', format: 'novel', directory: tmp })
    const { scene, section } = await seeded()
    const rain = await invoke('tag:create', { name: 'Rain', category: 'tone' })
    await expect(invoke('documentTag:list', { nodeId: 'missing' })).rejects.toThrowError(
      /^NOT_FOUND: /
    )
    await expect(invoke('documentTag:list', { nodeId: section })).rejects.toThrowError(
      /^VALIDATION: /
    )
    await expect(
      invoke('documentTag:add', { nodeId: section, tagId: rain.id })
    ).rejects.toThrowError(/^VALIDATION: /)
    await expect(
      invoke('documentTag:add', { nodeId: scene, tagId: 'missing' })
    ).rejects.toThrowError(/^NOT_FOUND: /)
    await expect(
      invoke('documentTag:remove', { nodeId: scene, tagId: 'missing' })
    ).rejects.toThrowError(/^NOT_FOUND: /)
    expect(await invoke('tag:list', undefined)).toEqual([rain])
  })
})

describe('layout:get / layout:set (F-7.2)', () => {
  it('returns the default layout before anything is saved, with no project needed', async () => {
    expect(await invoke('layout:get', undefined)).toEqual(defaultLayout())
  })

  it('persists a layout so get returns it, also from a fresh store over the same file', async () => {
    const next = {
      sidebar: { open: false, size: 0.3, tab: 'manuscript' as const },
      notes: { open: true, size: 0.4 },
      tagBar: { open: true, height: 120, split: 0.4 }
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
      notes: { open: false, size: 0.25 },
      tagBar: { open: true, height: 120, split: 0.4 }
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
      notes: { open: true, size: 0.3 },
      tagBar: { open: true, height: 120, split: 0.4 }
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
      notes: { open: true, size: 0.5 },
      tagBar: { open: true, height: 120, split: 0.4 }
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
          notes: { open: true, size: 0.5 },
          tagBar: { open: true, height: 120, split: 0.4 }
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

describe('ai handlers (F-5.1)', () => {
  const KEY = 'sk-test-secret-1234abcd'

  it('reports no key and the encryption kind before anything is saved', async () => {
    expect(await invoke('ai:getStatus', undefined)).toEqual({
      provider: 'openai',
      hasKey: false,
      hint: null,
      encryption: 'os',
      models: DEFAULT_MODELS
    })
  })

  it('stores a key, answers with a mask only, and never returns the key', async () => {
    const status = await invoke('ai:setKey', { key: `  ${KEY}  ` })
    expect(status).toEqual({
      provider: 'openai',
      hasKey: true,
      hint: 'sk-…abcd',
      encryption: 'os',
      models: DEFAULT_MODELS
    })
    expect(JSON.stringify(status)).not.toContain(KEY)
    expect(await invoke('ai:getStatus', undefined)).toEqual(status)
    expect(fs.readFileSync(keyFile, 'utf8')).not.toContain(KEY)
    expect(safe.encrypted).toEqual([KEY])
  })

  it('refuses a key outside the length bounds with VALIDATION', async () => {
    const result = await handlerFor('ai:setKey')(undefined, { key: 'short' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    expect(safe.encrypted).toEqual([])
  })

  it('refuses to store a key with IO when safe storage is unavailable', async () => {
    safe.isEncryptionAvailable = () => false
    expect(await invoke('ai:getStatus', undefined)).toMatchObject({ encryption: 'none' })
    const result = await handlerFor('ai:setKey')(undefined, { key: KEY })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('IO')
      expect(result.error.message).not.toContain(KEY)
    }
    expect(fs.existsSync(keyFile)).toBe(false)
  })

  it('clears the key and reports no key again', async () => {
    await invoke('ai:setKey', { key: KEY })
    expect(await invoke('ai:clearKey', undefined)).toMatchObject({ hasKey: false, hint: null })
    expect(await invoke('ai:getStatus', undefined)).toMatchObject({ hasKey: false })
  })

  it('answers NO_KEY as data without asking the provider when no key is saved', async () => {
    expect(await invoke('ai:testConnection', undefined)).toEqual({
      ok: false,
      code: 'NO_KEY',
      message: 'No API key is saved.',
      nextStep: 'Add a key above and save it.'
    })
    expect(testConnection).not.toHaveBeenCalled()
  })

  it('answers with the model on success and an expected failure as data with its next step', async () => {
    await invoke('ai:setKey', { key: KEY })
    expect(await invoke('ai:testConnection', undefined)).toEqual({ ok: true, model: 'gpt-fake' })

    testConnection.mockRejectedValueOnce(new InvalidKeyError('OpenAI rejected the API key.'))
    expect(await invoke('ai:testConnection', undefined)).toEqual({
      ok: false,
      code: 'INVALID_KEY',
      message: 'OpenAI rejected the API key.',
      nextStep: 'Check the key and try again.'
    })
  })

  it('lets an unexpected failure reach the error envelope', async () => {
    await invoke('ai:setKey', { key: KEY })
    testConnection.mockRejectedValueOnce(new TypeError('boom'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await handlerFor('ai:testConnection')(undefined, undefined)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INTERNAL')
    vi.restoreAllMocks()
    expect(new InvalidKeyError('x')).toBeInstanceOf(AiProviderError)
  })
})

describe('ai:recommendTags (F-4.7)', () => {
  const KEY = 'sk-test-secret-1234abcd'
  const LONG = 'The storm broke at dusk over the dark forest, and Mara counted the lightning gaps.'

  /** A project with a scene of enough text, the dial at Ask, and two bank tags. */
  async function ready(): Promise<{ scene: string; folder: string; forest: Tag; hero: Tag }> {
    await invoke('project:create', { name: 'Rec', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
    const folder = rows.find((r) => r.kind === 'folder' && r.sectionType === null)
    if (!scene || !folder) throw new Error('skeleton not seeded')
    await invoke('document:save', {
      id: scene.id,
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: LONG }] }]
      }
    })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1 })
    const forest = await invoke('tag:create', { name: 'Dark Forest', category: 'setting' })
    const hero = await invoke('tag:create', { name: 'Protagonist', category: 'character' })
    return { scene: scene.id, folder: folder.id, forest, hero }
  }

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('ai:recommendTags', { nodeId: 'x' })).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('answers the unlinked bank tags the model named, with the cost, and logs one ledger row', async () => {
    const { scene, forest, hero } = await ready()
    await invoke('ai:setKey', { key: KEY })
    await invoke('documentTag:add', { nodeId: scene, tagId: forest.id })
    const result = await invoke('ai:recommendTags', { nodeId: scene })
    expect(result).toEqual({
      ok: true,
      suggestions: [hero],
      usage: { inputTokens: 40, outputTokens: 10 },
      costUsd: 0,
      cached: false,
      model: 'gpt-fake',
      promptVersion: 'tags.v1'
    })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete.mock.calls[0]![0]).toMatchObject({ tier: 'fast', json: true, maxTokens: 200 })
    expect((await invoke('ai:usageSummary', undefined)).total.requests).toBe(1)
    // Nothing was linked by the suggestion itself.
    expect(await invoke('documentTag:list', { nodeId: scene })).toEqual([
      { ...forest, usageCount: 1 }
    ])
  })

  it('answers each expected AI failure as data with its next step', async () => {
    const { scene } = await ready()
    expect(await invoke('ai:recommendTags', { nodeId: scene })).toEqual({
      ok: false,
      code: 'NO_KEY',
      message: 'No API key is saved.',
      nextStep: 'Add a key above and save it.'
    })
    await invoke('ai:setKey', { key: KEY })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 0 })
    expect(await invoke('ai:recommendTags', { nodeId: scene })).toEqual({
      ok: false,
      code: 'DISABLED',
      message: 'Tag suggestions needs the AI dial at Ask or higher (it is at Off).',
      nextStep: 'Turn the AI dial up in Settings, or enable the feature there.'
    })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1 })
    complete.mockRejectedValueOnce(new InvalidKeyError('OpenAI rejected the API key.'))
    expect(await invoke('ai:recommendTags', { nodeId: scene })).toEqual({
      ok: false,
      code: 'INVALID_KEY',
      message: 'OpenAI rejected the API key.',
      nextStep: 'Check the key and try again.'
    })
    // A provider failure writes nothing, so the next call reaches the provider again.
    complete.mockResolvedValueOnce({
      text: 'not json',
      model: 'gpt-fake',
      usage: { inputTokens: 1, outputTokens: 1 }
    })
    expect(await invoke('ai:recommendTags', { nodeId: scene })).toEqual({
      ok: false,
      code: 'PROVIDER',
      message: 'The model did not answer in the expected format.',
      nextStep: 'Try again in a moment.'
    })
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('lets a folder and an unknown id reach the error envelope as VALIDATION and NOT_FOUND', async () => {
    const { folder } = await ready()
    const onFolder = await handlerFor('ai:recommendTags')(undefined, { nodeId: folder })
    expect(onFolder.ok).toBe(false)
    if (!onFolder.ok) expect(onFolder.error.code).toBe('VALIDATION')
    const unknown = await handlerFor('ai:recommendTags')(undefined, { nodeId: 'nope' })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.code).toBe('NOT_FOUND')
    expect(complete).not.toHaveBeenCalled()
  })
})

describe('ai:ghostText (F-5.3)', () => {
  const KEY = 'sk-test-secret-1234abcd'
  const BEFORE = 'The storm broke at dusk over the dark forest. Mara counted the lightning gaps.'

  /** A project with the dial at Suggest and a scene to continue. */
  async function ready(): Promise<{ scene: string }> {
    await invoke('project:create', { name: 'Ghost', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
    if (!scene) throw new Error('skeleton not seeded')
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 2 })
    complete.mockResolvedValue({
      text: 'Somewhere ahead the river was rising.',
      model: 'gpt-fake',
      usage: { inputTokens: 120, outputTokens: 12 }
    })
    return { scene: scene.id }
  }

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(
      invoke('ai:ghostText', { nodeId: 'x', before: 'a', after: '', requestId: '1' })
    ).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('answers the continuation with the cost and the echoed requestId, and logs one ledger row', async () => {
    const { scene } = await ready()
    await invoke('ai:setKey', { key: KEY })
    const result = await invoke('ai:ghostText', {
      nodeId: scene,
      before: BEFORE,
      after: '',
      requestId: 'req-7'
    })
    expect(result).toEqual({
      ok: true,
      text: ' Somewhere ahead the river was rising.',
      usage: { inputTokens: 120, outputTokens: 12 },
      costUsd: 0,
      cached: false,
      model: 'gpt-fake',
      requestId: 'req-7'
    })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete.mock.calls[0]![0]).toMatchObject({ tier: 'fast', maxTokens: 40 })
    const summary = await invoke('ai:usageSummary', undefined)
    expect(summary.total.requests).toBe(1)
    expect(summary.byFeature.map((f) => f.feature)).toEqual(['ghostText'])
  })

  it('answers each expected AI failure as data with its next step and the requestId', async () => {
    const { scene } = await ready()
    const input = { nodeId: scene, before: BEFORE, after: '', requestId: 'req-8' }
    expect(await invoke('ai:ghostText', input)).toEqual({
      ok: false,
      code: 'NO_KEY',
      message: 'No API key is saved.',
      nextStep: 'Add a key above and save it.',
      requestId: 'req-8'
    })
    await invoke('ai:setKey', { key: KEY })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1 })
    expect(await invoke('ai:ghostText', input)).toEqual({
      ok: false,
      code: 'DISABLED',
      message: 'Ghost text needs the AI dial at Suggest or higher (it is at Ask).',
      nextStep: 'Turn the AI dial up in Settings, or enable the feature there.',
      requestId: 'req-8'
    })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 2 })
    complete.mockRejectedValueOnce(new InvalidKeyError('OpenAI rejected the API key.'))
    expect(await invoke('ai:ghostText', input)).toEqual({
      ok: false,
      code: 'INVALID_KEY',
      message: 'OpenAI rejected the API key.',
      nextStep: 'Check the key and try again.',
      requestId: 'req-8'
    })
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('lets an unknown id and an over-long window reach the error envelope as NOT_FOUND and VALIDATION', async () => {
    await ready()
    const unknown = await handlerFor('ai:ghostText')(undefined, {
      nodeId: 'nope',
      before: BEFORE,
      after: '',
      requestId: '1'
    })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.code).toBe('NOT_FOUND')
    const long = await handlerFor('ai:ghostText')(undefined, {
      nodeId: 'nope',
      before: 'x'.repeat(501),
      after: '',
      requestId: '1'
    })
    expect(long.ok).toBe(false)
    if (!long.ok) expect(long.error.code).toBe('VALIDATION')
    expect(complete).not.toHaveBeenCalled()
  })
})

describe('ai:usageSummary / ai:setDailyCap (F-5.14)', () => {
  const zero = { requests: 0, tokens: 0, costUsd: 0 }

  it('needs an open project', async () => {
    await expect(invoke('ai:usageSummary', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('answers the default cap and an empty ledger for a fresh project', async () => {
    await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    expect(await invoke('ai:usageSummary', undefined)).toEqual({
      today: zero,
      total: zero,
      byFeature: [],
      dailyCapUsd: 2
    })
  })

  it('sums the project ledger per feature and reports the app-wide day from app state', async () => {
    await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    const row = {
      at: '2026-09-12T10:00:00.000Z',
      tier: 'fast' as const,
      model: 'gpt-5.4-mini',
      provider: 'openai' as const,
      promptTokens: 100,
      completionTokens: 20,
      cached: false,
      contextHash: 'ctx'
    }
    insertUsage(manager.require().connection.orm, { ...row, feature: 'tags', costUsd: 0.001 })
    insertUsage(manager.require().connection.orm, { ...row, feature: 'summary', costUsd: 0.002 })
    const summary = await invoke('ai:usageSummary', undefined)
    expect(summary.byFeature.map((f) => f.feature)).toEqual(['summary', 'tags'])
    expect(summary.total).toMatchObject({ requests: 2, tokens: 240 })
    expect(summary.total.costUsd).toBeCloseTo(0.003, 8)
    // The day is app-wide: nothing in this project's ledger moves it.
    expect(summary.today).toEqual(zero)
  })

  it('persists a new cap, answers the summary with it, and refuses one outside 0–500', async () => {
    await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    expect((await invoke('ai:setDailyCap', { dailyCapUsd: 5 })).dailyCapUsd).toBe(5)
    expect((await invoke('ai:usageSummary', undefined)).dailyCapUsd).toBe(5)
    const file = path.join(tmp, 'userData', 'app-state.json')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      aiUsage: { dailyCapUsd: 5 }
    })
    for (const dailyCapUsd of [-1, 500.5]) {
      const result = await handlerFor('ai:setDailyCap')(undefined, { dailyCapUsd })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    }
    expect((await invoke('ai:usageSummary', undefined)).dailyCapUsd).toBe(5)
  })
})

describe('ai:setModels (F-5.11)', () => {
  const models = { fast: 'gpt-5.4-nano', strong: 'gpt-5.4-pro' }

  it('persists the mapping, trimmed, and a fresh status carries it', async () => {
    const status = await invoke('ai:setModels', {
      provider: 'openai',
      models: { fast: ' gpt-5.4-nano ', strong: 'gpt-5.4-pro' }
    })
    expect(status.models).toEqual(models)
    expect(await invoke('ai:getStatus', undefined)).toMatchObject({ models })
    const file = path.join(tmp, 'userData', 'app-state.json')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ models: { openai: models } })
  })

  it('refuses an empty or over-long model id with VALIDATION and keeps the stored mapping', async () => {
    await invoke('ai:setModels', { provider: 'openai', models })
    for (const fast of ['', '   ', 'x'.repeat(101)]) {
      const result = await handlerFor('ai:setModels')(undefined, {
        provider: 'openai',
        models: { fast, strong: 'gpt-5.4' }
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    }
    expect(await invoke('ai:getStatus', undefined)).toMatchObject({ models })
  })
})

describe('voice handlers (F-14.1)', () => {
  const PASSAGE =
    'Mara turned from the window and looked at the ridge, where the storm had settled for the ' +
    'night. She knew she was tired, and she thought about the river and what it wanted from her.'
  const para = (text: string): Input<'document:save'>['content'] => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  })

  /** A project with its first scene's id. */
  async function ready(name = 'Voice'): Promise<string> {
    await invoke('project:create', { name, format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
    if (!scene) throw new Error('skeleton not seeded')
    return scene.id
  }

  it('reports NO_PROJECT for all four when nothing is open', async () => {
    await expect(invoke('voice:listExemplars', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('voice:addExemplar', { nodeId: 'x', text: PASSAGE })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
    await expect(invoke('voice:removeExemplar', { id: 'x' })).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('voice:profile', {})).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('adds, lists, and removes exemplars; the profile carries them and follows document saves', async () => {
    const scene = await ready()
    await invoke('sceneMeta:set', { id: scene, meta: { location: '', pov: 'Mara', timeline: '' } })
    const added = await invoke('voice:addExemplar', { nodeId: scene, text: `  ${PASSAGE}  ` })
    expect(added).toMatchObject({ nodeId: scene, text: PASSAGE, pov: 'Mara', kind: 'mixed' })
    expect(await invoke('voice:listExemplars', undefined)).toEqual([added])
    const empty = await invoke('voice:profile', {})
    expect(empty).toMatchObject({ rules: [], exemplars: [added], wordCount: 0, confidence: 0 })
    await invoke('document:save', { id: scene, content: para(PASSAGE) })
    const saved = await invoke('voice:profile', { pov: 'Mara' })
    expect(saved.wordCount).toBeGreaterThan(0)
    expect(saved.confidence).toBeGreaterThan(0)
    expect(await invoke('voice:removeExemplar', { id: added.id })).toBeNull()
    expect(await invoke('voice:listExemplars', undefined)).toEqual([])
    expect((await invoke('voice:profile', {})).exemplars).toEqual([])
  })

  it('lets a short text, an unknown node, and an unknown id reach the envelope as VALIDATION and NOT_FOUND', async () => {
    const scene = await ready()
    const short = await handlerFor('voice:addExemplar')(undefined, { nodeId: scene, text: 'short' })
    expect(short.ok).toBe(false)
    if (!short.ok) expect(short.error.code).toBe('VALIDATION')
    const unknown = await handlerFor('voice:addExemplar')(undefined, {
      nodeId: 'nope',
      text: PASSAGE
    })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.code).toBe('NOT_FOUND')
    const gone = await handlerFor('voice:removeExemplar')(undefined, { id: 'nope' })
    expect(gone.ok).toBe(false)
    if (!gone.ok) expect(gone.error.code).toBe('NOT_FOUND')
    expect(await invoke('voice:listExemplars', undefined)).toEqual([])
  })

  it('never serves the profile of a previous project', async () => {
    const scene = await ready('First')
    await invoke('voice:addExemplar', { nodeId: scene, text: PASSAGE })
    expect((await invoke('voice:profile', {})).exemplars).toHaveLength(1)
    await invoke('project:close', undefined)
    await ready('Second')
    expect((await invoke('voice:profile', {})).exemplars).toEqual([])
  })
})
