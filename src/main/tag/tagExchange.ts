import fs from 'node:fs'
import path from 'node:path'
import {
  TagExchangeError,
  parseTagBank,
  serializeTagBank,
  type TagExchangeRecord
} from '@shared/tagExchange'
import { writeTextAtomic } from '../fs'
import { AppError } from '../ipc/errors'

/**
 * Tag bank export and import in main (F-4.9): the file and the parser's refusals as `AppError`s.
 * The format itself lives in `@shared/tagExchange`; the bank writes are in `tagStore`.
 */

/**
 * Reads a tag bank file. An unreadable file, one that is not a tag bank (the parser's message,
 * `row` in the details for a bad record), or one with no tags is VALIDATION.
 */
export function readTagBankFile(file: string): TagExchangeRecord[] {
  const name = path.basename(file)
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    throw new AppError('VALIDATION', `Could not read the file: ${describe(err)}`, { file: name })
  }
  let records: TagExchangeRecord[]
  try {
    records = parseTagBank(text)
  } catch (err) {
    if (err instanceof TagExchangeError) {
      throw new AppError('VALIDATION', err.message, { file: name, row: err.row })
    }
    throw err
  }
  if (records.length === 0) {
    throw new AppError('VALIDATION', 'That file has no tags to import.', { file: name })
  }
  return records
}

/** Writes the bank where the author chose, atomically. */
export function writeTagBankFile(file: string, records: readonly TagExchangeRecord[]): void {
  writeTextAtomic(file, serializeTagBank([...records]))
}

/** An unexpected read failure as one line; the path is left out, the dialog already showed it. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
