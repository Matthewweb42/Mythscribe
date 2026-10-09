import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChangePage } from '@shared/changes'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import type { TreeDb } from '../tree/treeStore'
import { listChanges, undoChange, undoRun } from './changeLog'

/**
 * F-9.15 widened `CHANGE_KINDS` with no migration, so a database a newer build wrote can hold a
 * kind this build does not know. The renderer parses `changes:list` with `ChangePage`, so one
 * such row must not take the whole Changes section down: it is skipped.
 */

let tmp: string
let session: ProjectSession
let db: TreeDb

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-changes-fwd-'))
  session = createProject(projectFolderFor(tmp, 'Fwd'), 'Fwd', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const insert = (id: string, kind: string, undo: string, createdAt: string): void => {
  db.run(sql`INSERT INTO knowledge_change
    (id, run_id, created_at, node_id, quote, kind, entity_id, target_id, label, undo, status)
    VALUES (${id}, 'organise:org-1', ${createdAt}, NULL, NULL, ${kind}, NULL, 't', ${id}, ${undo}, 'applied')`)
}

describe('listChanges with rows a newer build wrote (F-9.15)', () => {
  it('skips a row of an unknown kind or undo instead of failing the page', () => {
    insert(
      'known',
      'merge',
      JSON.stringify({ type: 'none', reason: 'No.' }),
      '2026-10-09T10:00:00Z'
    )
    insert(
      'future',
      'relationEdit',
      JSON.stringify({ type: 'restoreRelation', id: 'x' }),
      '2026-10-09T10:00:01Z'
    )
    const page = listChanges(db, { limit: 10 })
    expect(() => ChangePage.parse(page)).not.toThrow()
    expect(page.entries.map((entry) => entry.id)).toEqual(['known'])
  })

  it('reads a page on past unreadable rows, and keeps its cursor', () => {
    insert('old', 'merge', JSON.stringify({ type: 'none', reason: 'No.' }), '2026-10-09T10:00:00Z')
    insert('bad-json', 'merge', '{not json', '2026-10-09T10:00:01Z')
    insert('f1', 'relationEdit', '{}', '2026-10-09T10:00:02Z')
    insert('new', 'merge', JSON.stringify({ type: 'none', reason: 'No.' }), '2026-10-09T10:00:03Z')
    const first = listChanges(db, { limit: 1 })
    expect(first).toEqual({ entries: [expect.objectContaining({ id: 'new' })], more: true })
    expect(listChanges(db, { before: 'new', limit: 1 })).toEqual({
      entries: [expect.objectContaining({ id: 'old' })],
      more: false
    })
  })

  it('passes an unreadable row over in Undo run, and refuses it alone without throwing raw', () => {
    insert('future', 'relationEdit', '{not json', '2026-10-09T10:00:01Z')
    insert(
      'known',
      'merge',
      JSON.stringify({ type: 'none', reason: 'No.' }),
      '2026-10-09T10:00:00Z'
    )
    expect(undoRun(db, 'organise:org-1').entries).toEqual([])
    expect(() => undoChange(db, 'future')).toThrowError(/This change cannot be undone/)
  })
})
