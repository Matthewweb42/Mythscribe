import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { estimateTokens, inputBudget } from '@shared/ai'
import { changeRunId } from '@shared/changes'
import { ENTITY_FIELD_MAX, type EntityFieldDef, type EntityFields } from '@shared/entities'
import type { Entity } from '@shared/ipc/contract'
import {
  REFILE_CHUNK_CHARS,
  applyRefile,
  chunkParagraphs,
  layoutWriteUp,
  pageEdits,
  paragraphsOf,
  sheetFieldDefs,
  type RefileAdd,
  type RefileEdit,
  type SheetSyncState,
  type WriteUpAnswer
} from '@shared/sheetSync'
import { writeUpRoleOf } from '@shared/storyBibleSettings'
import {
  getEntity,
  sheetSyncRow,
  updateEntity,
  writeExtraFields,
  writeSheetSync,
  type EntityDb
} from '../entity/entityStore'
import {
  pageKey,
  paragraphHash,
  sheetBasis,
  sheetSyncContext,
  sheetSyncStateOf,
  type SheetBasis,
  type StoredSheetSync
} from '../entity/sheetSyncState'
import { AppError } from '../ipc/errors'
import { logChanges, sheetEditChange } from '../knowledge/changeLog'
import { getAiSettings } from '../project/settingsStore'
import { assertFeatureAllowed } from './dial'
import { buildSheetRefilePrompt } from './prompts/sheetRefile.v1'
import { buildSheetWriteUpPrompt, type SheetPromptField } from './prompts/sheetWriteUp.v1'
import { AiFallbackError } from './providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from './request'

/**
 * Two views of every sheet, kept true to each other (F-9.18): the requests. One run looks at one
 * sheet: nothing is sent while its hashes say both views agree (or a held sync still matches);
 * a page edited since the last sync is filed into the fields first (`sheetRefile.v1`, one request
 * per `REFILE_CHUNK_CHARS` of added text); fields moved since are written up as the page
 * (`sheetWriteUp.v1`). Fast tier, JSON, cached by context (`runAiRequest`). An answer that comes
 * back after the author changed the sheet again is dropped: their next pause queues a fresh run.
 *
 * The result lands on the sheet on its own in every chat mode (decided by the author 2026-10-10:
 * it is the author's own text in the other view), logged in the Changes log (source `sync`) with
 * an Undo. Two safety rules: an emptied
 * page never empties the fields, and fields with no text never empty the page.
 */

export interface SheetSyncRunResult {
  /** Whether a provider request was made (a cache hit is not one). */
  requested: boolean
  /** What happened: nothing to do, applied to the sheet, or dropped as stale. */
  outcome: 'nothing' | 'applied' | 'dropped'
  /** The sheet as it now stands, when the run wrote anything to it (its state included). */
  entity: Entity | null
  /** Whether the Changes log moved. */
  logged: boolean
}

const BAD_FORMAT = 'The model did not answer in the expected format.'

const WriteUpModelAnswer = z.object({
  intro: z.string().optional(),
  parts: z.record(z.string(), z.unknown()).optional()
})

/** The model's `{ intro, parts }`: PROVIDER when it is not JSON of that shape; a part that is not text is dropped. */
export function parseWriteUpAnswer(text: string): WriteUpAnswer {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    throw new AiFallbackError(BAD_FORMAT, err)
  }
  const answer = WriteUpModelAnswer.safeParse(json)
  if (!answer.success) throw new AiFallbackError(BAD_FORMAT, answer.error)
  const parts: Record<string, string> = {}
  for (const [id, value] of Object.entries(answer.data.parts ?? {})) {
    if (typeof value === 'string' && value.trim() !== '') parts[id] = value
  }
  return { intro: answer.data.intro ?? '', parts }
}

const RefileModelAnswer = z.object({
  edits: z.array(z.unknown()).optional(),
  add: z.array(z.unknown()).optional()
})
const ModelEdit = z.object({
  f: z.string(),
  old: z.string().optional(),
  new: z.string().optional()
})
const ModelAdd = z.object({ label: z.string(), value: z.string() })

/** The model's `{ edits, add }`: PROVIDER when it is not JSON of that shape; a malformed entry is dropped. */
export function parseRefileAnswer(text: string): { edits: RefileEdit[]; adds: RefileAdd[] } {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    throw new AiFallbackError(BAD_FORMAT, err)
  }
  const answer = RefileModelAnswer.safeParse(json)
  if (!answer.success) throw new AiFallbackError(BAD_FORMAT, answer.error)
  const edits: RefileEdit[] = []
  for (const entry of answer.data.edits ?? []) {
    const edit = ModelEdit.safeParse(entry)
    if (edit.success)
      edits.push({ f: edit.data.f, old: edit.data.old ?? '', new: edit.data.new ?? '' })
  }
  const adds: RefileAdd[] = []
  for (const entry of answer.data.add ?? []) {
    const add = ModelAdd.safeParse(entry)
    if (add.success) adds.push(add.data)
  }
  return { edits, adds }
}

