import { asc, eq } from 'drizzle-orm'
import { CHAT_REF_NOTES_CHAR_BUDGET, CHAT_SCENE_CHAR_BUDGET, parseTagRefs } from '@shared/chat'
import { docToText } from '@shared/docText'
import type { SceneMeta } from '@shared/sceneMeta'
import { documentTag, node } from '../../db/schema'
import { getDocumentContent, parseStoredTiptap } from '../../document/documentStore'
import { getSceneMeta } from '../../document/sceneMetaStore'
import { sceneBriefBlock } from '../../document/sceneNeighbours'
import { listTags } from '../../tag/tagStore'
import type { TreeDb } from '../../tree/treeStore'

export interface ChatContextInput {
  /** The active document, or null when no scene is open. */
  nodeId: string | null
  /** The author's message; its `#name` references pick the notes that ride along. */
  message: string
}

/** One `#name` reference the bank knew, with the notes of the documents linked to that tag. */
export interface ChatRef {
  name: string
  /** Plain text, head-truncated to the reference's share of `CHAT_REF_NOTES_CHAR_BUDGET`. */
  notes: string
}

export interface ChatContext {
  /** The active document's plain text, head-truncated to `CHAT_SCENE_CHAR_BUDGET`; '' with no scene. */
  sceneText: string
  /** The scene's metadata when any field is set, else null (Agent mode folds it in). */
  sceneMeta: SceneMeta | null
  /**
   * The scene brief block (F-14.3) for the active document — its own lines with the previous
   * scene's reader-knows-after line and the next scene's goal — or null with no scene open or
   * no brief anywhere near it. Agent mode folds it in.
   */
  brief: string | null
  /** The references that resolved to a tag with at least one linked note, in message order. */
  refs: ChatRef[]
  /** Every reference that resolved to a bank tag, notes or not; an unknown name is dropped. */
  refNames: string[]
}

/**
 * The context an assistant turn carries (F-5.4), exactly what the data-sharing panel lists:
 * the active scene's text (head-truncated, the same cut as tags), its metadata, its brief
 * (F-14.3, `sceneBriefBlock`), and, for each
 * `#name` in the message that names a bank tag, the notes (F-3.7) of the documents linked to
 * that tag (F-4.4) as plain text, the whole notes budget shared evenly across the references
 * that have any. Nothing else of the manuscript is read. A `nodeId` that is not a document
 * is refused by `getDocumentContent` (NOT_FOUND / VALIDATION). Entities (F-9.x) will replace
 * the tag source without changing the prompt.
 */
export function buildChatContext(db: TreeDb, input: ChatContextInput): ChatContext {
  let sceneText = ''
  let sceneMeta: SceneMeta | null = null
  let brief: string | null = null
  if (input.nodeId !== null) {
    const { content } = getDocumentContent(db, input.nodeId)
    sceneText = headTruncate(content ? docToText(content).trim() : '', CHAT_SCENE_CHAR_BUDGET)
    const { meta } = getSceneMeta(db, input.nodeId)
    sceneMeta = meta.location || meta.pov || meta.timeline ? meta : null
    brief = sceneBriefBlock(db, input.nodeId)
  }

  const names = parseTagRefs(input.message)
  const bank = new Map(listTags(db).map((tag) => [tag.name, tag.id]))
  const matched = names.flatMap((name) => {
    const id = bank.get(name)
    return id === undefined ? [] : [{ name, id }]
  })
  const withNotes = matched.flatMap(({ name, id }) => {
    const notes = linkedNotes(db, id)
    return notes ? [{ name, notes }] : []
  })
  const share = withNotes.length ? Math.floor(CHAT_REF_NOTES_CHAR_BUDGET / withNotes.length) : 0
  return {
    sceneText,
    sceneMeta,
    brief,
    refs: withNotes.map(({ name, notes }) => ({ name, notes: headTruncate(notes, share) })),
    refNames: matched.map(({ name }) => name)
  }
}

/** The notes of every node linked to the tag, as one plain text (title order, then id); '' when none has any. */
function linkedNotes(db: TreeDb, tagId: string): string {
  const rows = db
    .select({ id: node.id, notes: node.notes })
    .from(documentTag)
    .innerJoin(node, eq(node.id, documentTag.nodeId))
    .where(eq(documentTag.tagId, tagId))
    .orderBy(asc(node.title), asc(node.id))
    .all()
  return rows
    .flatMap(({ id, notes }) => {
      if (notes === null) return []
      const text = docToText(parseStoredTiptap(notes, id, 'notes')).trim()
      return text ? [text] : []
    })
    .join('\n\n')
}

/**
 * The first `max` characters with an ellipsis marking the cut, like the tags prompt's passage.
 * Shared with the features that send one scene (F-14.8 critique), so every head cut looks the
 * same to the model and to the quote matching that runs over the text as sent.
 */
export function headTruncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
