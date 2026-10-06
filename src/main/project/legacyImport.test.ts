import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import type { TiptapNodeT } from '@shared/tiptap'
import { listEntities } from '../entity/entityStore'
import { listAllDocumentTags } from '../tag/documentTagStore'
import { listTags } from '../tag/tagStore'
import { listNodes } from '../tree/treeStore'
import { V0_SCENE_TEXT, writeV0Project } from './legacyFixture'
import { convertLegacyProject, legacyBackupPath, legacyEditorSettings } from './legacyImport'
import { locateProject, openProject, type ProjectSession } from './projectStore'
import { getEditorSettings } from './settingsStore'

let tmp: string
let session: ProjectSession | null = null
const NOW = new Date('2026-10-06T12:00:00.000Z')

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-legacy-'))
})

afterEach(() => {
  session?.close()
  session = null
  fs.rmSync(tmp, { recursive: true, force: true })
})

function convert(input: string): ReturnType<typeof convertLegacyProject> {
  const location = locateProject(input)
  if (location.kind !== 'legacy') throw new Error('expected a v0 project')
  return convertLegacyProject(location, NOW)
}

const text = (doc: TiptapNodeT): string =>
  doc.text ?? (doc.content ?? []).map(text).join(doc.type === 'doc' ? '\n' : '')

