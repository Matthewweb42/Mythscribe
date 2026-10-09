import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { existingChanges, sceneDocument, type ImportDraft, type ImportScene } from '@shared/import'
import type { NovelFormat } from '@shared/ipc/contract'
import { defaultNodeTitle, type HierarchyLevel, type SectionType } from '@shared/labels'
import type { TiptapNodeT } from '@shared/tiptap'
import { countWords } from '@shared/wordCount'
import { node, type NodeRow } from '../db/schema'
import { deleteAiFactsUnder } from '../entity/factStore'
import { AppError } from '../ipc/errors'
import { insertNodes, listNodes, type TreeDb } from '../tree/treeStore'
import { storedDocument } from './existing'

/**
 * Manuscript import (F-12.2), the write. Everything the author approved lands in one transaction:
 * either the whole manuscript arrives or nothing does, because a half-imported novel is worse
 * than a failed import.
 *
 * A draft without `existing` (an import into an empty manuscript, or a caller that predates the
 * combined outline) only appends: the imported parts land after the project's own nodes and
 * nothing existing is touched. A draft with `existing` is the combined outline (the author's
 * decision, 2026-10-06): the project's parts, chapters, and scenes and the imported ones in one
 * tree, so Import also moves, renames, rewrites (a merge or a split), and deletes existing nodes
 * — exactly the ones `existingChanges` named in the dialog, never more. An existing node only
 * moved or renamed keeps its id, content, tags, notes, and scene meta.
 *
 * Front and back matter are flattened on the way in: those sections hold generic documents, not
 * the part/chapter/scene hierarchy, so a chapter placed there becomes one document with its
 * scenes joined by a scene break.
 */
export interface ImportResult {
  /** The created rows in creation order, parents before their children. */
  rows: NodeRow[]
  /** Imported words written, by the same count the editor caches. */
  words: number
  /**
   * The tag names the AI pass (F-12.3) proposed for a created manuscript scene, by node id;
   * the handler turns each into one pending proposal the tag bar offers. Scenes with no
   * candidates are absent, and a chapter flattened into front or back matter drops its
   * scenes' candidates with their boundaries: there is no scene left to tag.
   */
  tagCandidates: { nodeId: string; tags: string[] }[]
  /** Existing scenes whose text changed (a merge or a split), with their new word count. */
  rewritten: { id: string; wordCount: number }[]
  /** Existing nodes deleted (removed or merged away in the review), descendants not listed. */
  deleted: string[]
  /** True when any existing node was moved, renamed, rewritten, or deleted. */
  changedExisting: boolean
}

/** Where an existing node ends up, and its new text when a merge or a split changed it. */
interface Placed {
  parentId: string
  position: number
  title: string
  text?: Rewrite
}

interface Rewrite {
  content: string
  wordCount: number
}

