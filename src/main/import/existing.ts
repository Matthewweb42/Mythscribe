import type {
  ImportChapter,
  ImportDraft,
  ImportExisting,
  ImportPart,
  ImportScene
} from '@shared/import'
import type { TiptapNodeT } from '@shared/tiptap'
import type { NodeRow } from '../db/schema'
import { parseStoredTiptap } from '../document/documentStore'
import { listNodes, type TreeDb } from '../tree/treeStore'

/**
 * Importing into a project that already has a manuscript (F-12.2, the author's decision of
 * 2026-10-06): the review dialog shows ONE combined outline, the project's parts, chapters, and
 * scenes first and the imported ones after them, so the author can sort both together. This
 * puts the existing outline into the draft main built from the file. Only the outline levels
 * travel (a part under the manuscript root, a chapter under a part, a scene under a chapter);
 * a generic document or folder in the manuscript is not shown and stays where it is, and so is a
 * scene or chapter placed at a higher level (a prologue on the root; flexible nesting). Existing
 * scenes carry their stored content as `paragraphs`, so a merge or a split in the dialog works
 * on real text, and an untouched scene compares equal at commit and is not rewritten.
 */

/** A document's stored Tiptap JSON, or null when it was never written. */
export function storedDocument(row: Pick<NodeRow, 'id' | 'content'>): TiptapNodeT | null {
  return row.content === null ? null : parseStoredTiptap(row.content, row.id, 'document content')
}

/** The existing outline in front of the imported parts, and the ids Import may delete. */
export function withExisting(db: TreeDb, draft: ImportDraft): ImportDraft {
  const all = listNodes(db)
  const manuscript = all.find((row) => row.sectionType === 'manuscript')
  if (!manuscript) return draft
  // `listNodes` answers by parent then position, so a filter keeps the reading order.
  const childrenOf = (parentId: string, level: NodeRow['hierarchyLevel']): NodeRow[] =>
    all.filter((row) => row.parentId === parentId && row.hierarchyLevel === level)

  const existing: ImportExisting = { parts: [], chapters: [], scenes: [] }
  const parts = childrenOf(manuscript.id, 'part').map((partRow): ImportPart => {
    existing.parts.push(partRow.id)
    return {
      id: partRow.id,
      title: partRow.title,
      excluded: false,
      existing: true,
      chapters: childrenOf(partRow.id, 'chapter').map((chapterRow): ImportChapter => {
        existing.chapters.push(chapterRow.id)
        return {
          id: chapterRow.id,
          title: chapterRow.title,
          excluded: false,
          existing: true,
          placement: 'manuscript',
          scenes: childrenOf(chapterRow.id, 'scene').map((sceneRow): ImportScene => {
            existing.scenes.push(sceneRow.id)
            return {
              id: sceneRow.id,
              title: sceneRow.title,
              excluded: false,
              existing: true,
              paragraphs: storedDocument(sceneRow)?.content ?? [],
              tags: []
            }
          })
        }
      })
    }
  })
  if (parts.length === 0) return draft
  return { ...draft, parts: [...parts, ...draft.parts], existing }
}
