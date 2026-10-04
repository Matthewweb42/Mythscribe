import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { RecoveryKind } from '@shared/recovery'
import { TiptapNode, type TiptapNodeT } from '@shared/tiptap'
import { writeTextAtomic } from '../fs'
import { AppError } from '../ipc/errors'

/**
 * The recovery journal (F-8.3): one file per record with unsaved editor state, under
 * `<Project>.mythscribe/recovery/`, named `<kind>-<id>.json`. The renderer stashes the latest
 * state on a short throttle and clears it once the real save lands, so whatever is left after a
 * crash is exactly what the database is missing. Writes go through a temp file and a rename (an
 * app crash keeps the page cache, so no fsync); a half-written `.tmp` is never read.
 */
export const RECOVERY_DIR = 'recovery'

const SAFE_ID = /^[A-Za-z0-9-]+$/

const JournalEntry = z.object({ kind: RecoveryKind, id: z.string(), content: TiptapNode })

export interface RecoveryEntry {
  kind: RecoveryKind
  id: string
  content: TiptapNodeT
}

export function recoveryDir(folder: string): string {
  return path.join(folder, RECOVERY_DIR)
}

/** The entry's file; refuses an id that could leave the folder (node ids are UUIDs). */
function entryFile(folder: string, kind: RecoveryKind, id: string): string {
  if (!SAFE_ID.test(id)) {
    throw new AppError('VALIDATION', `Not a valid record id: ${id}`, { id })
  }
  return path.join(recoveryDir(folder), `${kind}-${id}.json`)
}

/** Writes (or replaces) one record's journal entry. */
export function stashRecovery(
  folder: string,
  kind: RecoveryKind,
  id: string,
  content: TiptapNodeT
): void {
  const file = entryFile(folder, kind, id)
  fs.mkdirSync(recoveryDir(folder), { recursive: true })
  const entry: RecoveryEntry = { kind, id, content }
  writeTextAtomic(file, JSON.stringify(entry))
}

/** Deletes one record's journal entry; a missing entry is fine. */
export function clearRecovery(folder: string, kind: RecoveryKind, id: string): void {
  fs.rmSync(entryFile(folder, kind, id), { force: true })
}

/**
 * Every readable entry in the journal, sorted by file name. Files that do not parse, whose
 * content does not match their name, and leftover `.tmp` files are deleted; a missing folder
 * answers empty.
 */
export function readRecovery(folder: string): RecoveryEntry[] {
  const dir = recoveryDir(folder)
  if (!fs.existsSync(dir)) return []
  const entries: RecoveryEntry[] = []
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
  for (const name of names) {
    const file = path.join(dir, name)
    const entry = name.endsWith('.json') ? parseEntry(file) : null
    if (entry === null || name !== `${entry.kind}-${entry.id}.json` || !SAFE_ID.test(entry.id)) {
      fs.rmSync(file, { force: true })
      continue
    }
    entries.push(entry)
  }
  return entries
}

function parseEntry(file: string): RecoveryEntry | null {
  try {
    const parsed = JournalEntry.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Deletes the whole journal. */
export function discardRecovery(folder: string): void {
  fs.rmSync(recoveryDir(folder), { recursive: true, force: true })
}
