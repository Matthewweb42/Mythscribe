import { randomUUID } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import type { NovelFormat } from '@shared/ipc/contract'
import { levelLabel } from '@shared/labels'
import { node, type NodeInsert } from '../db/schema'
import { insertNodes } from '../tree/treeStore'
import { createProject, type ProjectSession } from './projectStore'

/**
 * Test fixture: a new project grown to the pre-2026-10-06 starter tree (Part 1–2 → Chapter 1–3 →
 * Scene 1, 17 rows, same row order), which most main-process tests were written against. New
 * projects now seed only Part 1 → Chapter 1 → Scene 1 (F-1.3).
 */
export function createSeededProject(
  folder: string,
  name: string,
  format: NovelFormat
): ProjectSession {
  const session = createProject(folder, name, format)
  growLegacyStarter(session, format)
  return session
}

/** Adds the rows the old starter had beyond Part 1 → Chapter 1 → Scene 1, in the old row order. */
export function growLegacyStarter(session: ProjectSession, format: NovelFormat): void {
  const db = session.connection.orm
  const manuscript = db
    .select()
    .from(node)
    .where(and(isNull(node.parentId), eq(node.sectionType, 'manuscript')))
    .get()
  const part1 = manuscript
    ? db.select().from(node).where(eq(node.parentId, manuscript.id)).get()
    : undefined
  if (!manuscript || !part1) throw new Error('seeded project has no Part 1')

  const now = part1.created
  const base = { created: now, modified: now, wordCount: 0, sectionType: null }
  const rows: NodeInsert[] = []
  const chapters = (partId: string, from: number): void => {
    for (let c = from; c < 3; c++) {
      const chapter: NodeInsert = {
        ...base,
        id: randomUUID(),
        parentId: partId,
        kind: 'folder',
        hierarchyLevel: 'chapter',
        title: `${levelLabel(format, 'chapter')} ${c + 1}`,
        position: c
      }
      rows.push(chapter, {
        ...base,
        id: randomUUID(),
        parentId: chapter.id,
        kind: 'document',
        hierarchyLevel: 'scene',
        title: `${levelLabel(format, 'scene')} 1`,
        position: 0
      })
    }
  }
  chapters(part1.id, 1)
  const part2: NodeInsert = {
    ...base,
    id: randomUUID(),
    parentId: manuscript.id,
    kind: 'folder',
    hierarchyLevel: 'part',
    title: `${levelLabel(format, 'part')} 2`,
    position: 1
  }
  rows.push(part2)
  chapters(part2.id, 0)
  insertNodes(db, rows)
}
