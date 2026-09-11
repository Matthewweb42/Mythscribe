import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EDITOR_SETTINGS_KEY, EditorSettings } from '@shared/editorSettings'
import { eq } from 'drizzle-orm'
import { settings } from '../db/schema'
import { AppError } from '../ipc/errors'
import { listNodes } from '../tree/treeStore'
import {
  createProject,
  isProjectFolder,
  openProject,
  projectFolderFor,
  resolveProjectFolder,
  sanitizeName,
  type ProjectSession
} from './projectStore'

let tmp: string
const open: ProjectSession[] = []

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-'))
})
afterEach(() => {
  for (const s of open.splice(0)) s.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('naming', () => {
  it('sanitizes illegal characters and trailing dots', () => {
    expect(sanitizeName('  My: Novel?/Draft.. ')).toBe('My NovelDraft')
    expect(sanitizeName('tab\there')).toBe('tabhere')
    expect(sanitizeName('///')).toBe('Untitled')
  })
  it('builds the folder path with the extension', () => {
    expect(projectFolderFor('/docs', 'Book')).toBe(path.join('/docs', 'Book.mythscribe'))
  })
  it('resolves a project.db path to its folder', () => {
    expect(resolveProjectFolder('/x/Book.mythscribe/project.db')).toBe('/x/Book.mythscribe')
    expect(resolveProjectFolder('/x/Book.mythscribe')).toBe('/x/Book.mythscribe')
  })
})

describe('createProject', () => {
  it('creates the folder layout and the project row', () => {
    const folder = projectFolderFor(tmp, 'First Book')
    const session = createProject(folder, 'First Book', 'novel')
    open.push(session)
    expect(fs.existsSync(path.join(folder, 'project.db'))).toBe(true)
    expect(fs.existsSync(path.join(folder, 'assets'))).toBe(true)
    expect(isProjectFolder(folder)).toBe(true)
    expect(session.info).toMatchObject({ name: 'First Book', format: 'novel', path: folder })
    expect(session.info.schemaVersion).toBeGreaterThan(0)
  })

  it('refuses to create over an existing project or a non-empty folder', () => {
    const folder = projectFolderFor(tmp, 'Dup')
    open.push(createProject(folder, 'Dup', 'epic'))
    expect(() => createProject(folder, 'Dup', 'epic')).toThrow(AppError)
    const busy = path.join(tmp, 'busy.mythscribe')
    fs.mkdirSync(busy)
    fs.writeFileSync(path.join(busy, 'note.txt'), 'x')
    expect(() => createProject(busy, 'busy', 'novel')).toThrowError(/not empty/)
  })

  it('seeds the starter skeleton and editor settings for a novel (F-1.3)', () => {
    const session = createProject(projectFolderFor(tmp, 'Seeded'), 'Seeded', 'novel')
    open.push(session)
    const nodes = listNodes(session.connection.orm)
    expect(nodes).toHaveLength(17)
    expect(nodes.filter((n) => n.parentId === null).map((n) => n.sectionType)).toEqual([
      'front',
      'manuscript',
      'end'
    ])
    expect(nodes.map((n) => n.title)).toContain('Part 1')
    expect(editorSettings(session).sceneBreak).toBe('* * *')
  })

  it('seeds webnovel labels and defaults', () => {
    const session = createProject(projectFolderFor(tmp, 'Web'), 'Web', 'webnovel')
    open.push(session)
    const titles = listNodes(session.connection.orm).map((n) => n.title)
    expect(titles).toContain('Arc 1')
    expect(titles).toContain('Arc 2')
    expect(editorSettings(session).sceneBreak).toBe('~~~')
  })
})

function editorSettings(session: ProjectSession): EditorSettings {
  const row = session.connection.orm
    .select()
    .from(settings)
    .where(eq(settings.key, EDITOR_SETTINGS_KEY))
    .get()
  return EditorSettings.parse(JSON.parse(row?.value ?? ''))
}

describe('openProject', () => {
  it('reopens a created project and bumps lastOpened', async () => {
    const folder = projectFolderFor(tmp, 'Reopen')
    const first = createProject(folder, 'Reopen', 'webnovel')
    first.close()
    await new Promise((r) => setTimeout(r, 5))
    const second = openProject(folder)
    open.push(second)
    expect(second.info.id).toBe(first.info.id)
    expect(second.info.format).toBe('webnovel')
    expect(second.info.lastOpened > first.info.lastOpened).toBe(true)
  })

  it('keeps the seeded skeleton across close and reopen', () => {
    const folder = projectFolderFor(tmp, 'Keep')
    const first = createProject(folder, 'Keep', 'novel')
    const ids = listNodes(first.connection.orm).map((n) => n.id)
    first.close()
    const second = openProject(folder)
    open.push(second)
    const again = listNodes(second.connection.orm)
    expect(again).toHaveLength(17)
    expect(again.map((n) => n.id)).toEqual(ids)
  })

  it('accepts the project.db path', () => {
    const folder = projectFolderFor(tmp, 'ViaDb')
    createProject(folder, 'ViaDb', 'novel').close()
    const s = openProject(path.join(folder, 'project.db'))
    open.push(s)
    expect(s.info.path).toBe(folder)
  })

  it('reports NOT_FOUND for a folder without a project', () => {
    expect(() => openProject(path.join(tmp, 'nope'))).toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' })
    )
  })
})
