import {
  countCapitalisedWords,
  proposeTags,
  type DocumentWordCounts,
  type ProposedTag,
  type WordCount
} from '@shared/proposedTags'
import { toTagName } from '@shared/tags'
import { aliasKey } from '@shared/aliases'
import { isMisspeltName } from '@shared/misspellings'
import { getDismissedNames, getKeptSpellings, setDismissedNames } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'
import { documentText, manuscriptDocuments } from '../voice/profile'
import { listTags } from './tagStore'

/**
 * Proposed tags (F-4.12b): the recurring capitalised names of the manuscript that no tag stands
 * for yet. Everything is local — the same saved rows F-4.12 scans, no key, no dial, nothing sent
 * anywhere — and nothing is written until the author accepts a proposal (which is an ordinary
 * `tag:create`) or dismisses one, which stores the name and keeps it quiet for the project.
 *
 * The list is computed rather than stored: it depends on the text, the tag bank, and the
 * dismissals, all three of which move under it. Tokenising the whole manuscript on every save
 * would be the one expensive part, so each document's counts are memoised by its text and only
 * the document that changed is read again.
 */

/** One memoised document: the text the counts were taken from, so a save that changed it re-tokenises. */
interface CountedDocument {
  text: string
  counts: Map<string, WordCount>
}

/**
 * The per-document word counts, keyed by node id. Rebuilt from the open project's rows on every
 * call, so a document that was deleted — or a whole project that was closed — leaves nothing
 * behind, and a node id from another project simply misses.
 */
let memo = new Map<string, CountedDocument>()

/**
 * What the tag bar shows (F-4.12b): every name the manuscript keeps using mid-sentence that is
 * not already a tag, not dismissed, and not one of the words capitalised by grammar alone, most
 * used first and capped at `PROPOSED_TAG_MAX`. Pure with respect to the database: it writes
 * nothing, which is what lets the handler call it after every scan.
 */
export function listProposedTags(db: TreeDb): ProposedTag[] {
  const next = new Map<string, CountedDocument>()
  const perDocument: DocumentWordCounts[] = []
  for (const row of manuscriptDocuments(db)) {
    const text = documentText(row)
    const hit = memo.get(row.id)
    const counted = hit?.text === text ? hit : { text, counts: countCapitalisedWords(text) }
    next.set(row.id, counted)
    perDocument.push({ nodeId: row.id, counts: counted.counts })
  }
  memo = next
  // F-4.14: an alias is a name the bank already has; it is never proposed as a tag of its own.
  const bankNames = listTags(db).flatMap((tag) => [tag.name, ...tag.aliases.map(aliasKey)])
  const kept = new Set(getKeptSpellings(db))
  // A likely misspelling of a bank name ("Falseer" beside `rynna-falsire`) is offered as a fix in
  // the tags column instead, until the author keeps the spelling.
  return proposeTags(perDocument, bankNames, getDismissedNames(db).names).filter(
    (proposal) => kept.has(proposal.name) || !isMisspeltName(proposal.name, bankNames)
  )
}

/**
 * Dismisses a proposal (F-4.12b) and answers the list without it. The name is normalised the way
 * a tag name is, so the row the author saw ("Tash") and a later spelling of the same word are
 * one dismissal; dismissing a name twice stores nothing new. A name that empties under
 * normalisation is not stored, since nothing could ever match it.
 */
export function dismissName(db: TreeDb, name: string): ProposedTag[] {
  const dismissed = toTagName(name)
  const stored = getDismissedNames(db)
  if (dismissed.length > 0 && !stored.names.includes(dismissed)) {
    setDismissedNames(db, { names: [...stored.names, dismissed] })
  }
  return listProposedTags(db)
}

/** Forgets the memoised counts (a project change, or one test's manuscript before the next). */
export function resetProposedTagCache(): void {
  memo = new Map()
}
