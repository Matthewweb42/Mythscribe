import { passageParagraphs } from '@shared/mentions'
import type { ReadingOrder } from '@shared/memory/asOf'
import type { Card } from '@shared/memory/claims'
import { dismissedKey } from '@shared/memory/dismissed'
import type { StoryRecordSummary } from '@shared/memory/records'
import { holdingCard, type HeldCard } from '@shared/memory/reproof'
import type { SceneDetails } from '@shared/memory/sceneDetails'
import { sceneRefs } from '@shared/memory/sceneRef'
import type { HereChip } from '@shared/memory/views'
import { searchableText } from '@shared/search'
import { EMPTY_DOC } from '@shared/tiptap'
import type { NodeRow } from '../../db/schema'
import { nodesInTreeOrder } from '../../search/searchStore'
import { getNode, listNodes, type TreeDb } from '../../tree/treeStore'
import { documentJson, manuscriptDocuments } from '../../voice/profile'
import { dismissedKeys } from '../dismissedStore'
import { sceneStatuses } from '../passageIndexer'

/**
 * The frame every story-memory view reads a scene in (F-16.18): the manuscript's reading order and
 * scene references, a scene's card as it stands on the text, and who is Here. `views.ts` (the
 * panel, the sheets, ⓘ), `timeViews.ts` (Threads, the Timeline, ages), the reading pipeline and the
 * prompt builders read them from here, so no view module imports another.
 */

/**
 * The manuscript's reading order for story memory: the readable scenes (not Idea, not left out
 * of compile) in reading order, where every manuscript scene reads "as of", and each scene's
 * reference. Chapters are counted as compile counts them (a chapter left out of compile is not
 * counted) and scenes are numbered among the readable scenes of their chapter, so "since 12.1"
 * names the compiled book's 12.1; an Idea scene or one left out of compile is named by its title.
 */
export function readingOrder(db: TreeDb, all: NodeRow[] = listNodes(db)): ReadingOrder {
  const docs = manuscriptDocuments(db, all)
  const byId = new Map(all.map((row) => [row.id, row]))
  const chapterOf = (row: NodeRow): string | null => {
    let at: NodeRow | undefined = row
    while (at !== undefined) {
      if (at.hierarchyLevel === 'chapter') return at.id
      at = at.parentId === null ? undefined : byId.get(at.parentId)
    }
    return null
  }
  const root = all.find((row) => row.parentId === null && row.sectionType === 'manuscript')
  const inBook = (row: NodeRow): boolean => {
    let at: NodeRow | undefined = row
    while (at !== undefined) {
      if (at.id === root?.id) return true
      at = at.parentId === null ? undefined : byId.get(at.parentId)
    }
    return false
  }
  const statuses = sceneStatuses(db, all)
  const readableDoc = (row: NodeRow): boolean =>
    !statuses.idea.has(row.id) && !statuses.excluded.has(row.id)
  const chapters = nodesInTreeOrder(all)
    .filter(
      (row) => row.hierarchyLevel === 'chapter' && inBook(row) && !statuses.excluded.has(row.id)
    )
    .map((row) => row.id)
  const readable = docs.filter(readableDoc)
  const refs = sceneRefs({
    chapters,
    scenes: readable.map((row) => ({
      id: row.id,
      title: searchableText(row.title),
      chapterId: chapterOf(row)
    }))
  })
  const order = new Map(readable.map((row, i) => [row.id, i]))
  const at = new Map<string, number>()
  let last = -1
  for (const row of docs) {
    const own = order.get(row.id)
    if (own !== undefined) last = own
    at.set(row.id, own ?? last)
    if (own === undefined) refs.set(row.id, searchableText(row.title).trim() || 'Untitled scene')
  }
  return { order, at, refs }
}

/** A document's paragraph texts as stored now (none for a node that is no document). */
function sceneTexts(db: TreeDb, nodeId: string): string[] {
  const row = getNode(db, nodeId)
  return row === undefined ? [] : rowTexts(row)
}

/**
 * A scene's card as Here, the card block and decision 4's conflicts may use it (F-16.18;
 * `holdingCard`): what the author said is not right left out, what no longer stands on the text
 * (its quote's sentence edited or gone) stale until the next reading, and nothing standing in a
 * scene that is not `readable`. `notRight`: the `notRight` Dismissed keys, when the caller has
 * them; `texts`: the scene's paragraph texts, when the caller has them (the Timeline holds every
 * scene's row already, F-16.23).
 */
export function heldCard(
  db: TreeDb,
  card: Card,
  readable: boolean,
  notRight: ReadonlySet<string> = dismissedKeys(db, 'notRight'),
  texts?: readonly string[]
): HeldCard {
  const paragraphs = readable ? (texts ?? sceneTexts(db, card.nodeId)) : null
  return holdingCard(card, paragraphs, (field, value) =>
    notRight.has(dismissedKey({ kind: 'notRight', card: { nodeId: card.nodeId, field, value } }))
  )
}

/** A document row's paragraph texts as stored. */
export function rowTexts(row: NodeRow): string[] {
  return passageParagraphs(documentJson(row) ?? EMPTY_DOC).map((paragraph) => paragraph.text)
}

/**
 * Here (P2a-D21, decision 4): the POV first (the card's verified POV, standing on the text, over a
 * typed one that differs, which rides along as `typedPov`; else the typed POV), then the characters
 * on the page with a verified quote that stands, then *+ also here*; each record once, and only
 * records that exist. The This scene panel and the Story notes block (F-16.20) read the same list.
 */
export function hereChips(
  details: SceneDetails,
  held: HeldCard | null,
  records: ReadonlyMap<string, Pick<StoryRecordSummary, 'kind'>>
): HereChip[] {
  const here: HereChip[] = []
  const add = (chip: HereChip): void => {
    if (records.has(chip.recordId) && !here.some((each) => each.recordId === chip.recordId)) {
      here.push(chip)
    }
  }
  // A verified POV whose record is gone (deleted since) is no POV: the typed one stands.
  const cardPov = held?.fields.pov ?? null
  const textPov = cardPov?.verified === true && records.has(cardPov.value) ? cardPov : null
  const typedPov = details.povRecordId
  if (textPov !== null) {
    add({
      recordId: textPov.value,
      why: 'pov',
      quote: textPov.quote,
      p: textPov.p,
      typedPov: typedPov !== null && typedPov !== textPov.value ? typedPov : null
    })
  } else if (typedPov !== null) {
    add({ recordId: typedPov, why: 'pov', quote: null, p: null, typedPov: null })
  }
  for (const present of held?.present ?? []) {
    if (!present.verified || records.get(present.recordId)?.kind !== 'character') continue
    add({
      recordId: present.recordId,
      why: 'onPage',
      quote: present.quote,
      p: present.p,
      typedPov: null
    })
  }
  for (const id of details.alsoHere) {
    add({ recordId: id, why: 'alsoHere', quote: null, p: null, typedPov: null })
  }
  return here
}
