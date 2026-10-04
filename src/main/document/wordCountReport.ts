import {
  addTextStats,
  EMPTY_TEXT_STATS,
  textStats,
  type TextStats,
  type WordCountReport
} from '@shared/wordCount'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { documentJson, manuscriptDocuments } from '../voice/profile'

/**
 * The word count dialog's stored counts (F-10.4): the whole manuscript, and the chapter around
 * `nodeId` (the nearest chapter-level node among the node and its ancestors) when that chapter
 * is under the manuscript. Counts come from the stored documents with the same `textStats` the
 * editor uses; an unreadable row counts as empty, never a throw.
 */
export function wordCountReport(db: TreeDb, nodeId: string | null): WordCountReport {
  const rows = listNodes(db)
  const byId = new Map(rows.map((row) => [row.id, row]))
  const documents = manuscriptDocuments(db, rows)

  let chapterRow = nodeId === null ? undefined : byId.get(nodeId)
  while (chapterRow !== undefined && chapterRow.hierarchyLevel !== 'chapter')
    chapterRow = chapterRow.parentId === null ? undefined : byId.get(chapterRow.parentId)

  const isUnder = (id: string, ancestorId: string): boolean => {
    for (let row = byId.get(id); row !== undefined;) {
      if (row.id === ancestorId) return true
      row = row.parentId === null ? undefined : byId.get(row.parentId)
    }
    return false
  }

  let manuscript: TextStats = EMPTY_TEXT_STATS
  let chapterStats: TextStats = EMPTY_TEXT_STATS
  for (const row of documents) {
    const json = documentJson(row)
    const stats = json === null ? EMPTY_TEXT_STATS : textStats(json)
    manuscript = addTextStats(manuscript, stats)
    if (chapterRow !== undefined && isUnder(row.id, chapterRow.id))
      chapterStats = addTextStats(chapterStats, stats)
  }
  // A chapter with no documents yet still has a row, as long as it sits under the manuscript.
  const root = rows.find((row) => row.parentId === null && row.sectionType === 'manuscript')
  const chapterInManuscript =
    chapterRow !== undefined && root !== undefined && isUnder(chapterRow.id, root.id)
  return {
    chapter:
      chapterRow !== undefined && chapterInManuscript
        ? { id: chapterRow.id, title: chapterRow.title, stats: chapterStats }
        : null,
    manuscript
  }
}
