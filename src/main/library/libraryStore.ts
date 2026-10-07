import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import type { RunResult } from 'better-sqlite3'
import { ASSET_ID_CHARS, assetFileName } from '@shared/assets'
import {
  CONTEXT_FILE_MAX_BYTES,
  CONTEXT_LIBRARY_DIR,
  contextFileState,
  contextFileTypeOf,
  type ContextAddResult,
  type ContextFile,
  type ContextSkipped
} from '@shared/contextLibrary'
import type * as schema from '../db/schema'
import { contextFile, type ContextFileRow } from '../db/schema'
import { AppError } from '../ipc/errors'
import { ASSETS_DIR } from '../project/projectStore'
import { countTextWords, extractContextText } from './extract'

export type LibraryDb = BaseSQLiteDatabase<'sync', RunResult, typeof schema>

/**
 * The context library's files (F-9.8): the rows of `context_file` and the originals they point
 * at under `<project>/assets/library/`. Copying the project folder copies the library; the
 * originals are never changed, only replaced by a newer upload of the same file.
 */

/** The folder that holds the originals. */
export function libraryDir(folder: string): string {
  return path.join(folder, ASSETS_DIR, CONTEXT_LIBRARY_DIR)
}

/**
 * The stored original of a row. A stored name with a path separator or `..` (a hand-edited row)
 * is refused, so nothing outside the library folder is ever opened or read.
 */
export function storedPath(folder: string, stored: string): string {
  if (
    stored === '' ||
    stored === '.' ||
    stored === '..' ||
    stored.includes('/') ||
    stored.includes('\\') ||
    stored.includes('\0')
  ) {
    throw new AppError('VALIDATION', `"${stored}" is not a stored library file`, { stored })
  }
  return path.join(libraryDir(folder), stored)
}

export function toContextFile(row: ContextFileRow): ContextFile {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    size: row.size,
    words: row.words,
    state: contextFileState(row),
    created: row.created,
    modified: row.modified,
    processedAt: row.processedAt
  }
}

/** Every file, newest first (ties by name). */
export function listContextFiles(db: LibraryDb): ContextFile[] {
  return db
    .select()
    .from(contextFile)
    .orderBy(desc(contextFile.created), contextFile.name)
    .all()
    .map(toContextFile)
}

export function getContextFileRow(db: LibraryDb, id: string): ContextFileRow | undefined {
  return db.select().from(contextFile).where(eq(contextFile.id, id)).get()
}

/** The row with this id, or NOT_FOUND. */
export function requireContextFileRow(db: LibraryDb, id: string): ContextFileRow {
  const row = getContextFileRow(db, id)
  if (row === undefined) throw new AppError('NOT_FOUND', 'That file is no longer in the Library', { id })
  return row
}

/** The text of a stored original, extracted again (null for an image or a file with no text). */
export async function readContextText(folder: string, row: ContextFileRow): Promise<string | null> {
  if (row.type === 'image') return null
  return extractContextText(row.type, fs.readFileSync(storedPath(folder, row.stored)))
}

/** One file to add: its name and how to read it (from disk, or the bytes a drop carried). */
export interface ContextSource {
  name: string
  read: () => Buffer
}

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The extension of a name, lower-cased (`''` for none). */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * Adds files to the library (F-9.8). Each one is checked (a type the library takes, at most
 * `CONTEXT_FILE_MAX_BYTES`, readable), its text extracted, and its original copied in under a
 * minted name. A file whose name matches a stored one (any case) — or the row `replaceId` names,
 * when the author chose "Update" — is an update: an identical file changes nothing, a different
 * one replaces the stored original and keeps what was last sorted, so only the changes are sent
 * next time. A refused file is skipped with the reason, never the whole batch.
 */
export async function addContextFiles(
  db: LibraryDb,
  folder: string,
  sources: readonly ContextSource[],
  replaceId?: string
): Promise<ContextAddResult> {
  const changed: string[] = []
  const skipped: ContextSkipped[] = []
  let unchanged = 0
  const replacing = replaceId === undefined ? undefined : requireContextFileRow(db, replaceId)
  for (const source of sources) {
    const name = path.basename(source.name)
    const type = contextFileTypeOf(name)
    if (type === null) {
      skipped.push({ name, reason: 'The Library takes Word, Markdown, text, PDF, and image files.' })
      continue
    }
    let data: Buffer
    try {
      data = source.read()
    } catch (err) {
      skipped.push({ name, reason: `Could not read the file: ${messageOf(err)}` })
      continue
    }
    if (data.length > CONTEXT_FILE_MAX_BYTES) {
      const limit = Math.round(CONTEXT_FILE_MAX_BYTES / (1024 * 1024))
      skipped.push({ name, reason: `The file is larger than ${limit} MB.` })
      continue
    }
    let text: string | null
    try {
      text = await extractContextText(type, data)
    } catch (err) {
      skipped.push({ name, reason: `Could not read the file: ${messageOf(err)}` })
      continue
    }
    const hash = sha256(data)
    const target =
      replacing ??
      db
        .select()
        .from(contextFile)
        .all()
        .find((row) => row.name.toLowerCase() === name.toLowerCase())
    if (target?.hash === hash) {
      unchanged += 1
      continue
    }
    const stored = writeOriginal(folder, name, data)
    const now = new Date().toISOString()
    const values = {
      name,
      type,
      size: data.length,
      hash,
      stored,
      words: countTextWords(text),
      textHash: text === null ? null : sha256(text),
      modified: now
    }
    try {
      if (target === undefined) {
        const id = randomUUID()
        db.insert(contextFile)
          .values({ id, ...values, created: now })
          .run()
        changed.push(id)
      } else {
        db.update(contextFile).set(values).where(eq(contextFile.id, target.id)).run()
        changed.push(target.id)
      }
    } catch (err) {
      fs.rmSync(path.join(libraryDir(folder), stored), { force: true })
      throw err
    }
    // The previous original goes only once the row points at the new one.
    if (target !== undefined) fs.rmSync(storedPath(folder, target.stored), { force: true })
  }
  return { files: listContextFiles(db), changed, unchanged, skipped }
}

/** Writes an original into the library under a minted name and answers the name. */
function writeOriginal(folder: string, name: string, data: Buffer): string {
  const dir = libraryDir(folder)
  fs.mkdirSync(dir, { recursive: true })
  const stored = assetFileName(
    name,
    randomUUID().replace(/-/g, '').slice(0, ASSET_ID_CHARS),
    'file',
    extensionOf(name) || 'bin'
  )
  fs.writeFileSync(path.join(dir, stored), data, { flag: 'wx' })
  return stored
}

/** Records that a file's current text was sorted into the story bible (Apply, F-9.8). */
export function markContextFileProcessed(
  db: LibraryDb,
  id: string,
  text: string | null,
  at: string
): void {
  const row = requireContextFileRow(db, id)
  db.update(contextFile)
    .set({ processedText: text, processedHash: text === null ? null : row.textHash, processedAt: at })
    .where(eq(contextFile.id, id))
    .run()
}
