import { z } from 'zod'
import { categoryFieldIds, categoryOf, isKnownCategory, type StoryCategory } from './categories'
import {
  ENTITY_BODY_MAX,
  ENTITY_FIELD_MAX,
  ENTITY_NAME_MAX,
  EntityFieldId,
  EntityKind,
  EntityTemplate,
  toEntityNameKey,
  type EntityFields
} from './entities'

/**
 * Entity export and import (F-9.5): the file formats, both serializers, both parsers, and the
 * pure merge planner. One owner for the exchange vocabulary, so what main writes, what main
 * reads, and what the review dialog shows can never drift apart. Main only does file I/O and the
 * transaction; the renderer only shows the plan it is handed.
 *
 * A JSON file is the "reusable library across projects": export from one project, import into
 * another. Images and tags are deliberately not carried — `image` is a file inside one project's
 * `assets/`, and `tagId` is that project's own id; an import creates or links the tag the way any
 * entity creation does (F-9.4).
 */

export const ENTITY_EXCHANGE_FORMATS = ['json', 'csv'] as const
export const EntityExchangeFormat = z.enum(ENTITY_EXCHANGE_FORMATS)
export type EntityExchangeFormat = z.infer<typeof EntityExchangeFormat>

/** The extension each format is written with, lower-case, without the dot. */
export const ENTITY_EXCHANGE_EXTENSIONS: Record<EntityExchangeFormat, string> = {
  json: 'json',
  csv: 'csv'
}

/** What each format is called in a menu item, a dialog filter, and a toast. */
export const ENTITY_EXCHANGE_LABEL: Record<EntityExchangeFormat, string> = {
  json: 'JSON',
  csv: 'CSV'
}

/** The format a file name implies, or null when the extension is not one we read. */
export function entityExchangeFormatOf(fileName: string): EntityExchangeFormat | null {
  const dot = fileName.lastIndexOf('.')
  if (dot < 0) return null
  const extension = fileName.slice(dot + 1).toLowerCase()
  for (const format of ENTITY_EXCHANGE_FORMATS) {
    if (ENTITY_EXCHANGE_EXTENSIONS[format] === extension) return format
  }
  return null
}

/** What a JSON entity file says it is, so a file of another shape is refused rather than guessed at. */
export const ENTITY_EXCHANGE_FORMAT_ID = 'mythscribe-entities'
/** The version of the JSON file layout; a file from a later one is refused with its number. */
export const ENTITY_EXCHANGE_VERSION = 1

/**
 * One entity as it travels: the kind, the author's name for it, its template, the values of that
 * template (empty ones left out), and the blank page. No id, no image, no tag, no dates — an
 * import is a write into another project, not a copy of its rows.
 */
export const EntityExchangeRecord = z.object({
  kind: EntityKind,
  name: z.string().min(1).max(ENTITY_NAME_MAX),
  template: EntityTemplate,
  fields: z.partialRecord(EntityFieldId, z.string().max(ENTITY_FIELD_MAX)),
  body: z.string().max(ENTITY_BODY_MAX).nullable()
})
export type EntityExchangeRecord = z.infer<typeof EntityExchangeRecord>

/** A JSON entity file: the marker, the version, and the records, of any mix of kinds. */
export const EntityExchangeFile = z.object({
  format: z.literal(ENTITY_EXCHANGE_FORMAT_ID),
  version: z.literal(ENTITY_EXCHANGE_VERSION),
  entities: z.array(EntityExchangeRecord)
})
export type EntityExchangeFile = z.infer<typeof EntityExchangeFile>

/**
 * What the author chose for one row of the plan: create it, fill the gaps of the matching entity,
 * overwrite that entity's values, or leave it alone. `add` is only for an unmatched row, `merge`
 * and `replace` only for a matched one.
 */
export const ENTITY_IMPORT_ACTIONS = ['add', 'merge', 'replace', 'skip'] as const
export const EntityImportAction = z.enum(ENTITY_IMPORT_ACTIONS)
export type EntityImportAction = z.infer<typeof EntityImportAction>

