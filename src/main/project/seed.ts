import { randomUUID } from 'node:crypto'
import type { NovelFormat } from '@shared/ipc/contract'
import { EDITOR_SETTINGS_KEY, defaultEditorSettings } from '@shared/editorSettings'
import { levelLabel, type SectionType } from '@shared/labels'
import type { NodeInsert } from '../db/schema'

/**
 * Starter structure for a new project (F-1.3): the three root sections plus, under the
 * manuscript, Part 1–2 → Chapter 1–3 → Scene 1 (17 rows). Pure: ids and timestamps are injected
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

  const partLabel = levelLabel(format, 'part')
  for (let p = 0; p < 2; p++) {
    const part: NodeInsert = {
      ...base,
      id: newId(),
      parentId: manuscript.id,
      sectionType: null,
      kind: 'folder',
      hierarchyLevel: 'part',
      title: `${partLabel} ${p + 1}`,
      position: p
    }
    rows.push(part)
    for (let c = 0; c < 3; c++) {
      const chapter: NodeInsert = {
        ...base,
        id: newId(),
        parentId: part.id,
        sectionType: null,
        kind: 'folder',
        hierarchyLevel: 'chapter',
        title: `${levelLabel(format, 'chapter')} ${c + 1}`,
        position: c
      }
      rows.push(chapter)
      rows.push({
        ...base,
        id: newId(),
        parentId: chapter.id,
        sectionType: null,
        kind: 'document',
        hierarchyLevel: 'scene',
        title: `${levelLabel(format, 'scene')} 1`,
        position: 0
      })
    }
  }
  return rows
}

/** Settings rows seeded into a new project: the format's default editor settings (F-3.6). */
export function seedSettings(format: NovelFormat): { key: string; value: string }[] {
  return [{ key: EDITOR_SETTINGS_KEY, value: JSON.stringify(defaultEditorSettings(format)) }]
}
