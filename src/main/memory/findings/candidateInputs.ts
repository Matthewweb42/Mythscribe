import { and, eq } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import type { ReadingOrder } from '@shared/memory/asOf'
import {
  deathWord,
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
  created: claim.created
})

/** The canon note paragraphs the passage index holds: Pinned pages and canon Research pages. */
export function canonNotes(db: TreeDb): NoteParagraph[] {
  const rows = db.all<{ source: string; ownerId: string; para: number; text: string }>(
    sql`SELECT source, owner_id AS ownerId, para, text FROM memory_passage_fts
        WHERE canon = 'canon' AND source IN ('pinned', 'note', 'research')
        ORDER BY rowid`
  )
  return rows.map((row) =>
    row.source === 'pinned'
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
function candidateRecords(db: TreeDb): Map<string, CandidateRecord> {
  return new Map(
    listRecords(db).map((record) => [
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

/** The rules' inputs over the active draft `draftId`. */
export function candidateInputs(
  db: TreeDb,
  draftId: string,
  frame: FindingsFrame = findingsFrame(db)
): CandidateInputs {
  const { nodes, reading } = frame
  const rows = new Map(nodes.map((row) => [row.id, row]))
  const cards = new Map(
    draftCards(db, draftId)
      .filter((card) => reading.order.has(card.nodeId))
      .map((card) => [card.nodeId, card])
  )
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
  let notRight: ReadonlySet<string> | null = null
  const facts = new Map<string, SceneFacts>()
  const scene = (nodeId: string): SceneFacts => {
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
  return {
    reading,
    claims: readableClaims(db, draftId, reading).map(toCandidateClaim),
    onPage,
    typed,
    scene,
    knewBefore: listKnewBefore(db),
    records: candidateRecords(db),
    notes: canonNotes(db),
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
  const deaths = new Map<string, { order: number; dead: boolean }[]>()
  for (const claim of claims) {
    if (claim.slot !== 'alive' || !setsState(claim)) continue
    const order = reading.order.get(claim.nodeId) ?? -1
    deaths.set(claim.recordId, [
      ...(deaths.get(claim.recordId) ?? []),
      { order, dead: deathWord(claim.value) }
    ])
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
