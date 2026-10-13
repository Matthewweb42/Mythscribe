import type { ReadingOrder } from '@shared/memory/asOf'
import { knowsAsOf, knowsGrid, type KnowsAsOf } from '@shared/memory/whoKnows'
import type { KnowsGrid, KnowsSheetLine, KnowsSheetView, TopicView } from '@shared/memory/views'
import type { NodeRow } from '../../db/schema'
import { currentDraftId } from '../../draft/draftStore'
import type { TreeDb } from '../../tree/treeStore'
import { namedInCounts } from '../nameIndexer'
import { slotClaims } from './claimStore'
import { listKnewBefore } from './knewBeforeStore'
import { readingSummaries } from './readingStore'
import { sceneReadFlags } from './sceneReadStore'
import { listTopicQuotes, listTopics } from './topicStore'

/**
 * Who knows what as the panel, the Book grid and the sheets show it (F-16.22; plan P2b §4.1):
 * `knowsAsOf` over the active draft's stores, read-only and local. The views carry only what was
 * proved, the author's *Knew before the book* marks and `checkedUpTo` (P2b rule 9): the words "No
 * scene shows … (checked up to …)" are composed in the renderer alone (`knowsView.ts`), and
 * nothing here reaches a prompt, the Story notes block or a chat tool. `views.ts` (the This scene
 * panel and the sheets) and the `memory:knows` channel call these with the reading order they
 * already hold.
 */

/**
 * Who knows what as of a scene (`atId`; null: the end of the book) over the active draft: every
 * secret, its knows claims, its reveals (each with the reading that proved it, for ⓘ), the
 * author's knew-before marks and the scenes' read flags. A readable scene with no words yet is
 * checked as it stands (`checkedUpTo`'s `empty`). No draft yet: the secrets and the marks only.
 */
export function storedKnows(
  db: TreeDb,
  atId: string | null,
  reading: ReadingOrder,
  nodes: readonly NodeRow[]
): KnowsAsOf {
  const draftId = currentDraftId(db)
  const secrets = listTopics(db, 'secret').map(({ recordId, label, origin }) => ({
    recordId,
    label,
    origin
  }))
  const empty = new Set(
    nodes
      .filter((row) => row.kind === 'document' && row.wordCount === 0 && reading.order.has(row.id))
      .map((row) => row.id)
  )
  const knewBefore = listKnewBefore(db)
  if (draftId === null) {
    return knowsAsOf({
      secrets,
      claims: [],
      quotes: [],
      knewBefore,
      reading,
      flags: new Map(),
      empty,
      atId
    })
  }
  const quotes = listTopicQuotes(db, draftId)
  const readings = readingSummaries(
    db,
    quotes.flatMap((quote) => (quote.readingId === null ? [] : [quote.readingId]))
  )
  return knowsAsOf({
    secrets,
    claims: slotClaims(db, 'knows', draftId),
    quotes: quotes.map((quote) => ({
      ...quote,
      reading: quote.readingId === null ? null : (readings.get(quote.readingId) ?? null)
    })),
    knewBefore,
    reading,
    flags: sceneReadFlags(db, draftId),
    empty,
    atId
  })
}

/** How often the book names each record, certain mentions only (the grid's column order). */
export function namedTotals(db: TreeDb): Map<string, number> {
  const totals = new Map<string, number>()
  for (const row of namedInCounts(db)) {
    totals.set(row.recordId, (totals.get(row.recordId) ?? 0) + row.count)
  }
  return totals
}

/**
 * The Book's who-knows-what grid as of a scene (P2b-D20): the secrets readers know then (newest
 * first), the characters and groups with a line or a knew-before mark, plus the scene's POV
 * (`pov`), by how often the book names them.
 */
export function storedGrid(knows: KnowsAsOf, db: TreeDb, pov: string | null): KnowsGrid {
  return knowsGrid(knows, { pov, named: namedTotals(db) })
}

/**
 * A character's or group's Knows as of the scene the view was read as of: its cell per secret
 * (counted, the author's knew-before, or partial) in the view's order, its lines that never count
 * apart, and how many secrets its first line comes later for. Nothing for a secret it has no
 * line about: absence is never a line.
 */
export function sheetKnows(knows: KnowsAsOf, recordId: string): KnowsSheetView {
  const lines: KnowsSheetLine[] = []
  const others: KnowsSheetLine[] = []
  let later = 0
  for (const secret of knows.secrets) {
    const cell = secret.cells.find((each) => each.knowerId === recordId)
    if (cell?.later === true) later += 1
    else if (cell !== undefined) {
      lines.push({ secretId: secret.recordId, label: secret.label, cell })
    }
    for (const other of secret.others) {
      if (other.knowerId === recordId) {
        others.push({ secretId: secret.recordId, label: secret.label, cell: other })
      }
    }
  }
  return { lines, others, later }
}

/** A secret's own view as of the scene (its sheet's *The secret*); null when it is no secret. */
export function secretTopic(knows: KnowsAsOf, recordId: string): TopicView | null {
  const secret = knows.secrets.find((each) => each.recordId === recordId)
  return secret === undefined ? null : { kind: 'secret', secret }
}