describe('convertLegacyProject (F-1.6)', () => {
  it('converts a v0 single-file project in place and keeps the original as a backup', () => {
    const file = path.join(tmp, 'Ferryman.mythscribe')
    writeV0Project(file)
    const original = fs.readFileSync(file)

    const result = convert(file)
    expect(result.folder).toBe(file)
    expect(result.backup).toBe(path.join(tmp, 'Ferryman (v0 backup 2026-10-06).mythscribe'))
    expect(fs.readFileSync(result.backup)).toEqual(original)
    expect(fs.statSync(file).isDirectory()).toBe(true)
    expect(fs.readdirSync(tmp).filter((name) => name.includes('converting'))).toEqual([])

    session = openProject(file)
    expect(session.info).toMatchObject({ name: 'Ferryman', format: 'epic' })
    const rows = listNodes(session.connection.orm)
    const byTitle = (title: string): (typeof rows)[number] => {
      const row = rows.find((r) => r.title === title)
      if (!row) throw new Error(`no ${title}`)
      return row
    }
    const manuscript = rows.find((r) => r.sectionType === 'manuscript')!
    const front = rows.find((r) => r.sectionType === 'front')!
    const end = rows.find((r) => r.sectionType === 'end')!
    expect(byTitle('Part One')).toMatchObject({
      parentId: manuscript.id,
      hierarchyLevel: 'part',
      kind: 'folder'
    })
    const chapter = byTitle('The River')
    expect(chapter).toMatchObject({ parentId: byTitle('Part One').id, hierarchyLevel: 'chapter' })
    // v0's order (position) is kept and renumbered.
    expect(rows.filter((r) => r.parentId === chapter.id).map((r) => [r.title, r.position])).toEqual(
      [
        ['Landing', 0],
        ['Crossing', 1]
      ]
    )
    expect(byTitle('Title Page')).toMatchObject({ parentId: front.id, matterType: 'title-page' })
    const notesFolder = byTitle('Notes')
    expect(notesFolder.parentId).toBe(end.id)
    expect(byTitle('Research').parentId).toBe(notesFolder.id)

    const landing = byTitle('Landing')
    const content = JSON.parse(landing.content ?? 'null') as TiptapNodeT
    expect(content.content?.map((node) => node.type)).toEqual([
      'heading',
      'paragraph',
      'sceneBreak',
      'blockquote'
    ])
    expect(text(content)).toContain(V0_SCENE_TEXT)
    expect(landing.wordCount).toBe(1 + 10 + 3)
    expect(JSON.parse(landing.notes ?? 'null')).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Remember the bell.' }] }]
    })
    expect(parseStoredSceneMeta(landing.sceneMeta)).toMatchObject({
      location: 'The landing',
      pov: 'Mara',
      timeline: 'Day 1'
    })

    const db = session.connection.orm
    expect(getEditorSettings(db, 'epic')).toMatchObject({ fontSize: 18, sceneBreak: '~~~' })
    const tags = listTags(db)
    // v0's three tags, plus the tag a new setting entity gets (F-9.4); Mara's entity takes the
    // imported `mara` tag rather than making a second one.
    expect(tags.map((t) => [t.name, t.category])).toEqual([
      ['mara', 'character'],
      ['the-debt', 'plotThread'],
      ['the-landing', 'setting'],
      ['young-mara', 'character']
    ])
    expect(tags.find((t) => t.name === 'mara')?.color).toBe('#aa0000')
    expect(tags.find((t) => t.name === 'young-mara')?.parentId).toBe(
      tags.find((t) => t.name === 'mara')?.id
    )
    // The scene's link comes across; a link to a missing document does not.
    expect(listAllDocumentTags(db).get(landing.id)).toContain('mara')

    const entities = listEntities(db)
    expect(entities.map((e) => [e.kind, e.name, e.template, e.body])).toEqual([
      ['character', 'Mara', 'blank', 'Grey eyes.\nAfraid of deep water.'],
      ['setting', 'The Landing', 'blank', 'A rotten jetty.']
    ])
    expect(result).toMatchObject({ tags: 3, entities: 2 })
  })

  it('converts a v0 folder project, picked by its project.db, and moves the whole folder aside', () => {
    const folder = path.join(tmp, 'Saga.mythscribe')
    writeV0Project(path.join(folder, 'project.db'), 'Saga')
    fs.mkdirSync(path.join(folder, 'assets', 'backgrounds'), { recursive: true })
    fs.writeFileSync(path.join(folder, 'assets', 'backgrounds', 'sea.png'), 'png')

    const result = convert(path.join(folder, 'project.db'))
    expect(result.folder).toBe(folder)
    expect(fs.existsSync(path.join(result.backup, 'assets', 'backgrounds', 'sea.png'))).toBe(true)
    expect(locateProject(folder)).toEqual({ kind: 'v1', folder })
    session = openProject(folder)
    expect(session.info.name).toBe('Saga')
  })

  it('names a second backup of the same day apart', () => {
    const file = path.join(tmp, 'Ferryman.mythscribe')
    fs.writeFileSync(path.join(tmp, 'Ferryman (v0 backup 2026-10-06).mythscribe'), 'older')
    expect(legacyBackupPath(file, NOW)).toBe(
      path.join(tmp, 'Ferryman (v0 backup 2026-10-06 2).mythscribe')
    )
  })

  it('leaves the original untouched when the v0 file cannot be read', () => {
    const file = path.join(tmp, 'Broken.mythscribe')
    writeV0Project(file)
    const original = fs.readFileSync(file)
    // A row the converter cannot place: a document name that is not text breaks nothing, but a
    // corrupt database does.
    expect(() =>
      convertLegacyProject({ source: file, dbFile: path.join(tmp, 'missing.db') }, NOW)
    ).toThrowError(/Could not read the v0 project/)
    expect(fs.readFileSync(file)).toEqual(original)
    expect(fs.readdirSync(tmp)).toEqual(['Broken.mythscribe'])
  })
})

describe('legacyEditorSettings (F-1.6)', () => {
  it('takes each v0 value v1 accepts and keeps the default for the rest', () => {
    const settings = legacyEditorSettings(
      new Map([
        ['editor_text_size', '20'],
        ['editor_line_height', '1.5'],
        ['editor_max_width', '5000'],
        ['editor_paragraph_indent', 'wide'],
        ['editor_scene_break_style', '   ']
      ]),
      'novel'
    )
    expect(settings).toMatchObject({ fontSize: 20, lineHeight: 1.5 })
    expect(settings.maxWidth).toBe(legacyEditorSettings(new Map(), 'novel').maxWidth)
    expect(settings.sceneBreak).toBe(legacyEditorSettings(new Map(), 'novel').sceneBreak)
  })
})