/** One row of the review dialog: what the file says, what it matched, and what to do with it. */
export const EntityImportItem = z.object({
  /** `r<n>` for the nth record of the file, so an action can be addressed without an index. */
  id: z.string(),
  record: EntityExchangeRecord,
  /** The entity of the same kind whose name key matches, or null when the row is new here. */
  existingId: z.string().nullable(),
  action: EntityImportAction
})
export type EntityImportItem = z.infer<typeof EntityImportItem>

/** What `entity:importOpen` answers: the file, its rows, and how many duplicates it dropped. */
export const EntityImportPlan = z.object({
  source: z.object({ name: z.string(), format: EntityExchangeFormat }),
  items: z.array(EntityImportItem),
  /** Rows of the file that repeated an earlier row's kind and name; the first one is kept. */
  duplicates: z.number().int().nonnegative()
})
export type EntityImportPlan = z.infer<typeof EntityImportPlan>

/**
 * What this module needs of a stored entity; the contract's `Entity` satisfies it. Declared here
 * because the contract imports this file, so this file cannot import the contract.
 */
export interface EntityLike {
  id: string
  kind: EntityKind
  name: string
  template: EntityTemplate
  fields: EntityFields
  body: string | null
}

/** The patch an import applies to a matched entity; the contract's entity patch accepts it. */
export interface EntityExchangePatch {
  template?: EntityTemplate
  fields?: EntityFields
  body?: string | null
}

/**
 * Why a file could not be read, with the row it went wrong on when there is one. A plain error:
 * shared code knows nothing of `AppError`, and main turns this into VALIDATION with the message
 * as it stands, so the author reads the row and the reason.
 */
export class EntityExchangeError extends Error {
  /** The 1-based record or CSV data row the message is about; undefined for a whole-file problem. */
  readonly row: number | undefined

