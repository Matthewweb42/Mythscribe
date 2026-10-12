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
import { normName } from '@shared/memory/names'
import {
  labelFromTag,
  pageFromLines,
  recordFromTag,
  textParagraphs
} from '@shared/memory/switchoverMapping'
import type { StoryMemoryVersion } from '@shared/storyMemory'
import { LABELS_MAX } from '@shared/storyLabels'
import { createEntity } from '../entity/entityStore'
import { assignLabel, createLabel } from '../memory/labelStore'
import { insertConvertedRecord } from '../memory/recordStore'
import { AppError } from '../ipc/errors'
import { addDocumentTag } from '../tag/documentTagStore'
import { findTagByName, importTagBank } from '../tag/tagStore'
import { insertNodes, listNodes, type TreeDb } from '../tree/treeStore'
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
  /** Story memory v1: the tags and sheets made (0 in v2). */
  tags: number
  entities: number
  /** Story memory v2 (F-16.15): the records and labels made instead (0 in v1). */
  records: number
  labels: number
}

type BuildCounts = Omit<LegacyConversion, 'folder' | 'backup'>

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

/**
 * `memory` is the story memory the new project runs (F-16.15): v1 imports the tag bank, its
 * links and the references as sheets; v2 makes records and labels of them through the
 * switch-over's mapping (`recordFromTag`, `labelFromTag`), and writes no tag rows.
 */
export function convertLegacyProject(
  location: LegacyLocation,
  now: Date,
  memory: StoryMemoryVersion
): LegacyConversion {
  const data = readLegacy(location)
  const temp = path.join(
    path.dirname(location.source),
    `.${path.basename(location.source)}.converting-${randomUUID().slice(0, 8)}`
  )
  let counts: BuildCounts
  try {
    counts = buildProject(temp, data, now, memory)
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
  now: Date,
  memory: StoryMemoryVersion
): BuildCounts {
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
    if (memory === 'v2') {
      const made = db.transaction((tx) => buildMemoryV2(tx, data, plan.ids, now))
      return { documents: plan.rows.length, tags: 0, entities: 0, ...made }
    }

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
    return { documents: plan.rows.length, tags, entities, records: 0, labels: 0 }
  } finally {
    session.close()
  }
}

/**
 * Story memory v2 (F-16.15): the v0 tags and references as records and labels, through the same
 * mapping as the switch-over. A name tag (character, setting, world building) or a plot thread
 * becomes a record; a reference becomes one too, its page as Pinned paragraphs, and a tag of the
 * same name merges into it (the reference spells the name; one of the tag's category first).
 * References are one per name within a category, as v1's sheets are: a character and a place may
 * share a name, and then it is shared on both, as the switch-over marks it. Tone, content and
 * custom tags become labels on the documents v0 linked them to.
 */
function buildMemoryV2(
  db: TreeDb,
  data: LegacyData,
  ids: ReadonlyMap<string, string>,
  now: Date
): { records: number; labels: number } {
  interface Planned {
    name: string
    categoryId: string
    aliases: string[]
    pinned: string[]
  }
  const records: Planned[] = []
  const inCategory = (categoryId: string, name: string): string =>
    `${categoryId}\u0000${normName(name)}`
  const byKey = new Map<string, Planned>()
  const byNorm = new Map<string, Planned>()
  const add = (planned: Planned): void => {
    records.push(planned)
    byKey.set(inCategory(planned.categoryId, planned.name), planned)
    if (!byNorm.has(normName(planned.name))) byNorm.set(normName(planned.name), planned)
  }
  for (const reference of data.references) {
    const categoryId = ENTITY_KIND_OF[reference.category]
    const name = reference.name.trim().slice(0, ENTITY_NAME_MAX)
    if (categoryId === undefined || name === '' || byKey.has(inCategory(categoryId, name))) continue
    add({
      name,
      categoryId,
      aliases: [],
      pinned: textParagraphs(slateToText(reference.content).slice(0, ENTITY_BODY_MAX))
    })
  }
  const labelTags: { id: string; label: NonNullable<ReturnType<typeof labelFromTag>> }[] = []
  const seenLabels = new Set<string>()
  for (const tag of data.tags) {
    const category = TAG_CATEGORY_OF[tag.category ?? ''] ?? 'custom'
    const kebab = toTagName(tag.name).slice(0, TAG_NAME_MAX)
    const fromTag = recordFromTag({ name: kebab, category, aliases: [] })
    if (fromTag !== null) {
      const known =
        byKey.get(inCategory(fromTag.categoryId, fromTag.name)) ??
        byNorm.get(normName(fromTag.name))
      if (known === undefined) add({ ...fromTag, pinned: [] })
      continue
    }
    // A label keeps the author's own spelling of the v0 tag ("Grim"), a record its name's words.
    const label = labelFromTag({ name: tag.name.trim(), category, color: tag.color })
    if (label === null || seenLabels.has(label.name.toLowerCase())) continue
    seenLabels.add(label.name.toLowerCase())
    labelTags.push({ id: tag.id, label })
  }
  const holders = new Map<string, number>()
  for (const planned of records) {
    for (const norm of new Set([planned.name, ...planned.aliases].map(normName))) {
      holders.set(norm, (holders.get(norm) ?? 0) + 1)
    }
  }
  const shared = (text: string): boolean => (holders.get(normName(text)) ?? 0) > 1
  for (const planned of records) {
    insertConvertedRecord(
      db,
      {
        name: planned.name,
        categoryId: planned.categoryId,
        image: null,
        aliases: planned.aliases.map((text) => ({ text, shared: shared(text) })),
        mainShared: shared(planned.name),
        pinned: pageFromLines(planned.pinned.map((text) => ({ text }))),
        ideas: null,
        legacyEntityId: null,
        legacyTagId: null
      },
      now
    )
  }
  let labels = 0
  for (const { id, label } of labelTags.slice(0, LABELS_MAX)) {
    const made = createLabel(db, label, now)
    labels += 1
    const nodes = new Set(
      data.links.flatMap((link) => (link.tag_id === id ? (ids.get(link.document_id) ?? []) : []))
    )
    for (const nodeId of nodes) assignLabel(db, made.id, nodeId)
  }
  return { records: records.length, labels }
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
