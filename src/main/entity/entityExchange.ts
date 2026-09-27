import fs from 'node:fs'
import path from 'node:path'
import type { EntityKind } from '@shared/entities'
import {
  ENTITY_EXCHANGE_EXTENSIONS,
  EntityExchangeError,
  entityExchangeFormatOf,
  mergePatch,
  parseEntitiesCsv,
  parseEntitiesJson,
  serializeEntitiesCsv,
  serializeEntitiesJson,
  type EntityExchangeFormat,
  type EntityExchangeRecord,
  type EntityImportItem
} from '@shared/entityExchange'
import type { Entity } from '@shared/ipc/contract'
import { writeTextAtomic } from '../fs'
import { AppError } from '../ipc/errors'
import {
  createEntity,
  getEntity,
  updateEntity,
  type EntityDb,
  type EntityTagChange
} from './entityStore'

/**
 * Entity export and import in main (F-9.5): the file, the parsers' refusals as `AppError`s, and
 * the one transaction that applies a reviewed plan. Everything about the formats and the merge
 * itself lives in `@shared/entityExchange`, so the review dialog plans against the same rules.
 */

/** What a file said, and which file said it, for the plan the renderer reviews. */
export interface EntityFileRead {
  /** The file's base name, extension included; the dialog's heading. */
  name: string
  format: EntityExchangeFormat
  records: EntityExchangeRecord[]
}

/**
 * Reads an entity library or CSV (F-9.5). The extension picks the parser; a CSV row with no kind
 * of its own is of `fallbackKind`, the kind the import was started from. Every refusal — an
 * extension we do not read, an unreadable file, a file of another format, a row with a bad value
 * — is VALIDATION with the parser's own message, which names the row.
 */
export function readEntityFile(file: string, fallbackKind: EntityKind): EntityFileRead {
  const name = path.basename(file)
  const format = entityExchangeFormatOf(name)
  if (format === null) {
    const extensions = Object.values(ENTITY_EXCHANGE_EXTENSIONS)
      .map((extension) => `.${extension}`)
      .join(' or ')
    throw new AppError('VALIDATION', `Unsupported file type: entities are read from ${extensions}`, {
      file: name
    })
  }
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    throw new AppError('VALIDATION', `Could not read the file: ${describe(err)}`, { file: name })
  }
  let records: EntityExchangeRecord[]
  try {
    records = format === 'json' ? parseEntitiesJson(text) : parseEntitiesCsv(text, fallbackKind)
  } catch (err) {
    if (err instanceof EntityExchangeError) {
      throw new AppError('VALIDATION', err.message, { file: name, row: err.row })
    }
    throw err
  }
  if (records.length === 0) {
    throw new AppError('VALIDATION', 'That file has no entities to import.', { file: name })
  }
  return { name, format, records }
}

/** An unexpected read failure as one line; the path is left out, the dialog already showed it. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Writes the records where the author chose, atomically, in the format they chose (F-9.5). */
export function writeEntityFile(
  file: string,
  format: EntityExchangeFormat,
  records: readonly EntityExchangeRecord[]
): void {
  const text = format === 'json' ? serializeEntitiesJson(records) : serializeEntitiesCsv(records)
  writeTextAtomic(file, text)
}

/** What one import wrote: the rows for the renderer's bank, the counts, and the tags it touched. */
export interface EntityImportResult {
  entities: Entity[]
  added: number
  merged: number
  replaced: number
  /** Every tag an `add` created or linked (F-9.4); the handler publishes them in one batch. */
  tagChanges: EntityTagChange[]
}

/**
 * Applies a reviewed import (F-9.5) in one transaction: all of it or none of it, so a name taken
 * since the plan was made (ALREADY_EXISTS) or an entity deleted since (NOT_FOUND) leaves the story
 * bible exactly as it was. A matched row whose patch turns out to be empty still counts as merged
 * or replaced — the author chose it, and `updateEntity` only stamps `modified`.
 */
export function importEntities(db: EntityDb, items: readonly EntityImportItem[]): EntityImportResult {
  return db.transaction((tx) => {
    const result: EntityImportResult = {
      entities: [],
      added: 0,
      merged: 0,
      replaced: 0,
      tagChanges: []
    }
    for (const item of items) {
      if (item.action === 'skip') continue
      if (item.action === 'add') {
        const write = createEntity(tx, {
          kind: item.record.kind,
          name: item.record.name,
          template: item.record.template,
          fields: item.record.fields,
          body: item.record.body
        })
        result.entities.push(write.entity)
        if (write.tagChange !== null) result.tagChanges.push(write.tagChange)
        result.added += 1
        continue
      }
      const id = item.existingId
      if (id === null) {
        throw new AppError('VALIDATION', `"${item.record.name}" has nothing to ${item.action}`, {
          item: item.id
        })
      }
      const existing = getEntity(tx, id)
      if (existing === undefined) throw new AppError('NOT_FOUND', 'Entity not found', { id })
      const write = updateEntity(tx, id, mergePatch(existing, item.record, item.action))
      result.entities.push(write.entity)
      if (write.tagChange !== null) result.tagChanges.push(write.tagChange)
      if (item.action === 'merge') result.merged += 1
      else result.replaced += 1
    }
    return result
  })
}