  constructor(message: string, row?: number) {
    super(message)
    this.name = 'EntityExchangeError'
    this.row = row
  }
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A stored entity as an exchange record: the filled fields of its category's template (F-9.11:
 * `categories` is the project's list), nothing project-local.
 */
export function toExchangeRecord(
  entity: EntityLike,
  categories: readonly StoryCategory[] = []
): EntityExchangeRecord {
  const fields: EntityFields = {}
  for (const id of categoryFieldIds(categoryOf(entity.kind, categories))) {
    const value = entity.fields[id]
    if (value !== undefined && value !== '') fields[id] = value
  }
  return {
    kind: entity.kind,
    name: entity.name,
    template: entity.template,
    fields,
    body: entity.body
  }
}

/** The JSON library file: pretty-printed, so a hand edit before an import is possible. */
export function serializeEntitiesJson(records: readonly EntityExchangeRecord[]): string {
  const file: EntityExchangeFile = {
    format: ENTITY_EXCHANGE_FORMAT_ID,
    version: ENTITY_EXCHANGE_VERSION,
    entities: [...records]
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

/**
 * The CSV header of these records: the three columns every row has, the field ids of their
 * categories' templates in category order (each once), then the page. F-9.11: with a library of
 * categories, a column per field of every category would bury one kind's rows in empty columns.
 */
export function entityCsvColumns(
  records: readonly EntityExchangeRecord[],
  categories: readonly StoryCategory[] = []
): string[] {
  const fieldIds: string[] = []
  for (const kind of [...new Set(records.map((record) => record.kind))]) {
    for (const id of categoryFieldIds(categoryOf(kind, categories))) {
      if (!fieldIds.includes(id)) fieldIds.push(id)
    }
  }
  return ['kind', 'name', 'template', ...fieldIds, 'body']
}

/** A leading BOM, so a spreadsheet opens the file as UTF-8 instead of guessing at a code page. */
export const CSV_BOM = '\uFEFF'

/** One cell, quoted when it carries a comma, a quote, or a line break (RFC 4180). */
export function csvEscape(value: string): string {
  if (!/[",\r\n]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

/**
 * The CSV of one kind's entities (the spec's "each entity type"), with the field columns of the
 * rows' categories (`entityCsvColumns`): the reader goes by the header, and a column that is not
 * of the row's category is simply ignored on the way back in.
 */
export function serializeEntitiesCsv(
  records: readonly EntityExchangeRecord[],
  categories: readonly StoryCategory[] = []
): string {
  const columns = entityCsvColumns(records, categories)
  const fieldIds = columns.slice(3, -1)
  const lines = [columns.map(csvEscape).join(',')]
  for (const record of records) {
    const cells = [record.kind, record.name, record.template]
    for (const id of fieldIds) cells.push(record.fields[id] ?? '')
    cells.push(record.body ?? '')
    lines.push(cells.map(csvEscape).join(','))
  }
  return `${CSV_BOM}${lines.join('\r\n')}\r\n`
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The cells of a CSV, row by row (RFC 4180): double quotes around a cell that needs them, a
 * doubled quote inside one, `\r\n` or `\n` between rows, a leading BOM stripped, and a trailing
 * newline ignored. Nothing about entities is known here.
 */
export function parseCsv(text: string): string[][] {
  const source = text.startsWith(CSV_BOM) ? text.slice(CSV_BOM.length) : text
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let index = 0
  const endRow = (): void => {
    row.push(cell)
    rows.push(row)
    row = []
    cell = ''
  }
  while (index < source.length) {
    const char = source[index]
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"'
          index += 2
          continue
        }
        quoted = false
        index += 1
        continue
      }
      cell += char
      index += 1
      continue
    }
    if (char === '"' && cell.length === 0) {
      quoted = true
      index += 1
      continue
    }
    if (char === ',') {
      row.push(cell)
      cell = ''
      index += 1
      continue
    }
    if (char === '\n' || char === '\r') {
      endRow()
      index += char === '\r' && source[index + 1] === '\n' ? 2 : 1
      continue
    }
    cell += char
    index += 1
  }
  if (cell.length > 0 || row.length > 0) endRow()
  return rows
}

/** Whether the row has nothing in any cell: a blank line a spreadsheet left behind. */
const isBlankRow = (row: readonly string[]): boolean => row.every((cell) => cell.trim() === '')

/** What one raw row says before it is checked; every value is whatever the file had. */
interface RawRecord {
  kind: unknown
  name: unknown
  template: unknown
  /** Keyed by lower-cased field id, so a CSV heading matches in any case. */
  fields: Record<string, unknown>
  body: unknown
}

const asText = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/**
 * One checked record, or an `EntityExchangeError` naming the row and the reason. An empty `kind`
 * takes `fallbackKind` (the kind the import was started from) when there is one. A value over a
 * stored limit is refused rather than cut: an import never quietly loses the end of a page.
 */
function recordFrom(
  raw: RawRecord,
  row: number,
  label: string,
  fallbackKind: EntityKind | null,
  categories: readonly StoryCategory[]
): EntityExchangeRecord {
  const bad = (message: string): EntityExchangeError =>
    new EntityExchangeError(`${label} ${row}: ${message}`, row)
  const kindText = asText(raw.kind)?.trim() ?? ''
  let kind: EntityKind
  if (kindText === '') {
    if (fallbackKind === null) throw bad('"kind" is missing')
    kind = fallbackKind
  } else {
    // F-9.11: a kind is a category id. The F-9.1 kinds (`character`, `setting`, `world`) are
    // library ids, so a file written before categories reads as it always did.
    const parsed = EntityKind.safeParse(kindText)
    if (!parsed.success || !isKnownCategory(parsed.data, categories)) {
      throw bad(`"${kindText}" is not a category of this project`)
    }
    kind = parsed.data
  }
  const nameText = asText(raw.name)?.trim() ?? ''
  if (nameText === '') throw bad('the name is empty')
  if (nameText.length > ENTITY_NAME_MAX) {
    throw bad(`the name is longer than ${ENTITY_NAME_MAX} characters`)
  }
  const templateText = asText(raw.template)?.trim() ?? ''
  let template: EntityTemplate = 'structured'
  if (templateText !== '') {
    const parsed = EntityTemplate.safeParse(templateText)
    if (!parsed.success) throw bad(`"${templateText}" is not a template`)
    template = parsed.data
  }
  const fields: EntityFields = {}
  // A column of another category is ignored; only the category's own fields travel.
  for (const id of categoryFieldIds(categoryOf(kind, categories))) {
    const value = raw.fields[id.toLowerCase()]
    if (value === undefined) continue
    const text = asText(value)
    if (text === null) throw bad(`"${id}" is not text`)
    if (text === '') continue
    if (text.length > ENTITY_FIELD_MAX) {
      throw bad(`"${id}" is longer than ${ENTITY_FIELD_MAX} characters`)
    }
    fields[id] = text
  }
  let body: string | null = null
  if (raw.body !== null && raw.body !== undefined) {
    const text = asText(raw.body)
    if (text === null) throw bad('the page is not text')
    if (text.length > ENTITY_BODY_MAX) {
      throw bad(`the page is longer than ${ENTITY_BODY_MAX} characters`)
    }
    if (text !== '') body = text
  }
  return { kind, name: nameText, template, fields, body }
}

/** The `fields` object of a JSON record, whatever shape it came in as, keyed by lower-cased id. */
function rawFields(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([id, cell]) => [id.toLowerCase(), cell])
  )
}

/**
 * The records of a JSON library file. The marker and the version are checked first, so a JSON
 * file of some other program says so plainly instead of failing on its first row.
 */
export function parseEntitiesJson(
  text: string,
  categories: readonly StoryCategory[] = []
): EntityExchangeRecord[] {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new EntityExchangeError('That file is not valid JSON.')
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new EntityExchangeError('That file is not a MythScribe entity file.')
  }
  const file = json as Record<string, unknown>
  if (file.format !== ENTITY_EXCHANGE_FORMAT_ID) {
    throw new EntityExchangeError('That file is not a MythScribe entity file.')
  }
  if (file.version !== ENTITY_EXCHANGE_VERSION) {
    throw new EntityExchangeError(
      `That file is version ${String(file.version)}; this version of MythScribe reads version ${ENTITY_EXCHANGE_VERSION}.`
    )
  }
  if (!Array.isArray(file.entities)) {
    throw new EntityExchangeError('That file has no "entities" list.')
  }
  return file.entities.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new EntityExchangeError(`Entity ${index + 1}: not an entity`, index + 1)
    }
    const entry = raw as Record<string, unknown>
    return recordFrom(
      {
        kind: entry.kind,
        name: entry.name,
        template: entry.template,
        fields: rawFields(entry.fields),
        body: entry.body
      },
      index + 1,
      'Entity',
      null,
      categories
    )
  })
}