/** Cuts a value to `max` characters at a word boundary, marking the cut. */
function cut(value: string, max: number): string {
  if (value.length <= max) return value
  const slice = value.slice(0, Math.max(0, max - 1))
  const boundary = slice.search(/\s\S*$/)
  return `${(boundary > 0 ? slice.slice(0, boundary) : slice).trimEnd()}…`
}

/** The fields as a prompt sends them, in page order. */
function promptFields(defs: readonly EntityFieldDef[], values: EntityFields): SheetPromptField[] {
  return defs.map((field) => ({
    id: field.id,
    label: field.label,
    value: (values[field.id] ?? '').trim()
  }))
}

const messagesTokens = (messages: readonly { content: string }[]): number =>
  estimateTokens(messages.map((message) => message.content).join('\n'))

/**
 * The write-up request, fitted to the input budget (CLAUDE.md, token rule 8): while it is over,
 * the longest value is cut by a fifth (a long field still reads, shorter). Answers the page laid
 * out in the author's style.
 */
async function requestWriteUp(
  deps: AiRequestDeps,
  sheet: Entity,
  basis: SheetBasis,
  requestId: string | undefined
): Promise<{ page: string; requested: boolean }> {
  const fields = basis.defs.map((def) => ({
    id: def.id,
    label: def.label,
    value: (sheet.fields[def.id] ?? '').trim(),
    heading: writeUpRoleOf(basis.style, def) === 'heading'
  }))
  const build = (): ReturnType<typeof buildSheetWriteUpPrompt> =>
    buildSheetWriteUpPrompt({
      name: sheet.name,
      noun: basis.category.noun,
      length: basis.style.length,
      fields
    })
  let prompt = build()
  while (messagesTokens(prompt.messages) > inputBudget('sheetSync')) {
    const longest = fields.reduce((a, b) => (b.value.length > a.value.length ? b : a))
    if (longest.value.length < 200) break
    longest.value = cut(longest.value, Math.floor(longest.value.length * 0.8))
    prompt = build()
  }
  const result = await runAiRequest(deps, {
    feature: 'sheetSync',
    tier: 'fast',
    messages: prompt.messages,
    maxTokens: prompt.maxTokens,
    json: true,
    contextHash: sha256(JSON.stringify(prompt.messages)),
    promptVersion: prompt.version,
    ...(requestId === undefined ? {} : { requestId })
  })
  const page = layoutWriteUp(basis.defs, basis.style, parseWriteUpAnswer(result.text))
  if (page.trim() === '') throw new AiFallbackError('The model wrote an empty page.')
  return { page, requested: !result.cached }
}

/**
 * The filing requests: the removed paragraphs go with the first, the added ones in chunks of
 * `REFILE_CHUNK_CHARS`; each chunk is filed into the values the previous one left. Answers every
 * field's value after the filing and the sheet's own fields (new ones appended).
 */
async function requestFiling(
  deps: AiRequestDeps,
  sheet: Entity,
  basis: SheetBasis,
  edits: { removed: string[]; added: string[] },
  requestId: string | undefined
): Promise<{ values: Record<string, string>; extra: EntityFieldDef[]; requested: boolean }> {
  let values: Record<string, string> = {}
  for (const [id, value] of Object.entries(sheet.fields))
    if (value !== undefined) values[id] = value
  let extra = [...sheet.extraFields]
  let requested = false
  const chunks = edits.added.length === 0 ? [[]] : chunkParagraphs(edits.added, REFILE_CHUNK_CHARS)
  for (const [index, chunk] of chunks.entries()) {
    const defs = sheetFieldDefs(basis.category, extra)
    const prompt = buildSheetRefilePrompt({
      name: sheet.name,
      noun: basis.category.noun,
      fields: promptFields(defs, values),
      removed: index === 0 ? edits.removed : [],
      added: chunk
    })
    const result = await runAiRequest(deps, {
      feature: 'sheetSync',
      tier: 'fast',
      messages: prompt.messages,
      maxTokens: prompt.maxTokens,
      json: true,
      contextHash: sha256(JSON.stringify(prompt.messages)),
      promptVersion: prompt.version,
      // One id for every chunk (they go one after another), so a cancel stops whichever is out.
      ...(requestId === undefined ? {} : { requestId })
    })
    if (!result.cached) requested = true
    const answer = parseRefileAnswer(result.text)
    const filed = applyRefile(defs, extra, values, answer.edits, answer.adds)
    values = filed.values
    extra = filed.extra
  }
  for (const [id, value] of Object.entries(values)) values[id] = value.slice(0, ENTITY_FIELD_MAX)
  return { values, extra, requested }
}

