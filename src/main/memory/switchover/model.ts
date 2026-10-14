import { asc, sql } from 'drizzle-orm'
import { estimateTokens } from '@shared/ai'
import { parseAliases, aliasKey } from '@shared/aliases'
import { categoryOf, type StoryCategory } from '@shared/categories'
import { CHANGES_MAX, ChangeUndo, changeSourceOf, type ChangeSource } from '@shared/changes'
import type { ContextFileType } from '@shared/contextLibrary'
import { PROJECT_NOTES_NAME } from '@shared/contextLibrary'
import { docToText } from '@shared/docText'
import { parseEntityFields, toEntityNameKey } from '@shared/entities'
import { isFieldFact } from '@shared/facts'
import { passageParagraphs } from '@shared/mentions'
import {
  inlineTagSamples,
  inlineTagTokens,
  replaceInlineTags,
  tagNameAsWords
} from '@shared/memory/inlineTagReplace'
import { buildNameIndex, scanNames } from '@shared/memory/nameScan'
import { normName } from '@shared/memory/names'
import {
  defaultCaseRule,
  RECORD_ALIAS_MAX,
  RECORD_ALIASES_MAX,
  recordKindOf
} from '@shared/memory/records'
import { ALSO_HERE_MAX } from '@shared/memory/sceneDetails'
import type { SwitchoverItem, SwitchoverMerge } from '@shared/memory/switchover'
import {
  datedLine,
  FILED_BY_AI_HEADING,
  labelFromTag,
  pinnedFromFields,
  recordFromTag,
  recordNameFromTag,
  sceneReference,
  textParagraphs,
  type PageLine
} from '@shared/memory/switchoverMapping'
import { twinGate, twinPairs } from '@shared/memory/twinGate'
import { parseStoredSceneMeta, type SceneMeta } from '@shared/sceneMeta'
import { paragraphKey, pageEdits, sheetFieldDefs } from '@shared/sheetSync'
import { RELATION_LABEL, relationTypeOf } from '@shared/relations'
import { resolveTagId } from '@shared/tagExchange'
import { THREAD_EVENT_LABEL, threadEventOf } from '@shared/threads'
import { LABELS_MAX, type LabelKind } from '@shared/storyLabels'
import { readingOrderRows, type TimelineEvent } from '@shared/timeline'
import type { TagCategory } from '@shared/tags'
import type { TiptapNodeT } from '@shared/tiptap'
import {
  contextFile,
  documentTag,
  draftText,
  entity,
  fact,
  knowledgeChange,
  tag,
  type EntityRow,
  type NodeRow
} from '../../db/schema'
import { listCategories } from '../../entity/categoryStore'
import { paragraphHash, parseExtraFields, parseStoredSheetSync } from '../../entity/sheetSyncState'
import { researchOriginalIds } from '../../library/libraryStore'
import {
  getDismissedNames,
  getKeptSpellings,
  getObservedDismissed,
  getPlanLinkState,
  getProjectTimeline,
  getTagAliases
} from '../../project/settingsStore'
import { listNodes, type TreeDb } from '../../tree/treeStore'
import { documentJson, manuscriptDocuments } from '../../voice/profile'
import { sceneStatuses } from '../passageIndexer'

/**
 * The switch-over's model (F-16.15, plan P1 §6.2): everything the conversion will write, worked
 * out from the v1 tables without writing anything. The dry run (`planSwitchover`) reports it by
 * name; the conversion (`convertSwitchover`) builds it again inside its transaction, with the
 * author's replacements, and writes exactly it. Keys name the records-to-be across both:
 * `entity:<id>` for a sheet, `tag:<id>` for a tag without one, `pov:<name>` for a POV with
 * neither.
 */

/** The sources whose sheet writes count as the AI's (decision 8): never the background reading's. */
export const AI_WRITER_SOURCES: ReadonlySet<ChangeSource> = new Set([
  'library',
  'organise',
  'chat',
  'sync'
])

export interface PlannedRecord {
  key: string
  name: string
  categoryId: string
  image: string | null
  /** Other names, as spelled, never the main name's norm twice. */
  aliases: string[]
  legacyEntityId: string | null
  legacyTagId: string | null
  pinned: PageLine[]
  ideas: PageLine[]
  /** Sheet text the AI wrote: the "Filed by AI earlier: please check" block, Not canon. */
  filedByAi: string[]
  /** The page that block goes on: Pinned, or Ideas for a Plan or Idea sheet. */
  filedIn: 'pinned' | 'ideas'
  /** Where it comes from, for the dry run. */
  from: 'sheet' | 'tag' | 'pov'
  /** A sheet the AI made that the author added to (a dated line, a picture, a status). */
  aiSheet: boolean
  /** The v1 tag ids whose links and tokens mean this record. */
  tagIds: string[]
}

export interface PlannedLabel {
  tagId: string
  name: string
  kind: LabelKind
  colour: string
  nodeIds: string[]
}

export type PlannedResearch =
  | { kind: 'upload'; contextFileId: string; name: string; type: ContextFileType }
  | { kind: 'notes'; title: string; lines: PageLine[]; notCanon: boolean }

export interface PlannedDetails {
  nodeId: string
  povKey: string | null
  placeKey: string | null
  placeText: string
  timeText: string
  storyYear: number | null
  alsoHere: string[]
}

export type PlannedDismissal =
  | { kind: 'name'; name: string; label: string }
  | { kind: 'notSame'; a: string; b: string; label: string }
  | { kind: 'unlink'; planId: string; sceneId: string; nodeId: string | null; label: string }

/** One row of the consent screen with the stored token ids it covers. */
export interface InlineTagRow {
  key: string
  tag: string
  count: number
  sample: string
  replacement: string
  tokenIds: string[]
}