/**
 * The records of a CSV. The header decides the columns (`name` is the only one a file must have,
 * and an unknown heading is ignored); a row with no `kind` of its own is of `fallbackKind`, the
 * kind whose tab the import was started from, which is how a plain two-column list works.
 */
export function parseEntitiesCsv(
  text: string,
  fallbackKind: EntityKind,
  categories: readonly StoryCategory[] = []
): EntityExchangeRecord[] {
  const rows = parseCsv(text)
  const header = rows[0]
  if (header === undefined || isBlankRow(header)) {
    throw new EntityExchangeError('That file has no rows.')
  }
  const columns = header.map((name) => name.trim().toLowerCase())
  if (!columns.includes('name')) {
    throw new EntityExchangeError('That file has no "name" column.')
  }
  const cellOf = (row: readonly string[], column: string): string | undefined => {
    const index = columns.indexOf(column)
    return index < 0 ? undefined : row[index]
  }
  const records: EntityExchangeRecord[] = []
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index]
    if (row === undefined || isBlankRow(row)) continue
    const fields: Record<string, unknown> = {}
    for (const column of columns) {
      if (['kind', 'name', 'template', 'body'].includes(column)) continue
      const value = cellOf(row, column)
      if (value !== undefined) fields[column] = value
    }
    records.push(
      recordFrom(
        {
          kind: cellOf(row, 'kind'),
          name: cellOf(row, 'name'),
          template: cellOf(row, 'template'),
          fields,
          body: cellOf(row, 'body')
        },
        index,
        'Row',
        fallbackKind,
        categories
      )
    )
  }
  return records
}

