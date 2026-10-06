import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { EditorSettings, defaultEditorSettings } from '@shared/editorSettings'
import { ENTITY_BODY_MAX, ENTITY_NAME_MAX, type EntityKind } from '@shared/entities'
import { NovelFormat } from '@shared/ipc/contract'
import type { TagExchangeRecord } from '@shared/tagExchange'
import {
  DEFAULT_CATEGORY_COLOR,
  HEX_COLOR,
  TAG_NAME_MAX,
  toTagName,
  type TagCategory
} from '@shared/tags'
import { createEntity } from '../entity/entityStore'
import { AppError } from '../ipc/errors'
import { addDocumentTag } from '../tag/documentTagStore'
import { findTagByName, importTagBank } from '../tag/tagStore'
import { insertNodes, listNodes } from '../tree/treeStore'
import { slateToText } from './legacySlate'
import { planLegacyTree, type LegacyDocument, type SectionIds } from './legacyTree'
import { createProject, PROJECT_EXTENSION } from './projectStore'
import { setEditorSettings } from './settingsStore'

/**
 * Converting a v0 project (F-1.6). v0 kept a project either as one SQLite file `Name.mythscribe`
 * or as a folder `Name.mythscribe/` holding `project.db`; `locateProject` tells either apart from a
 * v1 folder. Nothing is converted in place and nothing is deleted:
 *
 * 1. the v0 database is read read-only;
 * 2. a v1 project is built in a hidden sibling folder: the document tree (`planLegacyTree`), the
 *    editor settings, the tag bank with its document links, and v0's reference pages as entity
 *    pages (blank template, the text as the page);
 * 3. only then is the original renamed to `Name (v0 backup YYYY-MM-DD).mythscribe` and the new
 *    folder moved to the original path, so recents and the author's habits keep working. If the
 *    second rename fails, the first is undone.
 *
 * Scene summaries (the AI writes them again), background images, v0 tag templates, and AI
 * presets stay in the backup.
 */

export interface LegacyLocation {
  /** What the author opened: the v0 file, or the v0 folder. */
  source: string
  dbFile: string
}

export interface LegacyConversion {
  /** The converted v1 project folder (the original path). */
  folder: string
  /** Where the untouched original now lives. */
  backup: string
  documents: number
  tags: number
  entities: number
}

interface LegacyData {
  name: string
  format: NovelFormat
  documents: LegacyDocument[]
  settings: Map<string, string>
  tags: {
    id: string
    name: string
    category: string | null
    parent_tag_id: string | null
    color: string
  }[]
  links: { document_id: string; tag_id: string }[]
  references: { name: string; category: string; content: string }[]
}

const TAG_CATEGORY_OF: Record<string, TagCategory> = {
  character: 'character',
  setting: 'setting',
  worldBuilding: 'worldBuilding',
  tone: 'tone',
  content: 'content',
  'plot-thread': 'plotThread',
  custom: 'custom'
}
const ENTITY_KIND_OF: Record<string, EntityKind> = {
  character: 'character',
  setting: 'setting',
  worldBuilding: 'world'
}

/** The name the original is kept under; ` 2`, ` 3` … when that name is taken. */
export function legacyBackupPath(source: string, now: Date): string {
  const dir = path.dirname(source)
  const base = path.basename(source)
  const stem = base.toLowerCase().endsWith(PROJECT_EXTENSION)
    ? base.slice(0, -PROJECT_EXTENSION.length)
    : base
  const day = now.toISOString().slice(0, 10)
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : ` ${n}`
    const candidate = path.join(dir, `${stem} (v0 backup ${day}${suffix})${PROJECT_EXTENSION}`)
    if (!fs.existsSync(candidate)) return candidate
  }
}