/** The values a filing changes against the sheet as it stands ('' empties a field). */
function changedValues(
  sheet: Entity,
  values: Readonly<Record<string, string>>,
  defs: readonly EntityFieldDef[]
): Record<string, string> {
  const changed: Record<string, string> = {}
  for (const field of defs) {
    const next = (values[field.id] ?? '').trim()
    if (next !== (sheet.fields[field.id] ?? '').trim()) changed[field.id] = next
  }
  return changed
}

/** Whether the sheet still reads as the basis a run was built from. */
function unchanged(db: EntityDb, id: string, basis: SheetBasis): Entity | null {
  const now = getEntity(db, id)
  if (now === undefined) return null
  const again = sheetBasis(now, sheetSyncContext(db))
  return again.fieldsHash === basis.fieldsHash && again.page === basis.page ? now : null
}

const stamp = (deps: AiRequestDeps): string => deps.now().toISOString()

/** The stored sync after the views were made to agree; the AI paragraphs carried unless a write-up replaced them. */
function agreed(
  previous: StoredSheetSync | null,
  patch: Partial<StoredSheetSync> & Pick<StoredSheetSync, 'fieldsHash' | 'page' | 'at'>
): StoredSheetSync {
  return {
    aiParagraphs: previous?.aiParagraphs ?? [],
    writtenUpAt: previous?.writtenUpAt ?? null,
    // Only a write-up records the page it replaced (`staleWriteUpBase`).
    pageBefore: null,
    ...patch
  }
}

/** Writes a filing to the sheet (its new fields first, so the values are accepted), logs it, and answers the sheet. */
function writeFiling(
  db: EntityDb,
  sheet: Entity,
  values: Readonly<Record<string, string>>,
  extra: readonly EntityFieldDef[],
  run: string,
  now: string
): { entity: Entity; logged: boolean } {
  return db.transaction((tx) => {
    if (JSON.stringify(extra) !== JSON.stringify(sheet.extraFields))
      writeExtraFields(tx, sheet.id, extra)
    const after =
      Object.keys(values).length === 0
        ? (getEntity(tx, sheet.id) ?? sheet)
        : updateEntity(tx, sheet.id, { fields: values }).entity
    const change = sheetEditChange(sheet, after, `${sheet.name}: page edits filed into the fields`)
    if (change !== null) logChanges(tx, run, [change], now)
    return { entity: after, logged: change !== null }
  })
}

/** Writes a write-up to the sheet's page, logs it, and answers the sheet. */
function writePage(
  db: EntityDb,
  sheet: Entity,
  page: string,
  run: string,
  now: string
): { entity: Entity; logged: boolean } {
  return db.transaction((tx) => {
    const after = updateEntity(tx, sheet.id, { body: page }).entity
    const change = sheetEditChange(sheet, after, `${sheet.name}: page written up from the fields`)
    if (change !== null) logChanges(tx, run, [change], now)
    return { entity: after, logged: change !== null }
  })
}

/** A sheet as a run reads it: the row, its stored sync, its basis, and its state. NOT_FOUND when gone. */
function readSheet(
  db: EntityDb,
  id: string
): { sheet: Entity; stored: StoredSheetSync | null; basis: SheetBasis; state: SheetSyncState } {
  const sheet = getEntity(db, id)
  const raw = sheetSyncRow(db, id)
  if (sheet === undefined || raw === undefined) {
    throw new AppError('NOT_FOUND', 'Entity not found', { id })
  }
  const basis = sheetBasis(sheet, sheetSyncContext(db))
  return { sheet, stored: raw.sync, basis, state: sheetSyncStateOf(basis, raw.sync) }
}

/**
 * Makes one sheet's two views true to each other (F-9.18). The gate first (`sheetSync`: Use AI
 * and its toggle); NOT_FOUND for a sheet that is gone (the queue drops it quietly).
 */