/* -------------------------------------------------------------------------- */
/* Planning the merge                                                         */
/* -------------------------------------------------------------------------- */

/** The key an incoming row is matched by: its kind and the entity name key (F-9.1). */
const matchKey = (kind: EntityKind, name: string): string => `${kind}\0${toEntityNameKey(name)}`

/**
 * What an import would do, before anything is written (F-9.5): a row whose name matches an entity
 * of the same kind is offered as a `merge` of that entity, an unmatched row as an `add`. A row
 * that repeats an earlier row's kind and name is dropped and counted — one file cannot hold the
 * same entity twice, and the first spelling wins.
 */
export function planEntityImport(
  existing: readonly EntityLike[],
  incoming: readonly EntityExchangeRecord[]
): { items: EntityImportItem[]; duplicates: number } {
  const byKey = new Map<string, string>()
  for (const entity of existing) byKey.set(matchKey(entity.kind, entity.name), entity.id)
  const seen = new Set<string>()
  const items: EntityImportItem[] = []
  let duplicates = 0
  incoming.forEach((record, index) => {
    const key = matchKey(record.kind, record.name)
    if (seen.has(key)) {
      duplicates += 1
      return
    }
    seen.add(key)
    const existingId = byKey.get(key) ?? null
    items.push({
      id: `r${index + 1}`,
      record,
      existingId,
      action: existingId === null ? 'add' : 'merge'
    })
  })
  return { items, duplicates }
}

/** The actions a row may be given: what it matched decides them. */
export function actionsFor(item: Pick<EntityImportItem, 'existingId'>): EntityImportAction[] {
  return item.existingId === null ? ['add', 'skip'] : ['merge', 'replace', 'skip']
}

const isBlank = (value: string | null): boolean => value === null || value.trim() === ''

/**
 * The patch a matched row applies. `merge` fills only what is empty in the stored entity, so an
 * import can never overwrite the author's own words; `replace` overwrites every value the file
 * has, and takes the file's template. Neither ever erases: an empty incoming value is left out of
 * the patch, so a sparse file does no damage. The name is never patched — the two entities are
 * the same one by name already, and the stored spelling is the author's.
 */
export function mergePatch(
  existing: EntityLike,
  record: EntityExchangeRecord,
  action: 'merge' | 'replace',
  categories: readonly StoryCategory[] = []
): EntityExchangePatch {
  const patch: EntityExchangePatch = {}
  const fields: EntityFields = {}
  for (const id of categoryFieldIds(categoryOf(existing.kind, categories))) {
    const value = record.fields[id]
    if (value === undefined || value === '') continue
    const stored = existing.fields[id]
    if (action === 'merge' && stored !== undefined && stored.trim() !== '') continue
    if (stored === value) continue
    fields[id] = value
  }
  if (Object.keys(fields).length > 0) patch.fields = fields
  if (!isBlank(record.body) && (action === 'replace' || isBlank(existing.body))) {
    if (record.body !== existing.body) patch.body = record.body
  }
  if (action === 'replace' && record.template !== existing.template) {
    patch.template = record.template
  }
  return patch
}

/** How many of each action the author chose, for the dialog's foot and the toast after it. */
export interface EntityImportCounts {
  added: number
  merged: number
  replaced: number
}

/** The chosen actions, counted; `skip` rows are in none of them. */
export function countImportActions(items: readonly EntityImportItem[]): EntityImportCounts {
  const counts: EntityImportCounts = { added: 0, merged: 0, replaced: 0 }
  for (const item of items) {
    if (item.action === 'add') counts.added += 1
    else if (item.action === 'merge') counts.merged += 1
    else if (item.action === 'replace') counts.replaced += 1
  }
  return counts
}

/** The default file name an export is offered under: `<project>-<category name>.<ext>`. */
export function entityExportFileName(
  projectName: string,
  categoryName: string,
  format: EntityExchangeFormat
): string {
  const name = categoryName.toLowerCase().replace(/[\\/:*?"<>|]+/g, '-')
  return `${projectName}-${name}.${ENTITY_EXCHANGE_EXTENSIONS[format]}`
}