export function convertLegacyProject(
  location: LegacyLocation,
  now: Date = new Date()
): LegacyConversion {
  const data = readLegacy(location)
  const temp = path.join(
    path.dirname(location.source),
    `.${path.basename(location.source)}.converting-${randomUUID().slice(0, 8)}`
  )
  let counts: { documents: number; tags: number; entities: number }
  try {
    counts = buildProject(temp, data, now)
  } catch (err) {
    fs.rmSync(temp, { recursive: true, force: true })
    throw err
  }

  const backup = legacyBackupPath(location.source, now)
  const isFile = fs.statSync(location.source).isFile()
  const sidecars = isFile
    ? ['-wal', '-shm'].filter((suffix) => fs.existsSync(`${location.source}${suffix}`))
    : []
  try {
    fs.renameSync(location.source, backup)
    for (const suffix of sidecars)
      fs.renameSync(`${location.source}${suffix}`, `${backup}${suffix}`)
  } catch (err) {
    fs.rmSync(temp, { recursive: true, force: true })
    throw new AppError('IO', `Could not set the original aside as a backup: ${describe(err)}`, {
      path: location.source
    })
  }
  try {
    fs.renameSync(temp, location.source)
  } catch (err) {
    // Put the original back where the author left it; the converted copy goes.
    fs.renameSync(backup, location.source)
    for (const suffix of sidecars)
      fs.renameSync(`${backup}${suffix}`, `${location.source}${suffix}`)
    fs.rmSync(temp, { recursive: true, force: true })
    throw new AppError('IO', `Could not move the converted project into place: ${describe(err)}`, {
      path: location.source
    })
  }
  return { folder: location.source, backup, ...counts }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Everything the conversion needs from the v0 file, read-only; missing tables read as empty. */
function readLegacy(location: LegacyLocation): LegacyData {
  let db: Database.Database | null = null
  try {
    db = new Database(location.dbFile, { readonly: true, fileMustExist: true })
    const tables = new Set(
      db
        .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name)
    )
    const source = db
    const all = <T>(table: string, sql: string): T[] =>
      tables.has(table) ? source.prepare<[], T>(sql).all() : []

    const project = all<{ name?: string; novel_format?: string }>(
      'project',
      'SELECT * FROM project LIMIT 1'
    )[0]
    const fallbackName = path
      .basename(location.source)
      .replace(new RegExp(`${PROJECT_EXTENSION.replace('.', '\\.')}$`, 'i'), '')
    return {
      name: (project?.name ?? '').trim() || fallbackName || 'Imported project',
      format: NovelFormat.safeParse(project?.novel_format).data ?? 'novel',
      documents: all<Partial<LegacyDocument> & { id: string }>(
        'documents',
        'SELECT * FROM documents'
      ).map(normalizeDocument),
      settings: new Map(
        all<{ key: string; value: string }>('settings', 'SELECT key, value FROM settings').map(
          (row) => [row.key, row.value]
        )
      ),
      tags: all('tags', 'SELECT id, name, category, parent_tag_id, color FROM tags'),
      links: all('document_tags', 'SELECT document_id, tag_id FROM document_tags'),
      references: all('reference_docs', 'SELECT name, category, content FROM reference_docs')
    }
  } catch (err) {
    if (err instanceof AppError) throw err
    throw new AppError('IO', `Could not read the v0 project: ${describe(err)}`, {
      path: location.source
    })
  } finally {
    db?.close()
  }
}

/** A v0 row from any v0 version: columns added by later v0 migrations may be missing. */
function normalizeDocument(row: Partial<LegacyDocument> & { id: string }): LegacyDocument {
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
  return {
    id: row.id,
    parent_id: text(row.parent_id),
    name: text(row.name) ?? 'Untitled',
    type: text(row.type) ?? 'document',
    content: text(row.content),
    doc_type: text(row.doc_type),
    hierarchy_level: text(row.hierarchy_level),
    notes: text(row.notes),
    position: typeof row.position === 'number' ? row.position : 0,
    location: text(row.location),
    pov: text(row.pov),
    timeline_position: text(row.timeline_position),
    section: text(row.section),
    matter_type: text(row.matter_type),
    created: text(row.created) ?? '',
    modified: text(row.modified) ?? ''
  }
}