export async function runSheetSync(
  db: EntityDb,
  deps: AiRequestDeps,
  input: { entityId: string; requestId?: string }
): Promise<SheetSyncRunResult> {
  const settings = getAiSettings(db)
  assertFeatureAllowed(settings, 'sheetSync')
  const run = changeRunId('sync', randomUUID())
  const result: SheetSyncRunResult = {
    requested: false,
    outcome: 'nothing',
    entity: null,
    logged: false
  }
  let read = readSheet(db, input.entityId)
  if (read.state === 'none' || read.state === 'synced') return result

  if (read.state === 'fieldsStale' || read.state === 'both') {
    const { sheet, basis, stored } = read
    // A sheet synced before whose fields moved too gets its page written up after the filing. A
    // sheet never synced keeps its page as the author wrote it: only its fields are filled.
    const pageStaleAfter = read.state === 'both' && stored !== null
    const at = stamp(deps)
    if (paragraphsOf(basis.page).length === 0) {
      // An emptied page never empties the fields: the views agree again on what the fields hold.
      writeSheetSync(
        db,
        sheet.id,
        agreed(stored, { fieldsHash: pageStaleAfter ? '' : basis.fieldsHash, page: '', at })
      )
    } else {
      const edits = pageEdits(stored?.page ?? '', basis.page)
      const filing = await requestFiling(deps, sheet, basis, edits, input.requestId)
      result.requested ||= filing.requested
      const now = unchanged(db, sheet.id, basis)
      if (now === null) return { ...result, outcome: 'dropped' }
      const values = changedValues(now, filing.values, sheetFieldDefs(basis.category, filing.extra))
      const written = writeFiling(db, now, values, filing.extra, run, at)
      const after = sheetBasis(written.entity, sheetSyncContext(db))
      writeSheetSync(
        db,
        sheet.id,
        agreed(stored, {
          fieldsHash: pageStaleAfter ? '' : after.fieldsHash,
          page: basis.page,
          at
        })
      )
      result.outcome = 'applied'
      result.logged = written.logged
    }
    result.entity = getEntity(db, sheet.id) ?? null
    if (!pageStaleAfter) return result
    // The fields had moved too: write the page up from them now.
    read = readSheet(db, sheet.id)
    if (read.state !== 'pageStale') return result
  }

  // The page is out of date: write it up from the fields.
  const { sheet, basis, stored } = read
  const at = stamp(deps)
  if (!basis.fieldsFilled) {
    // Fields with no text never empty the page.
    writeSheetSync(
      db,
      sheet.id,
      agreed(stored, { fieldsHash: basis.fieldsHash, page: basis.page, at })
    )
    return { ...result, entity: getEntity(db, sheet.id) ?? null }
  }
  const writeUp = await requestWriteUp(deps, sheet, basis, input.requestId)
  result.requested ||= writeUp.requested
  const now = unchanged(db, sheet.id, basis)
  if (now === null) return { ...result, outcome: 'dropped' }
  const aiParagraphs = paragraphsOf(writeUp.page).map(paragraphHash)
  const written = writePage(db, now, writeUp.page, run, at)
  writeSheetSync(
    db,
    sheet.id,
    agreed(stored, {
      fieldsHash: basis.fieldsHash,
      page: writeUp.page,
      aiParagraphs,
      writtenUpAt: at,
      pageBefore: basis.page,
      at
    })
  )
  return {
    ...result,
    outcome: 'applied',
    logged: result.logged || written.logged,
    entity: getEntity(db, sheet.id) ?? null
  }
}

/** Whether a sheet has anything to sync now (its views disagree). */
export function sheetNeedsSync(db: EntityDb, entityId: string): boolean {
  const sheet = getEntity(db, entityId)
  const raw = sheetSyncRow(db, entityId)
  if (sheet === undefined || raw === undefined) return false
  const basis = sheetBasis(sheet, sheetSyncContext(db))
  const state = sheetSyncStateOf(basis, raw.sync)
  return state !== 'none' && state !== 'synced'
}

/**
 * The page an author's page save was edited from, when that save was made from a draft older than
 * the write-up the sync just landed (`baseModified`, the sheet's `modified` stamp the draft's page
 * was read at, no longer the sheet's, while the page is still exactly the AI's write-up). Null
 * otherwise. The author's typing wins over the write-up (the save goes through as it is), and
 * `rebaseAuthorPage` then makes the next filing read only the author's own edits.
 */
export function staleWriteUpBase(
  db: EntityDb,
  entityId: string,
  baseModified: string
): string | null {
  const sheet = getEntity(db, entityId)
  const raw = sheetSyncRow(db, entityId)
  if (sheet === undefined || raw?.sync == null) return null
  const stored = raw.sync
  if (stored.writtenUpAt === null || stored.pageBefore === null) return null
  if (sheet.modified === baseModified) return null
  return pageKey(sheet.body) === pageKey(stored.page) ? stored.pageBefore : null
}

/**
 * After an author's page save that replaced a write-up they had not seen (`staleWriteUpBase`):
 * the views now agree on the fields as they stand and on the page the author edited from, so the
 * next sync files exactly the author's edits into the fields and leaves their page as written.
 */
export function rebaseAuthorPage(db: EntityDb, entityId: string, page: string, now: Date): void {
  const sheet = getEntity(db, entityId)
  const raw = sheetSyncRow(db, entityId)
  if (sheet === undefined || raw?.sync == null) return
  const basis = sheetBasis(sheet, sheetSyncContext(db))
  writeSheetSync(db, entityId, {
    ...raw.sync,
    fieldsHash: basis.fieldsHash,
    page,
    pageBefore: null,
    at: now.toISOString()
  })
}
