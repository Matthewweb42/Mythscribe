import { randomUUID } from 'node:crypto'
import { sceneDocument, type ImportChapter, type ImportDraft } from '@shared/import'
import type { NovelFormat } from '@shared/ipc/contract'
import { defaultNodeTitle, type SectionType } from '@shared/labels'
import type { TiptapNodeT } from '@shared/tiptap'
import { countWords } from '@shared/wordCount'
import type { NodeRow } from '../db/schema'
import { AppError } from '../ipc/errors'
import { insertNodes, listNodes, type TreeDb } from '../tree/treeStore'

/**
 * Manuscript import (F-12.2), the write. Everything the author approved lands in one transaction:
 * either the whole manuscript arrives or nothing does, because a half-imported novel is worse
 * than a failed import. Nothing existing is touched — the imported parts are appended after the
 * project's own nodes — so importing into a project that already has chapters is safe.
 *
 * Front and back matter are flattened on the way in: those sections hold generic documents, not
 * the part/chapter/scene hierarchy, so a chapter placed there becomes one document with its
 * scenes joined by a scene break.
 */
export interface ImportResult {
  /** The created rows in creation order, parents before their children. */
  rows: NodeRow[]
  /** Words written, by the same count the editor caches. */
  words: number
}

export function importDraft(db: TreeDb, format: NovelFormat, draft: ImportDraft): ImportResult {
  return db.transaction((tx) => {
    const all = listNodes(tx)
    const roots = new Map<SectionType, NodeRow>()
    for (const row of all) if (row.sectionType !== null) roots.set(row.sectionType, row)
    const positions = new Map<string, number>()
    for (const row of all) {
      if (row.parentId === null) continue
      positions.set(row.parentId, (positions.get(row.parentId) ?? 0) + 1)
    }

    const now = new Date().toISOString()
    const rows: NodeRow[] = []
    const append = (
      parent: NodeRow,
      fields: Pick<NodeRow, 'kind' | 'hierarchyLevel' | 'title' | 'content' | 'wordCount'>
    ): NodeRow => {
      const position = positions.get(parent.id) ?? 0
      positions.set(parent.id, position + 1)
      const row: NodeRow = {
        ...fields,
        id: randomUUID(),
        parentId: parent.id,
        sectionType: null,
        position,
        notes: null,
        sceneMeta: null,
        matterType: null,
        preset: null,
        created: now,
        modified: now
      }
      rows.push(row)
      return row
    }
    const root = (section: SectionType): NodeRow => {
      const found = roots.get(section)
      if (!found) throw new AppError('NOT_FOUND', `The project has no ${section} section`)
      return found
    }

    let words = 0
    for (const part of draft.parts) {
      if (part.excluded) continue
      const chapters = part.chapters.filter(
        (chapter) => !chapter.excluded && chapter.scenes.some((scene) => !scene.excluded)
      )
      // A part exists to hold chapters; one whose chapters all went to front or back matter (or
      // were excluded) would arrive empty, so it is not created at all.
      const inManuscript = chapters.filter((chapter) => chapter.placement === 'manuscript')
      const partRow =
        inManuscript.length > 0
          ? append(root('manuscript'), {
              kind: 'folder',
              hierarchyLevel: 'part',
              title: titleOr(part.title, format, 'folder', 'part'),
              content: null,
              wordCount: 0
            })
          : null

      for (const chapter of chapters) {
        const scenes = chapter.scenes.filter((scene) => !scene.excluded)
        if (chapter.placement !== 'manuscript') {
          const doc = matterDocument(chapter)
          const count = countWords(doc)
          words += count
          append(root(chapter.placement === 'front' ? 'front' : 'end'), {
            kind: 'document',
            hierarchyLevel: null,
            title: titleOr(chapter.title, format, 'document', null),
            content: JSON.stringify(doc),
            wordCount: count
          })
          continue
        }
        if (partRow === null) continue
        const chapterRow = append(partRow, {
          kind: 'folder',
          hierarchyLevel: 'chapter',
          title: titleOr(chapter.title, format, 'folder', 'chapter'),
          content: null,
          wordCount: 0
        })
        for (const scene of scenes) {
          const doc = sceneDocument(scene.paragraphs)
          const count = countWords(doc)
          words += count
          append(chapterRow, {
            kind: 'document',
            hierarchyLevel: 'scene',
            title: titleOr(scene.title, format, 'document', 'scene'),
            content: JSON.stringify(doc),
            wordCount: count
          })
        }
      }
    }

    if (rows.length === 0) {
      throw new AppError('VALIDATION', 'Nothing selected to import.')
    }
    insertNodes(tx, rows)
    return { rows, words }
  })
}

/** A front- or back-matter chapter as one document: its scenes joined by the scene-break node. */
function matterDocument(chapter: ImportChapter): TiptapNodeT {
  const content: TiptapNodeT[] = []
  for (const scene of chapter.scenes) {
    if (scene.excluded) continue
    if (content.length > 0) content.push({ type: 'sceneBreak' })
    content.push(...scene.paragraphs)
  }
  return sceneDocument(content)
}

function titleOr(
  title: string,
  format: NovelFormat,
  kind: 'folder' | 'document',
  level: 'part' | 'chapter' | 'scene' | null
): string {
  const trimmed = title.trim()
  return trimmed.length > 0 ? trimmed : defaultNodeTitle(format, kind, level)
}
