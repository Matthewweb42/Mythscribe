import { and, eq } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import type { ReadingOrder } from '@shared/memory/asOf'
import {
  deathWord,
  lifeWord,
  type CandidateClaim,
  type CandidateInputs,
  type CandidateRecord,
  type SceneFacts,
  type TypedScene
} from '@shared/memory/candidates'
import { emptyCardFields, setsState, type Card, type Claim } from '@shared/memory/claims'
import type {
  LooseCharacter,
  LooseEndsInput,
  LoosePlanned,
  LooseThread
} from '@shared/memory/looseEnds'
import type { NoteParagraph } from '@shared/memory/noteValues'
import { stepCounts } from '@shared/memory/threadsAsOf'
import { parseStep } from '@shared/memory/topics'
import { checkedUpTo } from '@shared/memory/whoKnows'
import { searchableText } from '@shared/search'
import { nameMention, type NodeRow } from '../../db/schema'
import { researchDocumentIds } from '../../research/researchTree'
import { listNodes, type TreeDb } from '../../tree/treeStore'
import { dismissedKeys } from '../dismissedStore'
import { listRecords } from '../recordStore'
import { allSceneDetails } from '../sceneDetailStore'
import { draftCards } from '../reading/cardStore'
import { draftClaims } from '../reading/claimStore'
import { emptyScenes } from '../reading/knowsViews'
import { listKnewBefore } from '../reading/knewBeforeStore'
import { authorLink, boardOf, isDrafted, isPlanned, livePlanLinks } from '../reading/planLinkStore'
import { heldCard, readingOrder, rowTexts } from '../reading/readingFrame'
import { sceneReadFlags } from '../reading/sceneReadStore'
import { listTopicQuotes, listTopics } from '../reading/topicStore'

/**
 * What the contradiction rules read (F-16.27; plan P4 §1.4), over the active draft's stores: its
 * claims in readable scenes (live or stale, never waiting), the stored cards' `present` lists, the
 * typed details, the author's *Knew before the book*, the records and their names, the canon note
 * paragraphs from the passage index (Pinned pages and canon Research pages; never Ideas, Not canon
 * pages or paragraphs, scene notes or synopses), the readable scenes a dated note line may name, and
 * the *Not a problem* keys. A scene's card is held against its text only when a rule asks
 * (`scene`), once per scene (P2b's lesson: never the whole book). Local and free.
 */

/** The parts of a card the rules read: who is on the page, the flashback and the year. */
function slimCard(card: Card): Card | null {
  const fields = emptyCardFields()
  fields.flashback = card.fields.flashback
  fields.year = card.fields.year
  if (fields.flashback === null && fields.year === null && card.present.length === 0) return null
  return { ...card, fields }
}

const NO_FACTS: SceneFacts = { present: new Set(), flashback: false, quotedYear: null }

const toCandidateClaim = (claim: Claim & { recordId: string }): CandidateClaim => ({
  id: claim.id,
  recordId: claim.recordId,
  slot: claim.slot,
  value: claim.value,
  valueKey: claim.valueKey,
  objectId: claim.objectId,
  how: claim.how,
  fromId: claim.fromId,
  voice: claim.voice,
  speakerId: claim.speakerId,
  mode: claim.mode,
  nodeId: claim.nodeId,
  para: claim.para,
  state: claim.state === 'stale' ? 'stale' : 'live',
  change: claim.change,
  created: claim.created,
  quote: claim.quote,
  anchor: claim.anchor
})

interface NoteRow {
  source: string
  ownerId: string
  para: number
  text: string
}

/** The canon note rows last read, per database, under the note owners' passage hashes then. */
const noteRowsRead = new WeakMap<TreeDb, { hashes: string; rows: NoteRow[] }>()

/**
 * The index's canon note rows (Pinned pages, written and uploaded Research pages), read again only
 * when a note owner's passage hash moved: the passage indexer, their one writer, sets an owner's
 * hash with every write of its rows and drops it with them (`writeOwner`, `dropOwner`, the prune).
 * Read from FTS5's content table (columns c0 source, c1 owner_id, c2 para, c3 canon, c4 text): a
 * plain table scan, never the full-text table's row by row walk over every scene paragraph.
 */
function canonNoteRows(db: TreeDb): NoteRow[] {
  const hashes = db
    .all<{ kind: string; id: string; hash: string | null }>(
      sql`SELECT owner_kind AS kind, owner_id AS id, passages_hash AS hash FROM memory_scan
          WHERE owner_kind IN ('record', 'research') ORDER BY owner_kind, owner_id`
    )
    .map((row) => `${row.kind}:${row.id}:${row.hash ?? ''}`)
    .join('|')
  const known = noteRowsRead.get(db)
  if (known?.hashes === hashes) return known.rows
  const rows = db.all<NoteRow>(
    sql`SELECT c0 AS source, c1 AS ownerId, c2 AS para, c4 AS text FROM memory_passage_fts_content
        WHERE c3 = 'canon' AND c0 IN ('pinned', 'note', 'research')`
  )
  noteRowsRead.set(db, { hashes, rows })
  return rows
}

