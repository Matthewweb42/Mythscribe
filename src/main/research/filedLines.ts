import { normalizeForMatch } from '@shared/critique'
import { dismissedKey } from '@shared/memory/dismissed'
import {
  aiFiledOf,
  AI_FILED_ATTR,
  pageTextBlocks,
  type MarkedParagraph
} from '@shared/memory/pageMarks'
import type { FiledConflict } from '@shared/filing'
import type { StoryRecord } from '@shared/memory/records'
import type { Dismissed } from '@shared/memory/dismissed'
import type { TiptapNodeT } from '@shared/tiptap'
import { sha256 } from '../ai/request'
import { AppError } from '../ipc/errors'
import { dismiss, isDismissed } from '../memory/dismissedStore'
import { getRecord, listRecords, requireRecord, savePage } from '../memory/recordStore'
import { getNode, type TreeDb } from '../tree/treeStore'
import { pageParagraphs } from './filing'
import { researchDocOf } from './researchStore'
import { isUnderResearch } from './researchTree'

/**
 * The filed-line check (F-16.9): a Pinned paragraph filed from a Research page (`aiFiled`) whose
 * quote is no longer in a canon paragraph of that page, or whose page is marked Not canon as a
 * whole now, is a Needs a look **conflict**: "Filed from 'Bestiary' ¶4, which now reads '…'" (or
 * "which is now Not canon"), with *Go there* · *Update line* (the author rewrites the line beside
 * the page's closest paragraph; nothing is written without her) · *Keep line* (a `notProblem`
 * dismissal keyed by the record, the line and its quote, and the page's closest paragraph as it
 * reads now, so only a later change to that paragraph asks again; an edit elsewhere on the page
 * does not). Local and free; run when a Research page or a Pinned page is saved, when a page's
 * Not canon switch moves, and when the panel opens. A paragraph the author edited lost its mark,
 * so it is hers and never checked; a page that is gone is not checked either.
 */

/** Characters of the page's closest paragraph the conflict shows. */
export const FILED_NOW_READS_MAX = 160

const words = (text: string): Set<string> =>
  new Set(
    normalizeForMatch(text)
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2)
  )

/** The page's paragraph closest to `quote` (most words in common, then nearest to `para`). */
export function closestParagraph(
  quote: string,
  para: number,
  paragraphs: readonly MarkedParagraph[]
): MarkedParagraph | null {
  const wanted = words(quote)
  let best: { paragraph: MarkedParagraph; score: number } | null = null
  for (const paragraph of paragraphs) {
    if (paragraph.notCanon) continue
    const have = words(paragraph.text)
    const score = [...wanted].filter((word) => have.has(word)).length
    if (
      best === null ||
      score > best.score ||
      (score === best.score &&
        Math.abs(paragraph.index - para) < Math.abs(best.paragraph.index - para))
    ) {
      best = { paragraph, score }
    }
  }
  return best?.paragraph ?? null
}

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

/**
 * The *Keep line* reference: the record, the line and its quote, and what the source says about it
 * now (`nowReads`: the page's closest paragraph, whole; a Not canon page is its own state).
 */
export function filedConflictKey(
  recordId: string,
  line: string,
  quote: string,
  nowReads: string
): string {
  return `filed|${recordId}|${sha256(`${line}\u0000${quote}`).slice(0, 16)}|${sha256(nowReads).slice(0, 16)}`
}

/** What a Not canon page "reads" for the *Keep line* key: no paragraph's text can equal it. */
const PAGE_NOT_CANON = '\u0000not canon'

interface FiledSource {
  title: string
  paragraphs: MarkedParagraph[]
  notCanon: boolean
}