export function importDraft(db: TreeDb, format: NovelFormat, draft: ImportDraft): ImportResult {
  return db.transaction((tx) => {
    const all = listNodes(tx)
    const byId = new Map(all.map((row) => [row.id, row]))
    const roots = new Map<SectionType, NodeRow>()
    for (const row of all) if (row.sectionType !== null) roots.set(row.sectionType, row)
    const childCount = new Map<string, number>()
    for (const row of all) {
      if (row.parentId === null) continue
      childCount.set(row.parentId, (childCount.get(row.parentId) ?? 0) + 1)
    }
    const root = (section: SectionType): NodeRow => {
      const found = roots.get(section)
      if (!found) throw new AppError('NOT_FOUND', `The project has no ${section} section`)
      return found
    }

    // The combined outline: which existing nodes the draft holds, at which level. Every one of
    // them must still be in the project at that level, or the outline the author reviewed is not
    // the project any more (nothing is written; opening the import again shows the real one).
    const reorganize = draft.existing !== undefined
    const levelOf = new Map<string, HierarchyLevel>()
    for (const id of draft.existing?.parts ?? []) levelOf.set(id, 'part')
    for (const id of draft.existing?.chapters ?? []) levelOf.set(id, 'chapter')
    for (const id of draft.existing?.scenes ?? []) levelOf.set(id, 'scene')
    const changed = (): AppError =>
      new AppError(
        'VALIDATION',
        'The project changed since the import was opened. Open the import again.'
      )
    for (const [id, level] of levelOf) {
      const row = byId.get(id)
      if (row?.hierarchyLevel !== level) throw changed()
    }
    const existingRow = (id: string, level: HierarchyLevel): NodeRow => {
      const row = byId.get(id)
      if (levelOf.get(id) !== level || row === undefined) throw changed()
      return row
    }

    const now = new Date().toISOString()
    // The next free position under each container: after the existing children when only
    // appending, from 0 for a container the outline reorders (its outline children are laid out
    // in the draft's order, anything else it holds goes after them).
    const nextPosition = new Map<string, number>()
    const positionIn = (parentId: string): number => {
      const position = nextPosition.get(parentId) ?? childCount.get(parentId) ?? 0
      nextPosition.set(parentId, position + 1)
      return position
    }
    const manuscript = root('manuscript')
    if (reorganize) nextPosition.set(manuscript.id, 0)

    const rows: NodeRow[] = []
    const create = (
      parentId: string,
      fields: Pick<NodeRow, 'kind' | 'hierarchyLevel' | 'title' | 'content' | 'wordCount'>
    ): NodeRow => {
      const row: NodeRow = {
        ...fields,
        id: randomUUID(),
        parentId,
        sectionType: null,
        position: positionIn(parentId),
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
    const updates = new Map<string, Placed>()
    const place = (row: NodeRow, parentId: string, title: string, text?: Rewrite): void => {
      // A container the outline reorders lays its children out from 0 again.
      nextPosition.set(row.id, 0)
      updates.set(row.id, { parentId, position: positionIn(parentId), title, text })
    }

    let words = 0
    const tagCandidates: ImportResult['tagCandidates'] = []
    const rewritten: ImportResult['rewritten'] = []
    for (const part of draft.parts) {
      if (part.excluded) continue
      const chapters = part.chapters.filter((chapter) => !chapter.excluded)
      const holdsManuscript = chapters.some(
        (chapter) =>
          chapter.placement === 'manuscript' &&
          (chapter.existing === true || chapter.scenes.some((scene) => !scene.excluded))
      )
      let partId: string | null = null
      if (part.existing === true) {
        const row = existingRow(part.id, 'part')
        place(row, manuscript.id, titleOr(part.title, format, 'folder', 'part'))
        partId = row.id
      } else if (holdsManuscript) {
        // A new part exists to hold chapters; one whose chapters all went to front or back
        // matter (or were excluded) would arrive empty, so it is not created at all.
        partId = create(manuscript.id, {
          kind: 'folder',
          hierarchyLevel: 'part',
          title: titleOr(part.title, format, 'folder', 'part'),
          content: null,
          wordCount: 0
        }).id
      }

      for (const chapter of chapters) {
        const scenes = chapter.scenes.filter((scene) => !scene.excluded)
        if (chapter.placement !== 'manuscript') {
          if (chapter.existing === true) {
            throw new AppError(
              'VALIDATION',
              'A chapter already in the project stays in the manuscript.'
            )
          }
          if (scenes.length === 0) continue
          const doc = matterDocument(scenes)
          const count = countWords(doc)
          words += count
          create(root(chapter.placement === 'front' ? 'front' : 'end').id, {
            kind: 'document',
            hierarchyLevel: null,
            title: titleOr(chapter.title, format, 'document', null),
            content: JSON.stringify(doc),
            wordCount: count
          })
          continue
        }
        if (partId === null) continue
        let chapterId: string
        if (chapter.existing === true) {
          const row = existingRow(chapter.id, 'chapter')
          place(row, partId, titleOr(chapter.title, format, 'folder', 'chapter'))
          chapterId = row.id
        } else {
          if (scenes.length === 0) continue
          chapterId = create(partId, {
            kind: 'folder',
            hierarchyLevel: 'chapter',
            title: titleOr(chapter.title, format, 'folder', 'chapter'),
            content: null,
            wordCount: 0
          }).id
        }

        for (const scene of scenes) {
          const title = titleOr(scene.title, format, 'document', 'scene')
          if (scene.existing === true) {
            const row = existingRow(scene.id, 'scene')
            const text = rewrittenContent(row, scene)
            place(row, chapterId, title, text ?? undefined)
            if (text !== null) {
              const { wordCount } = text
              rewritten.push({ id: row.id, wordCount })
              // The imported words are what grew beyond the scene's own and the existing
              // scenes merged into it; a split that only shrank it imports nothing.
              const before = [row.id, ...(scene.absorbed ?? [])].reduce(
                (total, id) => total + (byId.get(id)?.wordCount ?? 0),
                0
              )
              words += Math.max(0, wordCount - before)
            }
            continue
          }
          const doc = sceneDocument(scene.paragraphs)
          const count = countWords(doc)
          words += count
          const row = create(chapterId, {
            kind: 'document',
            hierarchyLevel: 'scene',
            title,
            content: JSON.stringify(doc),
            wordCount: count
          })
          const tags = [...new Set(scene.tags.map((tag) => tag.trim()).filter(Boolean))]
          if (tags.length > 0) tagCandidates.push({ nodeId: row.id, tags })
        }
      }
    }

    // Exactly the existing nodes the dialog said would go: removed in the review, or merged
    // into another scene (their text is already there).
    const changes = existingChanges(draft)
    const deleted = reorganize
      ? [
          ...changes.deletedScenes,
          ...changes.mergedScenes,
          ...changes.deletedChapters,
          ...changes.deletedParts
        ]
      : []
    const deleting = new Set(deleted)

    // What the outline does not show (a generic document or folder inside a part or chapter, or
    // at the top of the manuscript) follows its container's outline children; inside a container
    // that is deleted it moves to the end of the manuscript rather than going with it. What sat
    // before every outline child of its container stays in front (a prologue scene or chapter
    // placed right under the root or a part, flexible nesting 2026-10-07; the outline only shows
    // part → chapter → scene).
    if (reorganize) {
      const outline = new Set(levelOf.keys())
      const containers = [manuscript.id, ...[...levelOf.keys()].filter((id) => !deleting.has(id))]
      const leadingOf = new Map<string, NodeRow[]>()
      for (const containerId of containers) {
        // `listNodes` answers by parent then position, so a filter keeps the order.
        const held = all.filter((row) => row.parentId === containerId)
        const first = held.findIndex((row) => outline.has(row.id))
        const leading = first === -1 ? [] : held.slice(0, first)
        if (leading.length > 0) leadingOf.set(containerId, leading)
        for (const row of held.slice(leading.length)) {
          if (outline.has(row.id)) continue
          updates.set(row.id, {
            parentId: containerId,
            position: positionIn(containerId),
            title: row.title
          })
        }
      }
      for (const row of all) {
        if (row.parentId === null || !deleting.has(row.parentId) || outline.has(row.id)) continue
        updates.set(row.id, {
          parentId: manuscript.id,
          position: positionIn(manuscript.id),
          title: row.title
        })
      }
      for (const [containerId, leading] of leadingOf) {
        const shift = leading.length
        for (const placed of updates.values())
          if (placed.parentId === containerId) placed.position += shift
        for (const row of rows) if (row.parentId === containerId) row.position += shift
        leading.forEach((row, position) =>
          updates.set(row.id, { parentId: containerId, position, title: row.title })
        )
      }
    }

    // Only what really moved, was renamed, or was rewritten is written (and gets a new
    // `modified`): an existing node the author left alone stays byte for byte as it was.
    const writes = [...updates].filter(([id, placed]) => {
      const row = byId.get(id)
      return (
        row !== undefined &&
        (row.parentId !== placed.parentId ||
          row.position !== placed.position ||
          row.title !== placed.title ||
          placed.text !== undefined)
      )
    })
    if (rows.length === 0 && writes.length === 0 && deleted.length === 0) {
      throw new AppError('VALIDATION', 'Nothing selected to import.')
    }

    insertNodes(tx, rows)
    for (const [id, placed] of writes) {
      tx.update(node)
        .set({
          parentId: placed.parentId,
          position: placed.position,
          title: placed.title,
          ...placed.text,
          modified: now
        })
        .where(eq(node.id, id))
        .run()
    }
    if (deleted.length > 0) {
      // F-9.13: a replaced scene's AI facts go with it, as `deleteNode` does.
      deleteAiFactsUnder(tx, deleted)
      tx.delete(node).where(inArray(node.id, deleted)).run()
    }
    return {
      rows,
      words,
      tagCandidates,
      rewritten,
      deleted,
      changedExisting: writes.length > 0 || deleted.length > 0
    }
  })
}

/**
 * The new stored content of an existing scene, or null when its text is what the project
 * already holds (moved or renamed only). The draft carries the scene's stored paragraphs as
 * main read them, so an untouched scene compares equal; a merge or a split changes them. The
 * document's own attributes are kept, only its content is replaced.
 */
function rewrittenContent(row: NodeRow, scene: ImportScene): Rewrite | null {
  const stored = storedDocument(row)
  const before = JSON.stringify(stored?.content ?? [])
  if ((scene.absorbed ?? []).length === 0 && before === JSON.stringify(scene.paragraphs)) {
    return null
  }
  const doc: TiptapNodeT = {
    ...sceneDocument(scene.paragraphs),
    ...(stored?.attrs === undefined ? {} : { attrs: stored.attrs })
  }
  return { content: JSON.stringify(doc), wordCount: countWords(doc) }
}

/** A front- or back-matter chapter as one document: its scenes joined by the scene-break node. */
function matterDocument(scenes: readonly ImportScene[]): TiptapNodeT {
  const content: TiptapNodeT[] = []
  for (const scene of scenes) {
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