/**
 * The canon note paragraphs the passage index holds: Pinned pages of records that exist and canon
 * Research pages still in the Research tree (an owner deleted keeps its rows until the next open's
 * prune, so they are skipped here, as every reader of the index does). In a stable page order:
 * records in list order, then Research in tree order, each by paragraph, so which two sentences C6
 * compares never depends on which page was re-indexed last.
 */
export function canonNotes(
  db: TreeDb,
  nodes: readonly NodeRow[] = listNodes(db),
  records: readonly string[] = listRecords(db).map((each) => each.id)
): NoteParagraph[] {
  const recordAt = new Map(records.map((id, i) => [id, i]))
  const researchAt = new Map(researchDocumentIds(nodes).map((id, i) => [id, i]))
  const placed = canonNoteRows(db).flatMap((row) => {
    const pinned = row.source === 'pinned'
    const at = (pinned ? recordAt : researchAt).get(row.ownerId)
    return at === undefined ? [] : [{ row, pinned, at }]
  })
  placed.sort(
    (x, y) =>
      Number(y.pinned) - Number(x.pinned) ||
      x.at - y.at ||
      x.row.para - y.row.para ||
      x.row.source.localeCompare(y.row.source)
  )
  return placed.map(({ row, pinned }) =>
    pinned
      ? {
          ownerKind: 'record',
          ownerId: row.ownerId,
          page: 'pinned',
          para: row.para,
          text: row.text
        }
      : { ownerKind: 'research', ownerId: row.ownerId, page: null, para: row.para, text: row.text }
  )
}

/** The records as the rules read them: kind, name and every name with its case rule. */
function candidateRecords(records: ReturnType<typeof listRecords>): Map<string, CandidateRecord> {
  return new Map(
    records.map((record) => [
      record.id,
      {
        id: record.id,
        kind: record.kind,
        name: record.name,
        names: record.aliases.map((alias) => ({
          text: alias.text,
          caseRule: alias.caseRule,
          shared: alias.shared
        }))
      }
    ])
  )
}

/** The frame both builders share: the tree and its reading order. */
export interface FindingsFrame {
  nodes: NodeRow[]
  reading: ReadingOrder
}

export const findingsFrame = (db: TreeDb): FindingsFrame => {
  const nodes = listNodes(db)
  return { nodes, reading: readingOrder(db, nodes) }
}

/** The active draft's claims the rules read: a record, in a readable scene, not waiting. */
function readableClaims(
  db: TreeDb,
  draftId: string,
  reading: ReadingOrder
): (Claim & { recordId: string })[] {
  return draftClaims(db, draftId).filter(
    (claim): claim is Claim & { recordId: string } =>
      claim.recordId !== null && claim.state !== 'waiting' && reading.order.has(claim.nodeId)
  )
}

/**
 * One scene's held card as the rules read it (its text is read once, only when a rule asks): who is
 * on the page by a verified quote that still stands, the verified flashback, the quoted year.
 */
function sceneFactsReader(
  db: TreeDb,
  rows: ReadonlyMap<string, NodeRow>,
  cards: ReadonlyMap<string, Card>
): (nodeId: string) => SceneFacts {
  let notRight: ReadonlySet<string> | null = null
  const facts = new Map<string, SceneFacts>()
  return (nodeId) => {
    const known = facts.get(nodeId)
    if (known !== undefined) return known
    const stored = cards.get(nodeId)
    const card = stored === undefined ? null : slimCard(stored)
    const row = rows.get(nodeId)
    let found = NO_FACTS
    if (card !== null && row !== undefined) {
      notRight ??= dismissedKeys(db, 'notRight')
      const held = heldCard(db, card, true, notRight, rowTexts(row))
      const flashback = held.fields.flashback
      const year = held.fields.year
      found = {
        present: new Set(held.present.filter((each) => each.verified).map((each) => each.recordId)),
        flashback: flashback?.verified === true && flashback.value === 'yes',
        quotedYear: year?.verified === true ? year.value : null
      }
    }
    facts.set(nodeId, found)
    return found
  }
}

/** The active draft's stored cards in readable scenes, by scene. */
function readableCards(db: TreeDb, draftId: string, reading: ReadingOrder): Map<string, Card> {
  return new Map(
    draftCards(db, draftId)
      .filter((card) => reading.order.has(card.nodeId))
      .map((card) => [card.nodeId, card])
  )
}