function buildProject(
  folder: string,
  data: LegacyData,
  now: Date
): { documents: number; tags: number; entities: number } {
  const session = createProject(folder, data.name, data.format, { skeleton: false })
  try {
    const db = session.connection.orm
    const roots = listNodes(db).filter((row) => row.parentId === null)
    const sectionId = (type: 'front' | 'manuscript' | 'end'): string => {
      const id = roots.find((row) => row.sectionType === type)?.id
      if (id === undefined) throw new AppError('IO', 'The new project has no sections')
      return id
    }
    const sections: SectionIds = {
      front: sectionId('front'),
      manuscript: sectionId('manuscript'),
      end: sectionId('end')
    }
    const plan = planLegacyTree(data.documents, sections, now.toISOString())
    db.transaction((tx) => insertNodes(tx, plan.rows))

    setEditorSettings(db, legacyEditorSettings(data.settings, data.format))

    const tags = importTagBank(db, legacyTagRecords(data.tags)).created.length
    const tagIdOf = new Map<string, string>()
    for (const tag of data.tags) {
      const id = findTagByName(db, toTagName(tag.name))
      if (id !== undefined) tagIdOf.set(tag.id, id)
    }
    for (const link of data.links) {
      const nodeId = plan.ids.get(link.document_id)
      const tagId = tagIdOf.get(link.tag_id)
      if (nodeId === undefined || tagId === undefined) continue
      try {
        addDocumentTag(db, nodeId, tagId)
      } catch {
        // A link to a folder or a section is not one v1 keeps; the tag itself was imported.
      }
    }

    let entities = 0
    for (const reference of data.references) {
      const kind = ENTITY_KIND_OF[reference.category]
      const name = reference.name.trim().slice(0, ENTITY_NAME_MAX)
      if (kind === undefined || name === '') continue
      const body = slateToText(reference.content).slice(0, ENTITY_BODY_MAX)
      try {
        createEntity(db, { kind, name, template: 'blank', body: body === '' ? null : body })
        entities += 1
      } catch {
        // Two v0 references with one name: the first is kept, the rest stay in the backup.
      }
    }
    return { documents: plan.rows.length, tags, entities }
  } finally {
    session.close()
  }
}

/** v0's `editor_*` settings over the format's defaults, each kept only when v1 accepts it. */
export function legacyEditorSettings(
  settings: ReadonlyMap<string, string>,
  format: NovelFormat
): EditorSettings {
  const base = defaultEditorSettings(format)
  const number = (key: string): number | undefined => {
    const value = Number.parseFloat(settings.get(key) ?? '')
    return Number.isFinite(value) ? value : undefined
  }
  const candidate = {
    ...base,
    fontSize: number('editor_text_size') ?? base.fontSize,
    lineHeight: number('editor_line_height') ?? base.lineHeight,
    paragraphSpacing: number('editor_paragraph_spacing') ?? base.paragraphSpacing,
    paragraphIndent: number('editor_paragraph_indent') ?? base.paragraphIndent,
    maxWidth: number('editor_max_width') ?? base.maxWidth,
    sceneBreak: settings.get('editor_scene_break_style')?.trim() ?? base.sceneBreak
  }
  // Field by field, so one out-of-range value falls back alone instead of losing the rest.
  const kept = { ...base }
  for (const key of Object.keys(base) as (keyof EditorSettings)[]) {
    const trial = EditorSettings.safeParse({ ...kept, [key]: candidate[key] })
    if (trial.success) Object.assign(kept, trial.data)
  }
  return kept
}

/** v0 tags as tag-bank records (F-4.9): kebab names, v1 categories, valid colors, parents by name. */
export function legacyTagRecords(tags: LegacyData['tags']): TagExchangeRecord[] {
  const nameOf = new Map(tags.map((tag) => [tag.id, toTagName(tag.name).slice(0, TAG_NAME_MAX)]))
  return tags.flatMap((tag) => {
    const name = nameOf.get(tag.id) ?? ''
    if (name === '') return []
    const category = TAG_CATEGORY_OF[tag.category ?? ''] ?? 'custom'
    const color = tag.color.toLowerCase()
    return [
      {
        name,
        category,
        color: HEX_COLOR.test(color) ? color : DEFAULT_CATEGORY_COLOR[category],
        parent: tag.parent_tag_id === null ? null : (nameOf.get(tag.parent_tag_id) ?? null),
        trackMentions: true
      }
    ]
  })
}
