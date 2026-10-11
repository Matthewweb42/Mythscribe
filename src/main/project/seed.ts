import { randomUUID } from 'node:crypto'
import { and, eq, isNull, max } from 'drizzle-orm'
import type { NovelFormat } from '@shared/ipc/contract'
import { EDITOR_SETTINGS_KEY, defaultEditorSettings } from '@shared/editorSettings'
import { levelLabel, type SectionType } from '@shared/labels'
import { node, type NodeInsert } from '../db/schema'
import type { TreeDb } from '../tree/treeStore'

/**
 * Starter structure for a new project (F-1.3): the three root sections plus, under the
 * manuscript, Part 1 → Chapter 1 → Scene 1 (6 rows). Pure: ids and timestamps are injected
 * so the result is deterministic under test.
 */
export function seedSkeleton(
  format: NovelFormat,
  now: string,
  newId: () => string = randomUUID
): NodeInsert[] {
  const rows: NodeInsert[] = []
  const base = { created: now, modified: now, wordCount: 0 }

  const section = (sectionType: SectionType, position: number): NodeInsert => ({
    ...base,
    id: newId(),
    parentId: null,
    sectionType,
    kind: 'folder',
    hierarchyLevel: null,
    title: sectionType,
    position
  })
  const front = section('front', 0)
  const manuscript = section('manuscript', 1)
  const end = section('end', 2)
  rows.push(front, manuscript, end)

  const part: NodeInsert = {
    ...base,
    id: newId(),
    parentId: manuscript.id,
    sectionType: null,
    kind: 'folder',
    hierarchyLevel: 'part',
    title: `${levelLabel(format, 'part')} 1`,
    position: 0
  }
  const chapter: NodeInsert = {
    ...base,
    id: newId(),
    parentId: part.id,
    sectionType: null,
    kind: 'folder',
    hierarchyLevel: 'chapter',
    title: `${levelLabel(format, 'chapter')} 1`,
    position: 0
  }
  const scene: NodeInsert = {
    ...base,
    id: newId(),
    parentId: chapter.id,
    sectionType: null,
    kind: 'document',
    hierarchyLevel: 'scene',
    title: `${levelLabel(format, 'scene')} 1`,
    position: 0
  }
  rows.push(part, chapter, scene)
  return rows
}

/** Settings rows seeded into a new project: the format's default editor settings (F-3.6). */
export function seedSettings(format: NovelFormat): { key: string; value: string }[] {
  return [{ key: EDITOR_SETTINGS_KEY, value: JSON.stringify(defaultEditorSettings(format)) }]
}

/**
 * The Research root (F-16.8, story memory v2): the fourth section, after end matter, holding the
 * author's uploaded and written research. Created once, on the v2 open only (`handlers.ts`), so
 * a v1 project never gains it. Idempotent; answers the root's id.
 */
export function ensureResearchRoot(db: TreeDb, now: Date = new Date()): string {
  return db.transaction((tx) => {
    const existing = tx
      .select({ id: node.id })
      .from(node)
      .where(and(isNull(node.parentId), eq(node.sectionType, 'research')))
      .get()
    if (existing !== undefined) return existing.id
    const last = tx
      .select({ position: max(node.position) })
      .from(node)
      .where(isNull(node.parentId))
      .get()
    const stamp = now.toISOString()
    const id = randomUUID()
    tx.insert(node)
      .values({
        id,
        parentId: null,
        sectionType: 'research',
        kind: 'folder',
        hierarchyLevel: null,
        title: 'research',
        position: (last?.position ?? -1) + 1,
        wordCount: 0,
        created: stamp,
        modified: stamp
      })
      .run()
    return id
  })
}
