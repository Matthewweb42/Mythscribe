import { parseStoredSceneMeta } from '@shared/sceneMeta'
import {
  STORY_POSITION_NOTE,
  positionIn,
  renderStoryMap,
  resolveNow,
  sceneProgress,
  type NowBasis,
  type StoryMapItem,
  type StoryPosition
} from '@shared/storyTime'
import type { NodeRow } from '../../db/schema'
import { summariesFor } from '../../document/summaryStore'
import { nodesInTreeOrder } from '../../search/searchStore'
import { listNodes, type TreeDb } from '../../tree/treeStore'

/**
 * Story time for one request (F-5.23): now, the manuscript documents in reading order, and each
 * one's position relative to now. Built from the rows as they are; nothing is stored.
 */
export interface StoryTime {
  nowId: string | null
  basis: NowBasis
  /** The manuscript documents in reading order. */
  order: string[]
  /** `earlier` / `now` / `later` for a manuscript document; null for anything else. */
  positionOf: (nodeId: string) => StoryPosition | null
}

/** The manuscript section's nodes (the root left out) in tree order, which is reading order. */
export function manuscriptRows(rows: NodeRow[]): NodeRow[] {
  const root = rows.find((row) => row.parentId === null && row.sectionType === 'manuscript')
  if (root === undefined) return []
  const byId = new Map(rows.map((row) => [row.id, row]))
  const inside = (row: NodeRow): boolean => {
    for (let at = row.parentId; at !== null; at = byId.get(at)?.parentId ?? null) {
      if (at === root.id) return true
    }
    return false
  }
  return nodesInTreeOrder(rows.filter(inside))
}

/**
 * The document a selection puts now at: a manuscript document itself; a manuscript chapter or
 * part, the last document inside it; anything else (an entity page, research, nothing), null.
 */
function activeDocument(manuscript: NodeRow[], activeId: string | null): string | null {
  if (activeId === null) return null
  const active = manuscript.find((row) => row.id === activeId)
  if (active === undefined) return null
  if (active.kind === 'document') return active.id
  const byId = new Map(manuscript.map((row) => [row.id, row]))
  const under = (row: NodeRow): boolean => {
    for (let at = row.parentId; at !== null; at = byId.get(at)?.parentId ?? null) {
      if (at === active.id) return true
    }
    return false
  }
  return manuscript.filter((row) => row.kind === 'document' && under(row)).at(-1)?.id ?? null
}

export function storyTime(
  db: TreeDb,
  activeId: string | null,
  rows: NodeRow[] = listNodes(db)
): StoryTime {
  const manuscript = manuscriptRows(rows)
  const documents = manuscript.filter((row) => row.kind === 'document')
  const order = documents.map((row) => row.id)
  const now = resolveNow(documents, activeDocument(manuscript, activeId))
  return {
    nowId: now.nowId,
    basis: now.basis,
    order,
    positionOf: (nodeId) => positionIn(order, now.nowId, nodeId)
  }
}

/** A scene's position as a lookup result names it; outside the manuscript, the author's material. */
export function positionNote(time: StoryTime, nodeId: string): string {
  const position = time.positionOf(nodeId)
  return position === null
    ? "outside the manuscript: the author's notes and research"
    : STORY_POSITION_NOTE[position]
}

/**
 * The story map's lines (F-5.23): the manuscript's folders and documents in reading order, each
 * document's progress (F-11.1d) and stored summary. A planned document the author linked to the
 * scene that fulfils it (`SceneMeta.fulfilledBy`, F-11.1d) is left out: that plan is written.
 */
export function storyMapItems(
  db: TreeDb,
  rows: NodeRow[],
  refOf: ReadonlyMap<string, string> = new Map()
): StoryMapItem[] {
  const manuscript = manuscriptRows(rows)
  const ids = new Set(manuscript.map((row) => row.id))
  const summaries = summariesFor(
    db,
    manuscript.filter((row) => row.kind === 'document').map((row) => row.id)
  )
  const depth = new Map<string, number>()
  const items: StoryMapItem[] = []
  for (const row of manuscript) {
    const level =
      row.parentId !== null && depth.has(row.parentId) ? (depth.get(row.parentId) ?? 0) + 1 : 0
    depth.set(row.id, level)
    const meta = parseStoredSceneMeta(row.sceneMeta)
    const progress = row.kind === 'document' ? sceneProgress(row.wordCount, meta.status) : null
    if (progress === 'planned' && meta.fulfilledBy !== undefined && ids.has(meta.fulfilledBy)) {
      continue
    }
    items.push({
      id: row.id,
      ref: refOf.get(row.id) ?? '',
      title: row.title,
      depth: level,
      kind: row.kind === 'document' ? 'document' : 'folder',
      progress,
      summary: row.kind === 'document' ? (summaries.get(row.id)?.summary ?? null) : null
    })
  }
  return items
}

/** The story map block for a prompt, or null for a manuscript with no document. */
export function buildStoryMap(
  db: TreeDb,
  time: StoryTime,
  input: { maxTokens: number; refOf?: ReadonlyMap<string, string>; rows?: NodeRow[] }
): string | null {
  const items = storyMapItems(db, input.rows ?? listNodes(db), input.refOf)
  return renderStoryMap(items, { nowId: time.nowId, basis: time.basis }, input.maxTokens)
}
