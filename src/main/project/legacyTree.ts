import { randomUUID } from 'node:crypto'
import { HierarchyLevel, type SectionType } from '@shared/labels'
import { SCENE_META_FIELD_MAX, SCENE_META_TIMELINE_MAX, emptySceneMeta } from '@shared/sceneMeta'
import { countWords } from '@shared/wordCount'
import type { NodeInsert } from '../db/schema'
import { slateToTiptap } from './legacySlate'

/**
 * The v0 document tree as v1 node rows (F-1.6). Pure: the v0 rows, the ids of the three section
 * roots v1 seeds, and the clock go in; the rows to insert and the v0 → v1 id map come out.
 *
 * - A top-level v0 row hangs under the section its `section` column names (`front-matter`,
 *   `manuscript`, `end-matter`; a row from before sections existed goes to the manuscript), except
 *   a top-level research note (`doc_type = 'note'`), which goes into a "Notes" folder at the end
 *   of the end matter so it never counts as manuscript text or reaches the AI's index.
 * - A row whose parent is missing (or part of a cycle) is treated as top-level.
 * - `hierarchy_level` keeps part, chapter, and scene; v0's `novel` level becomes a plain folder.
 * - Content and notes go through `slateToTiptap`; the word count is v1's own (`countWords`).
 * - Location, POV, and timeline become the scene metadata; v0's free-form metadata and per-
 *   document formatting presets stay in the backup.
 * - Siblings keep v0's order (position, then created) and are renumbered from 0.
 */

export interface LegacyDocument {
  id: string
  parent_id: string | null
  name: string
  type: string
  content: string | null
  doc_type: string | null
  hierarchy_level: string | null
  notes: string | null
  position: number
  location: string | null
  pov: string | null
  timeline_position: string | null
  section: string | null
  matter_type: string | null
  created: string
  modified: string
}

export type SectionIds = Record<SectionType, string>

export interface LegacyTreePlan {
  rows: NodeInsert[]
  /** v0 document id → v1 node id, for the tag links. */
  ids: Map<string, string>
}

const SECTION_OF: Record<string, SectionType> = {
  'front-matter': 'front',
  manuscript: 'manuscript',
  'end-matter': 'end'
}
const TITLE_MAX = 200

export function planLegacyTree(
  documents: readonly LegacyDocument[],
  sections: SectionIds,
  now: string,
  newId: () => string = randomUUID
): LegacyTreePlan {
  const byId = new Map(documents.map((doc) => [doc.id, doc]))
  const ids = new Map(documents.map((doc) => [doc.id, newId()]))
  const rows: NodeInsert[] = []

  // The effective parent of each row: its v0 parent when that exists and is not a descendant of
  // it, else null (top-level).
  const parentOf = new Map<string, string | null>()
  for (const doc of documents) {
    let parent = doc.parent_id !== null && byId.has(doc.parent_id) ? doc.parent_id : null
    const seen = new Set([doc.id])
    for (let walk = parent; walk !== null;) {
      if (seen.has(walk)) {
        parent = null
        break
      }
      seen.add(walk)
      const next = byId.get(walk)?.parent_id ?? null
      walk = next !== null && byId.has(next) ? next : null
    }
    parentOf.set(doc.id, parent)
  }

  const childrenOf = new Map<string | null, LegacyDocument[]>()
  for (const doc of documents) {
    const parent = parentOf.get(doc.id) ?? null
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), doc])
  }
  const ordered = (list: readonly LegacyDocument[]): LegacyDocument[] =>
    [...list].sort((a, b) => a.position - b.position || a.created.localeCompare(b.created))

  // Top-level rows grouped by where they land.
  const topLevel = ordered(childrenOf.get(null) ?? [])
  const notes = topLevel.filter((doc) => doc.doc_type === 'note')
  const placed: Record<SectionType, LegacyDocument[]> = { front: [], manuscript: [], end: [] }
  for (const doc of topLevel) {
    if (doc.doc_type === 'note') continue
    placed[SECTION_OF[doc.section ?? ''] ?? 'manuscript'].push(doc)
  }

  const emit = (doc: LegacyDocument, parentId: string, position: number): void => {
    const id = ids.get(doc.id) ?? newId()
    const content = slateToTiptap(doc.content)
    const notesDoc = slateToTiptap(doc.notes)
    rows.push({
      id,
      parentId,
      sectionType: null,
      kind: doc.type === 'folder' ? 'folder' : 'document',
      hierarchyLevel: HierarchyLevel.safeParse(doc.hierarchy_level).data ?? null,
      title: (doc.name.trim() || 'Untitled').slice(0, TITLE_MAX),
      position,
      content: content === null ? null : JSON.stringify(content),
      notes: notesDoc === null ? null : JSON.stringify(notesDoc),
      wordCount: content === null ? 0 : countWords(content),
      sceneMeta: sceneMeta(doc),
      matterType: doc.matter_type,
      preset: null,
      created: doc.created || now,
      modified: doc.modified || now
    })
    ordered(childrenOf.get(doc.id) ?? []).forEach((child, index) => emit(child, id, index))
  }

  for (const section of ['front', 'manuscript', 'end'] as const) {
    placed[section].forEach((doc, index) => emit(doc, sections[section], index))
  }
  if (notes.length > 0) {
    const folderId = newId()
    rows.push({
      id: folderId,
      parentId: sections.end,
      sectionType: null,
      kind: 'folder',
      hierarchyLevel: null,
      title: 'Notes',
      position: placed.end.length,
      content: null,
      notes: null,
      wordCount: 0,
      sceneMeta: null,
      matterType: null,
      preset: null,
      created: now,
      modified: now
    })
    notes.forEach((doc, index) => emit(doc, folderId, index))
  }
  return { rows, ids }
}

function sceneMeta(doc: LegacyDocument): string | null {
  const location = (doc.location ?? '').trim().slice(0, SCENE_META_FIELD_MAX)
  const pov = (doc.pov ?? '').trim().slice(0, SCENE_META_FIELD_MAX)
  const timeline = (doc.timeline_position ?? '').trim().slice(0, SCENE_META_TIMELINE_MAX)
  if (location === '' && pov === '' && timeline === '') return null
  return JSON.stringify({ ...emptySceneMeta(), location, pov, timeline })
}
