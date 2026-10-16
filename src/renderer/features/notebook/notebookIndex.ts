import type { NotebookItem, NotebookRole } from '@shared/notebook'

/**
 * The notebook tree's pure helpers (notes redesign phase 1, slice 1): the index the Notes tree
 * draws from, the rows on screen, where a drag lands (the manuscript tree's before / into /
 * after zones, F-2.4), and where a new page goes. Positions are reals, so a drop between two rows
 * takes the midpoint and moves nothing else. The notes binder (2026-10-16): the three section
 * roots (Outline, Timeline, Documents) are the top level; they never move, take drops only inside,
 * and a new page with nothing selected goes into Documents.
 */

/** The `childrenOf` key of the top level. */
export const NOTEBOOK_ROOT = ''

export interface NotebookIndex {
  byId: Record<string, NotebookItem>
  /** Child ids by parent id (`NOTEBOOK_ROOT` for the top level), in position order. */
  childrenOf: Record<string, string[]>
}

export function buildNotebookIndex(items: readonly NotebookItem[]): NotebookIndex {
  const byId: Record<string, NotebookItem> = {}
  const childrenOf: Record<string, string[]> = { [NOTEBOOK_ROOT]: [] }
  for (const item of items) byId[item.id] = item
  for (const item of items) {
    // An item whose folder is gone (never expected) shows at the top level, never out of reach.
    const parent =
      item.parentId !== null && byId[item.parentId] !== undefined ? item.parentId : NOTEBOOK_ROOT
    ;(childrenOf[parent] ??= []).push(item.id)
  }
  for (const ids of Object.values(childrenOf)) {
    ids.sort((a, b) => {
      const x = byId[a]
      const y = byId[b]
      return (x?.position ?? 0) - (y?.position ?? 0) || a.localeCompare(b)
    })
  }
  return { byId, childrenOf }
}

/** Whether an item is one of the three section roots. */
export function isSectionRoot(item: NotebookItem | undefined): boolean {
  return item?.role != null
}

/** The id of a section's root, or null before the sections are loaded. */
export function sectionRootId(index: NotebookIndex, role: NotebookRole): string | null {
  for (const id of index.childrenOf[NOTEBOOK_ROOT] ?? []) {
    if (index.byId[id]?.role === role) return id
  }
  return null
}

/** Where a drop lands relative to the row under the pointer. */
export type NotebookDropZone = 'before' | 'into' | 'after'

/**
 * The zone of a row the pointer is in, as the manuscript tree splits it (F-2.4): a page's top
 * half is before and its bottom half after; a folder splits before / into / after at 25 % / 75 %.
 */
export function notebookDropZone(
  kind: NotebookItem['kind'],
  ratio: number,
  root = false
): NotebookDropZone {
  // A section root, like the manuscript's sections, only takes things inside it.
  if (root) return 'into'
  if (kind === 'page') return ratio < 0.5 ? 'before' : 'after'
  if (ratio < 0.25) return 'before'
  if (ratio >= 0.75) return 'after'
  return 'into'
}

/** Whether `id` is `ancestorId` or sits somewhere inside it. */
export function isWithin(index: NotebookIndex, id: string | null, ancestorId: string): boolean {
  let current = id
  const seen = new Set<string>()
  while (current !== null && !seen.has(current)) {
    if (current === ancestorId) return true
    seen.add(current)
    current = index.byId[current]?.parentId ?? null
  }
  return false
}

/** A position between two siblings' positions (either may be missing: the ends of the list). */
export function positionBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 0
  if (before === undefined) return (after ?? 0) - 1
  if (after === undefined) return before + 1
  return (before + after) / 2
}

/**
 * Where dropping `dragId` on `overId`'s `zone` puts it, or null when it cannot go there (on
 * itself, into a folder inside itself, beside a section root, or a section root at all). Into a
 * folder appends it last there.
 */
export function notebookDropTarget(
  index: NotebookIndex,
  dragId: string,
  overId: string,
  zone: NotebookDropZone
): { parentId: string | null; position: number } | null {
  const over = index.byId[overId]
  const dragged = index.byId[dragId]
  if (over === undefined || dragged === undefined || dragId === overId) return null
  if (isSectionRoot(dragged) || (isSectionRoot(over) && zone !== 'into')) return null
  const parentId = zone === 'into' ? over.id : over.parentId
  if (zone === 'into' && over.kind !== 'folder') return null
  if (parentId !== null && isWithin(index, parentId, dragId)) return null
  const siblings = (index.childrenOf[parentId ?? NOTEBOOK_ROOT] ?? []).filter((id) => id !== dragId)
  const pos = (id: string | undefined): number | undefined =>
    id === undefined ? undefined : index.byId[id]?.position
  if (zone === 'into')
    return { parentId, position: positionBetween(pos(siblings.at(-1)), undefined) }
  const at = siblings.indexOf(overId)
  return zone === 'before'
    ? { parentId, position: positionBetween(pos(siblings[at - 1]), pos(overId)) }
    : { parentId, position: positionBetween(pos(overId), pos(siblings[at + 1])) }
}

/**
 * The folder a new page or folder goes into: the selected folder, the selected page's folder, or
 * Documents (the top before the sections are loaded; main puts it in Documents then).
 */
export function notebookTargetFolder(
  index: NotebookIndex,
  selectedId: string | null
): string | null {
  const selected = selectedId === null ? undefined : index.byId[selectedId]
  if (selected === undefined) return sectionRootId(index, 'documents')
  return selected.kind === 'folder'
    ? selected.id
    : (selected.parentId ?? sectionRootId(index, 'documents'))
}

export interface NotebookRow {
  id: string
  depth: number
}

/** The rows on screen, depth first, collapsed folders' children left out. */
export function notebookRows(
  index: NotebookIndex,
  collapsed: Readonly<Record<string, boolean>>
): NotebookRow[] {
  const rows: NotebookRow[] = []
  const walk = (parent: string, depth: number): void => {
    for (const id of index.childrenOf[parent] ?? []) {
      rows.push({ id, depth })
      if (index.byId[id]?.kind === 'folder' && collapsed[id] !== true) walk(id, depth + 1)
    }
  }
  walk(NOTEBOOK_ROOT, 1)
  return rows
}