export interface SwitchoverModel {
  records: PlannedRecord[]
  /** Norms held by more than one record: shared on every holder (identity rule 4). */
  sharedNorms: Set<string>
  labels: PlannedLabel[]
  research: PlannedResearch[]
  details: PlannedDetails[]
  dismissals: PlannedDismissal[]
  merges: SwitchoverMerge[]
  inlineTags: InlineTagRow[]
  /** The stored token id → the words that replace it (the consent's, else the row's default). */
  tokenText: Map<string, string>
  kept: SwitchoverItem[]
  converted: SwitchoverItem[]
  dropped: SwitchoverItem[]
  notes: string[]
  /** Per manuscript scene the rebuild would read: its prose tokens (local estimate). */
  rebuildScenes: number[]
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** Scene numbers as a dated line names them: `chapter.scene` by reading order. */
function sceneNumbers(scenes: readonly NodeRow[]): Map<string, string> {
  const parents = new Map<string, { n: number; scenes: number }>()
  const out = new Map<string, string>()
  for (const scene of scenes) {
    const parent = scene.parentId ?? ''
    let at = parents.get(parent)
    if (at === undefined) {
      at = { n: parents.size + 1, scenes: 0 }
      parents.set(parent, at)
    }
    at.scenes += 1
    out.set(scene.id, `${at.n}.${at.scenes}`)
  }
  return out
}

/** The written Research note the timeline's events go to (P1-D8 hides the Timeline in v2). */
export const TIMELINE_NOTE_TITLE = 'Timeline'

/** One event as a line: `The flood (Spring, year 1820; scenes 1.1, 1.2): its note`. */
function timelineLine(event: TimelineEvent, scenes: readonly string[]): string {
  const when = [event.when.trim(), event.year === null ? '' : `year ${event.year}`]
    .filter((part) => part !== '')
    .join(', ')
  const linked =
    scenes.length === 0 ? '' : `${scenes.length === 1 ? 'scene' : 'scenes'} ${scenes.join(', ')}`
  const about = [when, linked].filter((part) => part !== '').join('; ')
  const head = about === '' ? event.label.trim() : `${event.label.trim()} (${about})`
  const note = event.note.trim()
  return note === '' ? head : `${head}: ${note}`
}

/** The text a stored column holds, read leniently (a broken cell reads as none). */
function storedDoc(raw: string | null): TiptapNodeT | null {
  return documentJson({ content: raw })
}

interface Texts {
  /** Every stored text the conversion rewrites: node contents and notes, inactive drafts. */
  docs: TiptapNodeT[]
}

function allTexts(db: TreeDb, rows: readonly NodeRow[]): Texts {
  const docs: TiptapNodeT[] = []
  for (const row of rows) {
    const content = storedDoc(row.content)
    if (content !== null) docs.push(content)
    const notes = storedDoc(row.notes)
    if (notes !== null) docs.push(notes)
  }
  for (const row of db.select({ content: draftText.content }).from(draftText).all()) {
    const doc = storedDoc(row.content)
    if (doc !== null) docs.push(doc)
  }
  return { docs }
}

interface TagRowLite {
  id: string
  name: string
  category: TagCategory
  color: string
  parentId: string | null
  origin: 'author' | 'ai'
  aliases: string[]
}

/**
 * The consent screen's rows: every distinct inline tag token, grouped by the tag it stands for
 * now (merges followed through `TagAliases`; a token of a deleted tag is its own row), in order of
 * first appearance, with its count over every text the conversion rewrites and a sample. The
 * replacement is the name of the record the tag becomes (its sheet's, or the tag's own as a
 * record names it: "Tomas" for #tomas), so the name scan finds it in the prose; a label tag, a
 * dropped tag and a deleted one get the tag name with hyphens as spaces (decided by Claude,
 * unconfirmed: QUESTIONS.md "P1 slice 6 review").
 */
function inlineTagRows(
  db: TreeDb,
  texts: Texts,
  tags: ReadonlyMap<string, TagRowLite>,
  recordNameOfTag: ReadonlyMap<string, string>
): InlineTagRow[] {
  const merges = getTagAliases(db)
  const rows = new Map<string, InlineTagRow>()
  for (const doc of texts.docs) {
    const tokens = inlineTagTokens(doc)
    if (tokens.length === 0) continue
    const samples = inlineTagSamples(doc)
    for (const token of tokens) {
      const resolved = resolveTagId(token.id, merges, (id) => tags.has(id))
      const held = tags.get(resolved)
      const key = held === undefined ? token.id : resolved
      let row = rows.get(key)
      if (row === undefined) {
        const name = held?.name ?? token.name
        row = {
          key,
          tag: `#${name}`,
          count: 0,
          sample: samples.get(token.id) ?? '',
          replacement: recordNameOfTag.get(key) ?? tagNameAsWords(name),
          tokenIds: []
        }
        rows.set(key, row)
      }
      row.count += 1
      if (!row.tokenIds.includes(token.id)) row.tokenIds.push(token.id)
    }
  }
  return [...rows.values()]
}

/** The library uploads the switch-over makes Research documents of: all but Research's own. */
export function plannedUploads(db: TreeDb): Extract<PlannedResearch, { kind: 'upload' }>[] {
  const originals = researchOriginalIds(db)
  return db
    .select()
    .from(contextFile)
    .orderBy(asc(contextFile.created), sql`rowid`)
    .all()
    .filter((row) => !originals.has(row.id))
    .map((row) => ({ kind: 'upload', contextFileId: row.id, name: row.name, type: row.type }))
}

/**
 * How long after an AI run's Changes row a sheet's `modified` stamp may move and still be that
 * run's write: sheet sync stamps its row before it asks the model and writes after the answer.
 */
export const AI_RUN_SLACK_MS = 5 * 60_000

/** Per entity, what the AI wrote that still stands (decision 8). */
interface AiWritten {
  /**
   * Per entity, per field: every paragraph (`paragraphKey`) an applied AI change added to that
   * field, across all of them. A paragraph the author has edited since has another key.
   */
  fields: Map<string, Map<string, Set<string>>>
  /** Per entity: every page paragraph (`paragraphKey`) an applied AI change added. */
  body: Map<string, Set<string>>
  /**
   * Sheets an AI source made that nothing but AI runs has written since: `modified` is still the
   * one the creation logged, or no later than the sheet's latest AI run (`AI_RUN_SLACK_MS`). An
   * author edit between two AI runs cannot be told apart (logged in QUESTIONS.md).
   */
  made: Set<string>
}

/** `keys` with every paragraph `pageEdits` finds added from `before` to `after`. */
function addAdded(
  keys: Set<string>,
  before: string | null | undefined,
  after: string | null | undefined
): Set<string> {
  for (const paragraph of pageEdits(before, after).added) keys.add(paragraphKey(paragraph))
  return keys
}

function aiWritten(db: TreeDb, entities: ReadonlyMap<string, EntityRow>): AiWritten {
  const out: AiWritten = { fields: new Map(), body: new Map(), made: new Set() }
  const createdAs = new Map<string, string>()
  const lastRun = new Map<string, number>()
  const rows = db
    .select()
    .from(knowledgeChange)
    .orderBy(asc(knowledgeChange.createdAt), sql`rowid`)
    .all()
  for (const row of rows) {
    if (row.status !== 'applied' || !AI_WRITER_SOURCES.has(changeSourceOf(row.runId))) continue
    let undo: ChangeUndo
    try {
      const parsed = ChangeUndo.safeParse(JSON.parse(row.undo))
      if (!parsed.success) continue
      undo = parsed.data
    } catch {
      continue
    }
    if (undo.type !== 'restoreSheet' && undo.type !== 'deleteSheet') continue
    const at = Date.parse(row.createdAt)
    if (Number.isFinite(at))
      lastRun.set(undo.entityId, Math.max(lastRun.get(undo.entityId) ?? at, at))
    if (undo.type === 'deleteSheet') {
      if (undo.modified !== undefined) createdAs.set(undo.entityId, undo.modified)
      continue
    }
    for (const [id, value] of Object.entries(undo.after.fields ?? {})) {
      const byField = out.fields.get(undo.entityId) ?? new Map<string, Set<string>>()
      byField.set(id, addAdded(byField.get(id) ?? new Set(), undo.before.fields?.[id], value))
      out.fields.set(undo.entityId, byField)
    }
    if (undo.after.body !== undefined) {
      out.body.set(
        undo.entityId,
        addAdded(out.body.get(undo.entityId) ?? new Set(), undo.before.body, undo.after.body)
      )
    }
  }
  for (const [entityId, modified] of createdAs) {
    const sheet = entities.get(entityId)
    if (sheet === undefined) continue
    const last = lastRun.get(entityId)
    const stamp = Date.parse(sheet.modified)
    if (
      sheet.modified === modified ||
      (last !== undefined && Number.isFinite(stamp) && stamp <= last + AI_RUN_SLACK_MS)
    ) {
      out.made.add(entityId)
    }
  }
  return out
}

/** A sheet's lines, split into the author's and the AI's, with page paragraphs a write-up made dropped. */
interface SheetLines {
  author: string[]
  ai: string[]
  writeUps: number
}

/**
 * Splits a sheet's text (`allAi`: a sheet the AI made, all of it the AI's). A field's paragraphs
 * split like the page's, so the author's own words in a field an AI run appended to stay hers;
 * each part keeps the field's label.
 */
function sheetLines(
  row: EntityRow,
  category: StoryCategory,
  written: AiWritten,
  allAi: boolean
): SheetLines {
  const out: SheetLines = { author: [], ai: [], writeUps: 0 }
  const aiFields = written.fields.get(row.id)
  const mine: Record<string, string> = {}
  const theirs: Record<string, string> = {}
  for (const [id, value] of Object.entries(parseEntityFields(row.fields))) {
    const keys = aiFields?.get(id)
    const ai: string[] = []
    const own: string[] = []
    for (const paragraph of textParagraphs(value)) {
      if (allAi || keys?.has(paragraphKey(paragraph)) === true) ai.push(paragraph)
      else own.push(paragraph)
    }
    if (own.length > 0) mine[id] = own.join('\n\n')
    if (ai.length > 0) theirs[id] = ai.join('\n\n')
  }
  const defs = sheetFieldDefs(category, parseExtraFields(row.extraFields))
  out.author.push(...pinnedFromFields(defs, mine))
  out.ai.push(...pinnedFromFields(defs, theirs))
  const writeUps = new Set(parseStoredSheetSync(row.sync)?.aiParagraphs ?? [])
  const aiBody = written.body.get(row.id) ?? new Set<string>()
  for (const paragraph of textParagraphs(row.body)) {
    if (writeUps.has(paragraphHash(paragraph))) {
      out.writeUps += 1
      continue
    }
    if (allAi || aiBody.has(paragraphKey(paragraph))) out.ai.push(paragraph)
    else out.author.push(paragraph)
  }
  return out
}

const isProjectNotes = (row: EntityRow): boolean =>
  row.kind === 'world' && toEntityNameKey(row.name) === toEntityNameKey(PROJECT_NOTES_NAME)

/** Adds a name to a record unless it already answers to it. */
function addName(record: PlannedRecord, text: string): void {
  const clean = text.normalize('NFC').trim().replace(/\s+/g, ' ').slice(0, RECORD_ALIAS_MAX).trim()
  const norm = normName(clean)
  if (norm === '') return
  if (normName(record.name) === norm) return
  if (record.aliases.some((alias) => normName(alias) === norm)) return
  if (record.aliases.length >= RECORD_ALIASES_MAX) return
  record.aliases.push(clean)
}

export interface BuildModelOptions {
  /** The consent's words per inline-tag row key; absent rows keep their default. */
  replacements?: ReadonlyMap<string, string>
}

/**
 * Works out the switch-over from the v1 tables (see the module comment). Reads only. The rules,
 * in the order they apply:
 * - every author sheet becomes a record (category, image, names kept; a tag linked to it merges
 *   in); an AI sheet is dropped unless the author added a dated line, a relationship, a picture
 *   or a Plan or Idea status to it; the Project notes sheet becomes a Research note instead;
 * - an author tag without a kept sheet becomes a record when it names something (character,
 *   setting, world building) or is a plot thread, a label when it is tone, content or custom; an
 *   AI tag is dropped; nesting is dropped and named;
 * - a sheet's filled fields, dated author lines, relationships and thread events, and page
 *   paragraphs become Pinned lines (Ideas for a Plan or Idea sheet or line); every paragraph an
 *   AI run wrote that still stands goes to the Not canon block (in Ideas on a Plan or Idea sheet);
 *   page paragraphs a write-up made are dropped;
 * - typed details from scene meta (POV and place by name or alias; a POV no record answers to
 *   becomes a character), timeline years on the first scene of each run, "+ also here" from the
 *   author's character and place links on scenes that do not name the record; the timeline's
 *   events as a written Research note;
 * - uploads become Research documents; dismissals that still mean something are mapped.
 */
export function buildSwitchoverModel(db: TreeDb, options: BuildModelOptions = {}): SwitchoverModel {
  const rows = listNodes(db)
  const kept: SwitchoverItem[] = []
  const converted: SwitchoverItem[] = []
  const dropped: SwitchoverItem[] = []
  const notes: string[] = []

  const categories = listCategories(db)
  const entityRows = db
    .select()
    .from(entity)
    .orderBy(asc(entity.created), sql`rowid`)
    .all()
  const entities = new Map(entityRows.map((row) => [row.id, row]))
  const tagRows: TagRowLite[] = db
    .select()
    .from(tag)
    .orderBy(asc(tag.created), sql`rowid`)
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      category: row.category,
      color: row.color,
      parentId: row.parentId,
      origin: row.origin,
      aliases: parseAliases(row.aliases)
    }))
  const tags = new Map(tagRows.map((row) => [row.id, row]))
  const links = db.select().from(documentTag).all()
  const written = aiWritten(db, entities)

  // ---- Dated author lines, relationships and thread events, per sheet (the AI's are dropped).
  const scenes = manuscriptDocuments(db, rows)
  const numbers = sceneNumbers(scenes)
  const titleOf = new Map(rows.map((row) => [row.id, row.title]))
  const sceneRef = (nodeId: string | null): string | null =>
    nodeId === null ? null : sceneReference(numbers.get(nodeId) ?? '', titleOf.get(nodeId) ?? '')
  const aiFacts = new Map<string, number>()
  /** Per sheet, its author lines in the order written, and whether each is canon. */
  const factLines = new Map<string, { text: string; canon: boolean }[]>()
  for (const row of db
    .select()
    .from(fact)
    .orderBy(asc(fact.createdAt), sql`rowid`)
    .all()) {
    if (row.origin === 'ai') {
      const name = entities.get(row.entityId)?.name ?? 'a sheet'
      aiFacts.set(name, (aiFacts.get(name) ?? 0) + 1)
      continue
    }
    if (row.hidden) continue
    const relation = relationTypeOf(row.attribute)
    const event = threadEventOf(row.attribute)
    let lines: string[]
    if (relation !== null && row.objectEntityId !== null) {
      const other = entities.get(row.objectEntityId)?.name ?? 'a sheet that is gone'
      const label = row.value.trim() === '' ? '' : ` (${row.value.trim()})`
      lines = datedLine(
        'Relationship',
        sceneRef(row.nodeId),
        `${RELATION_LABEL[relation]} ${other}${label}`
      )
    } else if (event !== null) {
      const label = THREAD_EVENT_LABEL[event]
      const ref = sceneRef(row.nodeId)
      lines =
        row.value.trim() === ''
          ? [ref === null ? label : `${label} (from ${ref})`]
          : datedLine(label, ref, row.value)
    } else if (isFieldFact(row) && row.nodeId !== null) {
      const sheet = entities.get(row.entityId)
      const category = categoryOf(sheet?.kind ?? 'world', categories)
      const defs = sheetFieldDefs(category, parseExtraFields(sheet?.extraFields ?? null))
      const label = defs.find((def) => def.id === row.attribute)?.label ?? row.attribute
      lines = datedLine(label, sceneRef(row.nodeId), row.value)
    } else {
      continue
    }
    const list = factLines.get(row.entityId) ?? []
    list.push(...lines.map((text) => ({ text, canon: row.status === 'canon' })))
    factLines.set(row.entityId, list)
  }

  // ---- Records: sheets first, so a tag linked to a sheet merges into it.
  const records: PlannedRecord[] = []
  const recordOfTag = new Map<string, PlannedRecord>()
  const research: PlannedResearch[] = []
  const aiSheets: string[] = []
  let writeUps = 0
  for (const row of entityRows) {
    const dated = factLines.get(row.id) ?? []
    // A sheet the AI made is dropped unless the author added to it: a dated line, a
    // relationship, a picture, or a Plan or Idea status (none of which makes it hers in v1).
    const aiSheet = row.origin === 'ai'
    if (aiSheet && dated.length === 0 && row.image === null && row.status === 'canon') {
      aiSheets.push(row.name)
      continue
    }
    const category = categoryOf(row.kind, categories)
    const lines = sheetLines(row, category, written, aiSheet || written.made.has(row.id))
    writeUps += lines.writeUps
    const sheetCanon = row.status === 'canon'
    if (isProjectNotes(row)) {
      const ai: PageLine[] =
        lines.ai.length === 0
          ? []
          : [
              { text: FILED_BY_AI_HEADING, heading: true, notCanon: true },
              ...lines.ai.map((text) => ({ text, notCanon: true }))
            ]
      research.push({
        kind: 'notes',
        title: PROJECT_NOTES_NAME,
        lines: [
          ...lines.author.map((text) => ({ text })),
          ...dated.map((line) => ({ text: line.text })),
          ...ai
        ],
        notCanon: !sheetCanon
      })
      continue
    }
    const linked = row.tagId === null ? undefined : tags.get(row.tagId)
    // Two sheets may share one tag (F-9.4 links a sheet to a tag of its name): the first keeps it.
    const owned = linked !== undefined && !recordOfTag.has(linked.id) ? linked : undefined
    const known = categories.some((each) => each.id === row.kind) || category.builtIn
    if (!known) notes.push(`${row.name}: its category is gone; it becomes a World record.`)
    const planned: PlannedRecord = {
      key: `entity:${row.id}`,
      name: row.name,
      categoryId: known ? row.kind : 'world',
      image: row.image,
      aliases: [],
      legacyEntityId: row.id,
      legacyTagId: owned?.id ?? null,
      pinned: [],
      ideas: [],
      filedByAi: lines.ai,
      // A Plan or Idea sheet was never canon: what the AI wrote in it goes to Ideas too.
      filedIn: sheetCanon ? 'pinned' : 'ideas',
      from: 'sheet',
      aiSheet,
      tagIds: owned === undefined ? [] : [owned.id]
    }
    const own = linked === undefined ? parseAliases(row.aliases) : linked.aliases
    for (const name of own) addName(planned, name)
    if (linked !== undefined) addName(planned, tagNameAsWords(linked.name))
    const target = sheetCanon ? planned.pinned : planned.ideas
    target.push(...lines.author.map((text) => ({ text })))
    for (const line of dated) {
      ;(sheetCanon && line.canon ? planned.pinned : planned.ideas).push({ text: line.text })
    }
    records.push(planned)
    if (owned !== undefined) recordOfTag.set(owned.id, planned)
  }

  // ---- Tags without a kept sheet: records, labels, or dropped.
  const labels: PlannedLabel[] = []
  const aiTags: string[] = []
  const nested: string[] = []
  for (const row of tagRows) {
    if (row.origin === 'ai' && !recordOfTag.has(row.id)) {
      aiTags.push(`#${row.name}`)
      continue
    }
    // Nesting converts to nothing, whatever the tag becomes: each nested author tag is named.
    if (row.origin === 'author' && row.parentId !== null) {
      const parent = tags.get(row.parentId)
      nested.push(`#${row.name}${parent === undefined ? '' : ` under #${parent.name}`}`)
    }
    if (recordOfTag.has(row.id)) continue
    const fromTag = recordFromTag(row)
    if (fromTag !== null) {
      const planned: PlannedRecord = {
        key: `tag:${row.id}`,
        name: fromTag.name,
        categoryId: fromTag.categoryId,
        image: null,
        aliases: [],
        legacyEntityId: null,
        legacyTagId: row.id,
        pinned: [],
        ideas: [],
        filedByAi: [],
        filedIn: 'pinned',
        from: 'tag',
        aiSheet: false,
        tagIds: [row.id]
      }
      for (const name of fromTag.aliases) addName(planned, name)
      records.push(planned)
      recordOfTag.set(row.id, planned)
      continue
    }
    const asLabel = labelFromTag(row)
    if (asLabel === null) continue
    if (labels.length >= LABELS_MAX) {
      notes.push(`#${row.name}: a project keeps at most ${LABELS_MAX} labels; it is not converted.`)
      continue
    }
    const nodeIds = links
      .filter((link) => link.tagId === row.id && link.source === 'author')
      .map((link) => link.nodeId)
    labels.push({ tagId: row.id, ...asLabel, nodeIds })
  }

  // ---- Typed details.
  const byNorm = (): Map<string, PlannedRecord[]> => {
    const map = new Map<string, PlannedRecord[]>()
    for (const planned of records) {
      for (const name of [planned.name, ...planned.aliases]) {
        const norm = normName(name)
        if (norm === '') continue
        const list = map.get(norm) ?? []
        if (!list.includes(planned)) list.push(planned)
        map.set(norm, list)
      }
    }
    return map
  }
  const metaRows = rows.filter((row) => row.sceneMeta !== null)
  const manuscriptIds = new Set(scenes.map((row) => row.id))
  const underManuscript = new Set<string>()
  {
    const parents = new Map(rows.map((row) => [row.id, row.parentId]))
    const root = rows.find((row) => row.parentId === null && row.sectionType === 'manuscript')
    for (const row of rows) {
      for (let at = row.parentId; at !== null && at !== undefined; at = parents.get(at) ?? null) {
        if (at === root?.id) {
          underManuscript.add(row.id)
          break
        }
      }
    }
  }
  const metaOf = new Map<string, SceneMeta>()
  for (const row of metaRows) {
    if (underManuscript.has(row.id)) metaOf.set(row.id, parseStoredSceneMeta(row.sceneMeta))
  }
  const createdPovs: string[] = []
  /**
   * The record a typed POV or place names: by name or alias, then (v1's pickers offered tag
   * names) by the words of a kebab name, then by the tag of that name; `prefer` breaks a tie.
   */
  const lookup = (
    index: Map<string, PlannedRecord[]>,
    text: string,
    prefer: string
  ): PlannedRecord | null => {
    const trimmed = text.trim()
    const found = [
      ...(index.get(normName(trimmed)) ?? []),
      ...(index.get(normName(tagNameAsWords(trimmed))) ?? [])
    ]
    const byTag = tagRows.find((row) => row.name === trimmed)
    const tagged = byTag === undefined ? undefined : recordOfTag.get(byTag.id)
    if (tagged !== undefined) found.push(tagged)
    return found.find((each) => each.categoryId === prefer) ?? found[0] ?? null
  }
  {
    let index = byNorm()
    for (const meta of metaOf.values()) {
      const pov = meta.pov.trim()
      if (normName(pov) === '' || lookup(index, pov, 'character') !== null) continue
      const name = /^[\p{Ll}\p{N}]+(-[\p{Ll}\p{N}]+)+$/u.test(pov) ? recordNameFromTag(pov) : pov
      records.push({
        key: `pov:${normName(name)}`,
        name,
        categoryId: 'character',
        image: null,
        aliases: [],
        legacyEntityId: null,
        legacyTagId: null,
        pinned: [],
        ideas: [],
        filedByAi: [],
        filedIn: 'pinned',
        from: 'pov',
        aiSheet: false,
        tagIds: []
      })
      createdPovs.push(name)
      index = byNorm()
    }
  }
  const index = byNorm()
  const pick = (text: string, prefer: string): PlannedRecord | null => lookup(index, text, prefer)

  // Story years: the first scene of each run of consecutive scenes linked to one event.
  const years = new Map<string, number>()
  const timeline = getProjectTimeline(db).events
  const events = new Map(timeline.map((event) => [event.id, event]))
  let previous: string | undefined
  for (const scene of scenes) {
    const eventId = metaOf.get(scene.id)?.eventId
    const year = eventId === undefined ? null : (events.get(eventId)?.year ?? null)
    if (eventId !== undefined && eventId !== previous && year !== null) years.set(scene.id, year)
    previous = eventId
  }
  // The scenes v1's reading-order view showed as set earlier than one before them (F-11.2's
  // rule). That flag was computed from the event links, never typed, so the Flashback switch (the
  // author's alone) is left to follow the book; a note names them, so the author can turn it on
  // where one is a flashback (review 2026-10-14).
  const setEarlier = readingOrderRows(
    timeline,
    scenes.map((scene) => scene.id),
    (id) => metaOf.get(id)?.eventId
  ).flatMap((row) => (row.flashback ? [sceneRef(row.id) ?? ''] : []))
  if (setEarlier.length > 0) {
    notes.push(
      `v1’s Timeline showed ${setEarlier.join(', ')} as set earlier than a scene before ${setEarlier.length === 1 ? 'it' : 'them'}. The Flashback switch is left to follow the book: turn it on in a scene’s details where it is a flashback, so its story year does not carry into the scenes after it.`
    )
  }
  // The events themselves (the author's labels, times and notes, linked or not) stay readable in
  // v2, where the Timeline section is hidden until P2b: one written Research note, a line each.
  if (timeline.length > 0) {
    research.push({
      kind: 'notes',
      title: TIMELINE_NOTE_TITLE,
      lines: timeline.map((event) => ({
        text: timelineLine(
          event,
          scenes
            .filter((scene) => metaOf.get(scene.id)?.eventId === event.id)
            .map((scene) => numbers.get(scene.id) ?? '')
            .filter((number) => number !== '')
        )
      })),
      notCanon: false
    })
  }

  // Replacements: the consent's words, else each row's default, per stored token id.
  const recordNameOfTag = new Map<string, string>()
  for (const planned of records) {
    for (const tagId of planned.tagIds) recordNameOfTag.set(tagId, planned.name)
  }
  const inlineTags = inlineTagRows(db, allTexts(db, rows), tags, recordNameOfTag)
  const tokenText = new Map<string, string>()
  for (const row of inlineTags) {
    const text = (options.replacements?.get(row.key) ?? row.replacement).trim()
    for (const id of row.tokenIds) tokenText.set(id, text === '' ? row.replacement : text)
  }

  // "+ also here": the author's character and place links on scenes that do not name the record.
  const sharedNorms = sharedNormsOf(records)
  const scanIndex = buildNameIndex(
    records.map((planned) => ({ id: planned.key, kind: recordKindOf(planned.categoryId) })),
    records.flatMap((planned) =>
      [planned.name, ...planned.aliases].map((text, at) => ({
        id: `${planned.key}#${at}`,
        recordId: planned.key,
        text,
        norm: normName(text),
        caseRule: defaultCaseRule(text),
        shared: sharedNorms.has(normName(text))
      }))
    )
  )
  const details: PlannedDetails[] = []
  let alsoHereCount = 0
  const detailIds = new Set([...metaOf.keys(), ...years.keys()])
  for (const link of links) if (manuscriptIds.has(link.nodeId)) detailIds.add(link.nodeId)
  const order = new Map(rows.map((row, at) => [row.id, at]))
  for (const nodeId of [...detailIds].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))) {
    const meta = metaOf.get(nodeId)
    const pov = meta === undefined || meta.pov.trim() === '' ? null : pick(meta.pov, 'character')
    const placeText = meta?.location.trim() ?? ''
    const place = placeText === '' ? null : pick(placeText, 'setting')
    const here: string[] = []
    if (manuscriptIds.has(nodeId)) {
      const sceneTags = links
        .filter((link) => link.nodeId === nodeId && link.source === 'author')
        .map((link) => tags.get(link.tagId))
        .filter(
          (row): row is TagRowLite =>
            row !== undefined && (row.category === 'character' || row.category === 'setting')
        )
      const candidates = sceneTags
        .map((row) => recordOfTag.get(row.id))
        .filter((planned): planned is PlannedRecord => planned !== undefined)
        // The POV and the place are on their own lines already.
        .filter((planned) => planned.key !== pov?.key && planned.key !== place?.key)
      if (candidates.length > 0) {
        const row = rows.find((each) => each.id === nodeId)
        const doc = storedDoc(row?.content ?? null)
        const text = doc === null ? null : replaceInlineTags(doc, tokenText).doc
        const named = new Set(
          text === null
            ? []
            : scanNames(passageParagraphs(text), scanIndex, {
                povRecordId: pov?.key ?? null,
                notMention: new Set()
              }).map((mention) => mention.recordId)
        )
        for (const planned of candidates) {
          if (!named.has(planned.key) && !here.includes(planned.key)) here.push(planned.key)
        }
      }
    }
    const timeText = meta?.timeline.trim() ?? ''
    const storyYear = years.get(nodeId) ?? null
    if (
      pov === null &&
      place === null &&
      placeText === '' &&
      timeText === '' &&
      storyYear === null &&
      here.length === 0
    ) {
      continue
    }
    alsoHereCount += Math.min(here.length, ALSO_HERE_MAX)
    details.push({
      nodeId,
      povKey: pov?.key ?? null,
      placeKey: place?.key ?? null,
      placeText,
      timeText,
      storyYear,
      alsoHere: here.slice(0, ALSO_HERE_MAX)
    })
  }

  // ---- Uploads become Research documents with their originals.
  research.push(...plannedUploads(db))

  // ---- Twin-gate merge list over the records to be.
  const roster = records.map((planned) => ({
    id: planned.key,
    names: [planned.name, ...planned.aliases]
  }))
  const nameOfKey = new Map(records.map((planned) => [planned.key, planned.name]))
  /** A record's name with its category, so two records of one name can be told apart. */
  const nameWithNoun = (planned: PlannedRecord): string =>
    `${planned.name} (${categoryOf(planned.categoryId, categories).noun})`
  const recordOfKey = new Map(records.map((planned) => [planned.key, planned]))
  const categoryOfKey = (key: string): string => {
    const planned = recordOfKey.get(key)
    return planned === undefined ? '' : categoryOf(planned.categoryId, categories).noun
  }

  // ---- Dismissals.
  const dismissals: PlannedDismissal[] = []
  const cannot: string[] = []
  const recordNorms = new Set(index.keys())
  const seenNames = new Set<string>()
  const names = [
    ...getDismissedNames(db).names.map((name) => tagNameAsWords(name)),
    ...getObservedDismissed(db).names.map((entry) => entry.nameKey)
  ]
  for (const name of names) {
    const norm = normName(name)
    if (norm === '' || seenNames.has(norm)) continue
    seenNames.add(norm)
    if (recordNorms.has(norm)) {
      cannot.push(`“${name}”: dismissed as a name, but it is a record now.`)
      continue
    }
    dismissals.push({ kind: 'name', name, label: `${name}: not a name` })
  }
  const notSame = new Set<string>()
  for (const spelling of getKeptSpellings(db)) {
    const words = tagNameAsWords(spelling)
    const owner = records.find((planned) =>
      [planned.name, ...planned.aliases].some((name) => aliasKey(name) === spelling)
    )
    const other =
      owner === undefined
        ? undefined
        : (() => {
            const result = twinGate(
              words,
              roster.filter((entry) => entry.id !== owner.key)
            )
            return result.outcome === 'blocked' && result.recordId !== null
              ? result.recordId
              : undefined
          })()
    if (owner === undefined || other === undefined) {
      cannot.push(`“${words}”: a kept spelling, but not two records to keep apart.`)
      continue
    }
    const pair = [owner.key, other].sort().join('|')
    if (notSame.has(pair)) continue
    notSame.add(pair)
    dismissals.push({
      kind: 'notSame',
      a: owner.key,
      b: other,
      label: `${owner.name} and ${nameOfKey.get(other) ?? other}: not the same`
    })
  }
  const nodeIds = new Set(rows.map((row) => row.id))
  for (const key of getPlanLinkState(db).dismissed) {
    const at = key.lastIndexOf('>')
    if (at <= 0) {
      cannot.push(`A dismissed plan link (${key}) that no longer reads.`)
      continue
    }
    const planId = key.slice(0, at)
    const sceneId = key.slice(at + 1)
    dismissals.push({
      kind: 'unlink',
      planId,
      sceneId,
      nodeId: nodeIds.has(sceneId) ? sceneId : null,
      label: `${titleOf.get(sceneId) ?? 'A scene'}: not linked to its plan`
    })
  }

  const merges: SwitchoverMerge[] = twinPairs(roster)
    .filter((pair) => !notSame.has([pair.a, pair.b].sort().join('|')))
    .map((pair) => ({
      keep: pair.a,
      keepName: nameOfKey.get(pair.a) ?? pair.a,
      keepCategory: categoryOfKey(pair.a),
      merge: pair.b,
      mergeName: nameOfKey.get(pair.b) ?? pair.b,
      mergeCategory: categoryOfKey(pair.b),
      rule: pair.rule,
      name: pair.name,
      matched: pair.matched
    }))

  // ---- The report.
  const docs = scenes.filter((row) => row.content !== null)
  const tokens = inlineTags.reduce((sum, row) => sum + row.count, 0)
  kept.push({
    name: 'The manuscript',
    detail: `${plural(scenes.length, 'document')}, ${plural(
      docs.reduce((sum, row) => sum + row.wordCount, 0),
      'word'
    )}; ${plural(tokens, 'inline tag')} become plain words with your consent; tag ranges stay, inert.`
  })
  kept.push({ name: 'Scene notes', detail: 'Untouched (inline tags in them become words too).' })
  const ideaScenes = [...metaOf.entries()].filter(([, meta]) => meta.status === 'idea').length
  if (ideaScenes > 0)
    kept.push({ name: 'Idea scenes', detail: `${plural(ideaScenes, 'scene')}, untouched.` })
  const snapshots = db.get<{ n: number }>(sql`SELECT count(*) AS n FROM snapshot`)?.n ?? 0
  if (snapshots > 0)
    kept.push({
      name: 'Snapshots',
      detail: `${plural(snapshots, 'snapshot')}, byte for byte as they are.`
    })
  const drafts = db.get<{ n: number }>(sql`SELECT count(*) AS n FROM draft_text`)?.n ?? 0
  if (drafts > 0)
    kept.push({
      name: 'Other drafts',
      detail: `${plural(drafts, 'document')} kept; inline tags in them become words too.`
    })
  const own =
    db.get<{ n: number }>(sql`SELECT count(*) AS n FROM story_category WHERE fields IS NOT NULL`)
      ?.n ?? 0
  if (own > 0)
    kept.push({
      name: 'Your categories',
      detail: `${plural(own, 'category', 'categories')}, kept.`
    })

  for (const planned of records) {
    const from =
      planned.from === 'sheet'
        ? planned.aiSheet
          ? 'from a sheet the AI made, kept for what you added to it'
          : planned.legacyTagId === null
            ? 'from its sheet'
            : 'from its sheet and tag'
        : planned.from === 'tag'
          ? 'from its tag'
          : 'the POV of a scene, with no sheet or tag'
    const parts = [from]
    if (planned.aliases.length > 0) parts.push(`also ${planned.aliases.join(', ')}`)
    const lines = planned.pinned.length
    if (lines > 0) parts.push(`${plural(lines, 'Pinned line')}`)
    if (planned.ideas.length > 0) parts.push(`${plural(planned.ideas.length, 'Ideas line')}`)
    if (planned.filedByAi.length > 0)
      parts.push(
        `${plural(planned.filedByAi.length, 'line')} filed by AI, Not canon${planned.filedIn === 'ideas' ? ', in Ideas' : ''}`
      )
    converted.push({
      name: planned.name,
      detail: `Record (${categoryOf(planned.categoryId, categories).noun}): ${parts.join('; ')}.`
    })
  }
  for (const item of labels) {
    converted.push({
      name: item.name,
      detail: `${item.kind === 'custom' ? 'Custom' : item.kind === 'tone' ? 'Tone' : 'Content'} label on ${plural(item.nodeIds.length, 'document')}.`
    })
  }
  for (const item of research) {
    converted.push(
      item.kind === 'upload'
        ? { name: item.name, detail: 'Research document, with its original.' }
        : {
            name: item.title,
            detail: `Research note${item.notCanon ? ', Not canon (it was Plan or Idea)' : ''}.`
          }
    )
  }
  if (details.length > 0) {
    const povs = details.filter((each) => each.povKey !== null).length
    const places = details.filter((each) => each.placeKey !== null).length
    const yearsSet = details.filter((each) => each.storyYear !== null).length
    converted.push({
      name: 'Scene details',
      detail: `${plural(details.length, 'scene')}: ${plural(povs, 'POV')} and ${plural(places, 'place')} as records, ${plural(yearsSet, 'story year')}, ${plural(alsoHereCount, '“also here”', '“also here”')}.`
    })
  }
  for (const pov of createdPovs) {
    notes.push(`${pov}: a POV no sheet or tag names; a Character record is made for it.`)
  }
  if (dismissals.length > 0) {
    converted.push({
      name: 'Dismissals',
      detail: `${plural(dismissals.length, 'dismissal')} that still apply, into Dismissed.`
    })
  }

  if (aiSheets.length > 0) dropped.push({ name: 'Sheets the AI made', detail: aiSheets.join(', ') })
  if (aiTags.length > 0) dropped.push({ name: 'Tags the AI made', detail: aiTags.join(', ') })
  const aiLinks = links.filter((link) => link.source === 'ai').length
  if (aiLinks > 0)
    dropped.push({ name: 'Tags the AI put on scenes', detail: plural(aiLinks, 'link') })
  if (aiFacts.size > 0) {
    dropped.push({
      name: 'Facts the AI read',
      detail: [...aiFacts.entries()].map(([name, n]) => `${name} ${n}`).join(', ')
    })
  }
  const count = (table: string, where = ''): number =>
    db.get<{ n: number }>(
      sql.raw(`SELECT count(*) AS n FROM ${table}${where === '' ? '' : ` WHERE ${where}`}`)
    )?.n ?? 0
  const derived: [string, number, string][] = [
    ['Observed facts', count('observed_fact'), 'fact'],
    ['Scene summaries and cards', count('scene_summary'), 'scene'],
    ['The Changes log', count('knowledge_change'), 'row'],
    ['Continuity findings', count('continuity_finding'), 'finding'],
    ['Computed To do items', count('todo_item'), 'item'],
    ['Sheet sync state', count('entity', 'sync IS NOT NULL'), 'sheet']
  ]
  for (const [name, n, unit] of derived) {
    if (n > 0)
      dropped.push({ name, detail: `${plural(n, unit)}; they stay in the old tables until P9.` })
  }
  if (writeUps > 0)
    dropped.push({
      name: 'Sheet write-ups',
      detail: `${plural(writeUps, 'page paragraph')} the AI wrote up from fields that convert anyway.`
    })
  const planLinks = getPlanLinkState(db)
  const aiPlan = [
    planLinks.aiApplied.length === 0
      ? ''
      : `${plural(planLinks.aiApplied.length, 'link')} the AI applied, taken off the outline`,
    planLinks.suggestions.length === 0
      ? ''
      : `${plural(planLinks.suggestions.length, 'suggestion')} waiting`
  ].filter((part) => part !== '')
  if (aiPlan.length > 0) dropped.push({ name: 'AI plan links', detail: aiPlan.join('; ') })
  const obsolete: [string, number][] = [
    ['AI tags taken off scenes', count('document_tag_dismissal')],
    ['Hidden observed facts', count('observed_fact', 'hidden = 1')],
    ['Hidden AI facts', count('fact', "hidden = 1 AND origin = 'ai'")],
    ['Done and dismissed To do items', count('todo_item', "status <> 'open'")],
    ['Dismissed continuity findings', count('continuity_finding', "status = 'dismissed'")]
  ]
  for (const [name, n] of obsolete) {
    if (n > 0)
      dropped.push({
        name: `Old dismissals: ${name.toLowerCase()}`,
        detail: `${plural(n, 'row')}; nothing in v2 reads them.`
      })
  }

  if (nested.length > 0) notes.push(`Tag nesting is dropped: ${nested.join(', ')}.`)
  if (labels.some((item) => item.kind === 'custom')) {
    notes.push(
      'Custom tags become custom labels, which only filter: in v1 they steered prose as themes. Change a label’s kind to Theme to keep that.'
    )
  }
  for (const norm of sharedNorms) {
    const holders = records.filter((planned) =>
      [planned.name, ...planned.aliases].some((name) => normName(name) === norm)
    )
    notes.push(
      `“${norm}” is a name of ${holders.map(nameWithNoun).join(' and ')}; it is marked shared on each.`
    )
  }
  notes.push(...cannot)
  notes.push(
    `The Changes log keeps only its newest ${CHANGES_MAX.toLocaleString('en-US')} rows, so sheet text the AI wrote before that counts as yours.`
  )

  // The rebuild never reads an Idea scene or one left out of compile (design §2.2). Each scene is
  // counted as it will read once converted (its inline tags as words), so the dry run's price is
  // the one *Rebuild memory* gives after the switch (F-16.31, decision SW-D10).
  const statuses = sceneStatuses(db, rows)
  const rebuildScenes = scenes
    .filter((row) => !statuses.idea.has(row.id) && !statuses.excluded.has(row.id))
    .map((row) => {
      const doc = storedDoc(row.content)
      return doc === null ? 0 : estimateTokens(docToText(replaceInlineTags(doc, tokenText).doc))
    })
    .filter((tokensOf) => tokensOf > 0)

  return {
    records,
    sharedNorms,
    labels,
    research,
    details,
    dismissals,
    merges,
    inlineTags,
    tokenText,
    kept,
    converted,
    dropped,
    notes,
    rebuildScenes
  }
}

/** The norms more than one planned record answers to. */
function sharedNormsOf(records: readonly PlannedRecord[]): Set<string> {
  const holders = new Map<string, Set<string>>()
  for (const planned of records) {
    for (const name of [planned.name, ...planned.aliases]) {
      const norm = normName(name)
      if (norm === '') continue
      holders.set(norm, (holders.get(norm) ?? new Set()).add(planned.key))
    }
  }
  return new Set([...holders].filter(([, keys]) => keys.size > 1).map(([norm]) => norm))
}
