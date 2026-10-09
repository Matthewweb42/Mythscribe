import {
  findMentions,
  paragraphIndexes,
  passageParagraphs,
  type MentionCandidate,
  type MentionRange,
  type TagMentions
} from '@shared/mentions'
import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'
import { sha256 } from '../ai/request'
import { AppError } from '../ipc/errors'
import type { TreeDb } from '../tree/treeStore'
import { documentJson, documentText, manuscriptDocuments } from '../voice/profile'
import { passageHash, replaceNodePassages } from '../search/passageIndex'
import {
  getPassageHash,
  getScanHash,
  listMentionsForNode,
  replaceNodeMentions,
  scanHashes
} from './mentionStore'
import { listTags } from './tagStore'

/**
 * The automatic mention scan (F-4.12): after every save, main looks through the saved document
 * for the names of the tags whose tracking is on and records where each one occurs. It is
 * local and silent — nothing is inserted into the text, nothing leaves the machine, no key and
 * no dial are involved — and it runs on its own index queue (F-5.13) so a burst of saves costs
 * one scan.
 *
 * Invalidation is by content hash, never by time (CLAUDE.md, token efficiency rule 4): the hash
 * covers the document's text and the candidate list, so a save that changed neither costs
 * nothing at all, while a renamed, retired, or new tag makes every document stale and the
 * backfill finds them.
 */

/** What a scan of one document would be made from. */
export interface MentionSource {
  /** The document as it is stored; the empty document for a row that is empty or unreadable. */
  doc: TiptapNodeT
  /** The tags being looked for, in tag-store order. */
  candidates: MentionCandidate[]
  /** sha256 over the document's text and the candidates; a different hash means a stale scan. */
  contentHash: string
}

/**
 * Everything a scan of `nodeId` would read, or null when the node is not a manuscript document
 * (front and end matter, a folder, an unknown id): those are never scanned. One owner for the
 * hash, so the staleness check and the run can never disagree about what "unchanged" means.
 */
export function mentionSource(db: TreeDb, nodeId: string): MentionSource | null {
  const row = manuscriptDocuments(db).find((document) => document.id === nodeId)
  if (row === undefined) return null
  const candidates = mentionCandidates(db)
  return {
    doc: documentJson(row) ?? EMPTY_DOC,
    candidates,
    contentHash: mentionHash(documentText(row), candidates)
  }
}

/**
 * Scans one document and replaces what was recorded for it. A hash that still matches writes
 * nothing at all; otherwise the document's rows are rewritten in one transaction and the new
 * hash stored. `changed` says whether the mentions themselves moved, not whether the hash did:
 * renaming one tag makes every document stale, and the handler must only tell the windows about
 * the documents whose lists actually differ. `scanned` says whether the hash had moved at all,
 * which is what F-4.12b's proposals hang on: the text or the bank differs from the last scan, so
 * the proposed names are worth computing again even when no tag's mentions changed. A node that
 * is not a manuscript document throws NOT_FOUND, which the queue treats as quiet (the row goes,
 * nothing is shown): a scene that left the manuscript while its job waited is not a failure the
 * author can act on.
 */
export function scanMentions(
  db: TreeDb,
  nodeId: string,
  now: Date
): { changed: boolean; scanned: boolean } {
  const source = mentionSource(db, nodeId)
  if (source === null) {
    throw new AppError('NOT_FOUND', 'Not a manuscript document', { nodeId })
  }
  if (getScanHash(db, nodeId) === source.contentHash) return { changed: false, scanned: false }
  const mentions = findMentions(source.doc, source.candidates)
  const changed = !matchesStored(listMentionsForNode(db, nodeId), mentions)
  // F-9.12: the same pass is the local knowledge index — each range's paragraph, and the
  // document's paragraphs in the full-text table, rewritten only when they read differently.
  const paragraphs = passageParagraphs(source.doc)
  const byTag = new Map(
    [...mentions].map(([tagId, ranges]) => [tagId, paragraphIndexes(paragraphs, ranges)])
  )
  const hash = passageHash(paragraphs)
  db.transaction((tx) => {
    if (getPassageHash(tx, nodeId) !== hash) replaceNodePassages(tx, nodeId, paragraphs)
    replaceNodeMentions(tx, nodeId, mentions, source.contentHash, now, {
      paragraphs: byTag,
      passageHash: hash
    })
  })
  return { changed, scanned: true }
}

/** Whether what was recorded for a document already says exactly what the scan just found. */
function matchesStored(stored: TagMentions[], found: Map<string, MentionRange[]>): boolean {
  const withRanges = [...found.entries()].filter(([, ranges]) => ranges.length > 0)
  if (stored.length !== withRanges.length) return false
  // Both sides are arrays of `[from, to]` number pairs in document order, so the JSON of one is
  // the JSON of the other exactly when they say the same thing.
  const byTag = new Map(stored.map((mention) => [mention.tagId, JSON.stringify(mention.ranges)]))
  return withRanges.every(([tagId, ranges]) => byTag.get(tagId) === JSON.stringify(ranges))
}

/**
 * The manuscript documents whose recorded mentions do not match what a scan would find now, in
 * reading order: a manuscript written before this feature, one edited by an older build, or
 * every document after a tag was renamed or its tracking changed. Project open queues these.
 */
export function staleMentionNodeIds(db: TreeDb): string[] {
  const rows = manuscriptDocuments(db)
  const candidates = mentionCandidates(db)
  const hashes = scanHashes(
    db,
    rows.map((row) => row.id)
  )
  return rows
    .filter((row) => hashes.get(row.id) !== mentionHash(documentText(row), candidates))
    .map((row) => row.id)
}

/** The tags the scan looks for: every tag whose tracking the author has left on, with its aliases (F-4.14). */
function mentionCandidates(db: TreeDb): MentionCandidate[] {
  return listTags(db)
    .filter((tag) => tag.trackMentions)
    .map((tag) => ({ id: tag.id, name: tag.name, category: tag.category, aliases: tag.aliases }))
}

/**
 * Salted into every scan hash (F-9.12): bumped when what a scan writes changes (paragraph
 * indexes, the passage index), so the first open of a project afterwards rescans every document
 * once, locally.
 */
export const MENTION_INDEX_VERSION = 1

/**
 * The hash of everything a scan reads: the document's text and the candidates, by id, salted
 * with `MENTION_INDEX_VERSION`.
 */
function mentionHash(text: string, candidates: MentionCandidate[]): string {
  const names = [...candidates]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((candidate) =>
      (candidate.aliases ?? []).length === 0
        ? [candidate.id, candidate.name, candidate.category]
        : [candidate.id, candidate.name, candidate.category, ...(candidate.aliases ?? [])]
    )
  return sha256(JSON.stringify({ text, names, index: MENTION_INDEX_VERSION }))
}