/** The rules' inputs over the active draft `draftId`. */
export function candidateInputs(
  db: TreeDb,
  draftId: string,
  frame: FindingsFrame = findingsFrame(db)
): CandidateInputs {
  const { nodes, reading } = frame
  const rows = new Map(nodes.map((row) => [row.id, row]))
  const cards = readableCards(db, draftId, reading)
  const onPage = new Map<string, Set<string>>()
  for (const [nodeId, card] of cards) {
    if (card.present.length > 0)
      onPage.set(nodeId, new Set(card.present.map((each) => each.recordId)))
  }
  const typed = new Map<string, TypedScene>()
  for (const [nodeId, details] of allSceneDetails(db)) {
    if (!reading.order.has(nodeId)) continue
    typed.set(nodeId, {
      pov: details.povRecordId,
      alsoHere: details.alsoHere,
      year: details.storyYear
    })
  }
  const records = listRecords(db)
  return {
    reading,
    claims: readableClaims(db, draftId, reading).map(toCandidateClaim),
    onPage,
    typed,
    scene: sceneFactsReader(db, rows, cards),
    knewBefore: listKnewBefore(db),
    records: candidateRecords(records),
    notes: canonNotes(
      db,
      nodes,
      records.map((each) => each.id)
    ),
    scenes: [...reading.order.keys()].map((nodeId) => ({
      nodeId,
      ref: reading.refs.get(nodeId) ?? '',
      title: searchableText(rows.get(nodeId)?.title ?? '').trim()
    })),
    dismissed: dismissedKeys(db, 'notProblem')
  }
}

/** Which readable scenes the name scan names each record in for certain (ambiguous spans left out). */
function namedScenes(db: TreeDb, reading: ReadingOrder): Map<string, string[]> {
  const rows = db
    .selectDistinct({ nodeId: nameMention.nodeId, recordId: nameMention.recordId })
    .from(nameMention)
    .where(and(eq(nameMention.ambiguous, false)))
    .all()
  const out = new Map<string, string[]>()
  for (const row of rows) {
    if (!reading.order.has(row.nodeId)) continue
    out.set(row.recordId, [...(out.get(row.recordId) ?? []), row.nodeId])
  }
  return out
}

/**
 * Loose ends' inputs (F-16.29; plan P4 §1.2) over the active draft: the drafted scenes, "checked up
 * to", the threads' counted steps and live reveals, the characters' named scenes and deaths, and the
 * planned cards with no link to a drafted scene; the `notProblem` keys.
 */
export function looseEndInputs(
  db: TreeDb,
  draftId: string | null,
  frame: FindingsFrame = findingsFrame(db)
): LooseEndsInput {
  const { nodes, reading } = frame
  const drafted = new Set(
    nodes
      .filter(
        (row) => row.kind === 'document' && reading.order.has(row.id) && (row.wordCount ?? 0) > 0
      )
      .map((row) => row.id)
  )
  const claims = draftId === null ? [] : readableClaims(db, draftId, reading)
  const quotes = draftId === null ? [] : listTopicQuotes(db, draftId)
  const threads: LooseThread[] = listTopics(db, 'thread').map(({ recordId, label, origin }) => ({
    recordId,
    label,
    origin,
    steps: claims.flatMap((claim) => {
      const step = parseStep(claim.how)
      return claim.slot === 'thread' &&
        claim.recordId === recordId &&
        step !== null &&
        stepCounts(claim)
        ? [{ nodeId: claim.nodeId, step }]
        : []
    }),
    reveals: quotes
      .filter((quote) => quote.recordId === recordId && quote.state === 'live')
      .map((quote) => ({ nodeId: quote.nodeId }))
  }))
  // Deaths and living values in story order: a value that is neither ("presumed dead") is left
  // out, and so is a living value in a verified flashback (alive then, earlier in story time).
  const deaths = new Map<string, { order: number; dead: boolean }[]>()
  const scene =
    draftId === null
      ? null
      : sceneFactsReader(
          db,
          new Map(nodes.map((row) => [row.id, row])),
          readableCards(db, draftId, reading)
        )
  for (const claim of claims) {
    if (claim.slot !== 'alive' || !setsState(claim)) continue
    const dead = deathWord(claim.value)
    if (!dead && (!lifeWord(claim.value) || scene?.(claim.nodeId).flashback === true)) continue
    const order = reading.order.get(claim.nodeId) ?? -1
    deaths.set(claim.recordId, [...(deaths.get(claim.recordId) ?? []), { order, dead }])
  }
  const named = namedScenes(db, reading)
  const characters: LooseCharacter[] = listRecords(db)
    .filter((record) => record.kind === 'character')
    .map((record) => ({
      recordId: record.id,
      name: record.name,
      namedIn: named.get(record.id) ?? [],
      deadAt: (nodeId) => {
        const at = reading.order.get(nodeId) ?? -1
        const latest = (deaths.get(record.id) ?? [])
          .filter((each) => each.order <= at)
          .sort((a, b) => a.order - b.order)
          .at(-1)
        return latest?.dead === true
      }
    }))
  const board = boardOf(db)
  const linked = new Set(livePlanLinks(db).map((link) => link.planId))
  const planned: LoosePlanned[] = board.docs
    .filter((row) => {
      if (!reading.order.has(row.id) || !isPlanned(row) || linked.has(row.id)) return false
      const by = authorLink(board, row.id)
      return by === null || !isDrafted(board.byId.get(by))
    })
    .map((row) => ({ nodeId: row.id, title: searchableText(row.title).trim() || 'Untitled scene' }))
  return {
    reading,
    drafted,
    checkedUpTo: checkedUpTo(
      reading,
      draftId === null ? new Map() : sceneReadFlags(db, draftId),
      null,
      emptyScenes(nodes, reading)
    ),
    threads,
    characters,
    planned,
    dismissed: dismissedKeys(db, 'notProblem')
  }
}