/** Every filed line whose source changed, record by record (by name), each in page order. */
export function filedConflicts(db: TreeDb): FiledConflict[] {
  const pages = new Map<string, FiledSource | null>()
  const pageOf = (docId: string): FiledSource | null => {
    if (!pages.has(docId)) {
      const row = getNode(db, docId)
      if (row?.kind !== 'document' || !isUnderResearch(db, row)) {
        pages.set(docId, null)
      } else {
        pages.set(docId, {
          title: row.title,
          paragraphs: pageParagraphs(db, docId),
          notCanon: researchDocOf(db, docId).notCanon
        })
      }
    }
    return pages.get(docId) ?? null
  }
  const found: FiledConflict[] = []
  for (const summary of listRecords(db)) {
    const record = getRecord(db, summary.id)
    if (record?.pinned == null) continue
    for (const block of pageTextBlocks(record.pinned)) {
      const filed = aiFiledOf(block.block)
      if (filed === null) continue
      const page = pageOf(filed.doc)
      if (page === null) continue
      const needle = normalizeForMatch(filed.quote).toLocaleLowerCase()
      const still =
        !page.notCanon &&
        page.paragraphs.some(
          (paragraph) =>
            !paragraph.notCanon &&
            normalizeForMatch(paragraph.text).toLocaleLowerCase().includes(needle)
        )
      if (still) continue
      const closest = closestParagraph(filed.quote, filed.para, page.paragraphs)
      const key = filedConflictKey(
        record.id,
        block.text,
        filed.quote,
        page.notCanon ? PAGE_NOT_CANON : (closest?.text ?? '')
      )
      if (isDismissed(db, 'notProblem', dismissedKey({ kind: 'notProblem', ref: key }))) continue
      found.push({
        key,
        recordId: record.id,
        recordName: record.name,
        docId: filed.doc,
        docTitle: page.title,
        para: filed.para,
        line: block.text,
        lineIndex: block.index,
        quote: filed.quote,
        nowReads: closest === null ? null : clip(closest.text, FILED_NOW_READS_MAX),
        pageNotCanon: page.notCanon
      })
    }
  }
  return found
}

/** *Keep line*: the conflict stays quiet until its paragraph changes again (`notProblem`). */
export function keepFiledLine(db: TreeDb, conflict: FiledConflict, now: Date): Dismissed {
  return dismiss(
    db,
    {
      kind: 'notProblem',
      key: dismissedKey({ kind: 'notProblem', ref: conflict.key }),
      recordId: conflict.recordId,
      nodeId: conflict.docId,
      label: `${conflict.recordName}: kept “${clip(conflict.line, 80)}” (filed from “${conflict.docTitle}”)`,
      quote: conflict.quote
    },
    now
  )
}

/**
 * *Update line*: the author's own words for a filed Pinned paragraph, found by its index and its
 * text. The paragraph is hers from then on, so its `aiFiled` mark goes. VALIDATION when the line
 * changed since the panel read it.
 */
export function updateFiledLine(
  db: TreeDb,
  input: { recordId: string; lineIndex: number; line: string; text: string },
  now: Date
): StoryRecord {
  const record = requireRecord(db, input.recordId)
  const text = input.text.replace(/\s+/g, ' ').trim()
  if (text === '')
    throw new AppError('VALIDATION', 'A line needs some words; Keep line leaves it as it is')
  const target =
    record.pinned === null
      ? undefined
      : pageTextBlocks(record.pinned).find(
          (block) =>
            block.index === input.lineIndex &&
            block.text === input.line &&
            aiFiledOf(block.block) !== null
        )
  if (record.pinned === null || target === undefined) {
    throw new AppError('VALIDATION', 'That line changed since; open the sheet to edit it', {
      recordId: input.recordId
    })
  }
  const replace = (node: TiptapNodeT): TiptapNodeT => {
    if (node === target.block) {
      return {
        ...node,
        attrs: { ...(node.attrs ?? {}), [AI_FILED_ATTR]: null },
        content: [{ type: 'text', text }]
      }
    }
    return node.content === undefined ? node : { ...node, content: node.content.map(replace) }
  }
  return savePage(db, input.recordId, 'pinned', replace(record.pinned), now)
}
