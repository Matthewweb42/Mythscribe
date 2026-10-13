import { relateLine } from '@shared/filing'
import {
  AI_WRITTEN_ATTR,
  aiWrittenOf,
  NOT_CANON_ATTR,
  pageTextBlocks,
  type AiWritten
} from '@shared/memory/pageMarks'
import type { RecordPage, StoryRecord } from '@shared/memory/records'
import { isNamedKind } from '@shared/memory/topics'
import type { SheetLineAdd, SheetLineRemove, SheetLineResult } from '@shared/scribe'
import type { TiptapNodeT } from '@shared/tiptap'
import { AppError } from '../ipc/errors'
import { indexOwner } from '../memory/passageIndexer'
import { requireRecord, savePage } from '../memory/recordStore'
import type { TreeDb } from '../tree/treeStore'

/**
 * Sheet lines from the chat (F-16.26; decision 3 as the author changed it, plan P3 §1.3): when
 * the author asks Ms Scribe to put something on a record's sheet, one paragraph is added at the
 * end of its Pinned or Ideas page, marked `aiWritten` (the chat turn and the day) until the
 * author edits its words (P1's rule, `clearAiMarks`). A line the page already says is refused; a
 * Pinned line that contradicts one under the same label is added and the line it contradicts named.
 * The Undo takes the line out only while it still reads as written and carries the turn's mark.
 * Each write re-indexes the record's passages, so the line is found at once (an Ideas line as the
 * author's idea). Only these pages are written: never a claim, a card or a reading (P3 rule 6).
 * The caller pushes `record:changed`.
 */

/** The day a line was written, as its mark keeps it (`2026-10-13`). */
const dayOf = (now: Date): string => now.toISOString().slice(0, 10)

const pageOf = (record: StoryRecord, page: RecordPage): TiptapNodeT | null =>
  page === 'pinned' ? record.pinned : record.ideas

/** A paragraph of the line's words, marked as written from the chat. */
export function writtenBlock(text: string, mark: AiWritten): TiptapNodeT {
  return {
    type: 'paragraph',
    attrs: { [NOT_CANON_ATTR]: false, [AI_WRITTEN_ATTR]: mark },
    content: [{ type: 'text', text }]
  }
}

/** The record a line may go on: a person, place, thing, group or term (never a secret or thread). */
function sheetRecord(db: TreeDb, id: string): StoryRecord {
  const record = requireRecord(db, id)
  if (!isNamedKind(record.kind)) {
    throw new AppError('VALIDATION', 'Ms Scribe puts lines only on a named record’s sheet.', { id })
  }
  return record
}

/**
 * How a line relates to what a record's page already says (`relateLine`): `duplicate` when the
 * page says it (the same words, or a labelled line the page covers), else the line's kind and the
 * paragraph it would update or contradict. Ms Scribe offers no line a page already holds
 * (`runScribe`, P3-D16), and `addSheetLine` refuses one.
 */
export function relateToPage(
  record: StoryRecord,
  page: RecordPage,
  text: string
): ReturnType<typeof relateLine> {
  const doc = pageOf(record, page)
  const said = (doc === null ? [] : pageTextBlocks(doc)).map((block) => ({
    index: block.index,
    text: block.text
  }))
  return relateLine(text.replace(/\s+/gu, ' ').trim(), said)
}

/**
 * Adds one line at the end of a record's Pinned or Ideas page, marked `aiWritten { turn, date }`,
 * and re-indexes the record. ALREADY_EXISTS when the page says it already (`relateLine`: the
 * same words, or a labelled line the page covers); `conflict` is the Pinned line under the same
 * label with another value ("Eyes: grey" for "Eyes: green"), else null.
 */
export function addSheetLine(db: TreeDb, input: SheetLineAdd, now: Date): SheetLineResult {
  const text = input.text.replace(/\s+/gu, ' ').trim()
  if (text === '') throw new AppError('VALIDATION', 'The line has no words.')
  const record = sheetRecord(db, input.id)
  const page = pageOf(record, input.page)
  const blocks = page === null ? [] : pageTextBlocks(page)
  const relation = relateToPage(record, input.page, text)
  if (relation === 'duplicate') {
    throw new AppError(
      'ALREADY_EXISTS',
      `${record.name}’s ${input.page === 'pinned' ? 'Pinned' : 'Ideas'} already says that.`,
      { id: input.id }
    )
  }
  // A Pinned line under the same label with another value: added as asked, and named back, so
  // the chat's confirmation says what it contradicts. Ideas may disagree with one another.
  const conflict =
    input.page === 'pinned' && relation.kind === 'conflict' ? relation.replaces : null
  const doc: TiptapNodeT = page ?? { type: 'doc', content: [] }
  const block = writtenBlock(text, { turn: input.turn, date: dayOf(now) })
  const saved = db.transaction((tx) => {
    const written = savePage(
      tx,
      input.id,
      input.page,
      { ...doc, content: [...(doc.content ?? []), block] },
      now
    )
    indexOwner(tx, 'record', input.id, now)
    return written
  })
  return { record: saved, index: blocks.length, text, conflict }
}

/**
 * The chat's Undo: takes the line out while the block at `index` still reads `text` and carries
 * this turn's mark; VALIDATION "Edited since; change it on the sheet." otherwise.
 */
export function removeSheetLine(db: TreeDb, input: SheetLineRemove, now: Date): StoryRecord {
  const record = sheetRecord(db, input.id)
  const page = pageOf(record, input.page)
  const found = page === null ? undefined : pageTextBlocks(page)[input.index]
  const top = page?.content ?? []
  const at = found === undefined ? -1 : top.indexOf(found.block)
  if (
    page === null ||
    found === undefined ||
    at < 0 ||
    found.text.trim() !== input.text.trim() ||
    aiWrittenOf(found.block)?.turn !== input.turn
  ) {
    throw new AppError('VALIDATION', 'Edited since; change it on the sheet.', { id: input.id })
  }
  return db.transaction((tx) => {
    const saved = savePage(
      tx,
      input.id,
      input.page,
      { ...page, content: top.filter((_, i) => i !== at) },
      now
    )
    indexOwner(tx, 'record', input.id, now)
    return saved
  })
}
