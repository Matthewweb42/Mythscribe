import {
  sheetAsOf,
  trueNow,
  type AsOfClaim,
  type ReadingOrder,
  type SheetLine
} from '@shared/memory/asOf'
import type { Claim } from '@shared/memory/claims'
import { gateSentences, readSetOf, unreadSentences } from '@shared/memory/gate'
import { locateInText } from '@shared/memory/quote'
import { slotLabel, type Slot } from '@shared/memory/slots'
import type { StoryRecordSummary } from '@shared/memory/records'
import { compareTyped, detailsAgree, type TypedNames } from '@shared/memory/typedVsText'
import type {
  ClaimInfo,
  ClaimView,
  HereChip,
  KnowsGrid,
  MentionedChip,
  SceneMemory,
  SheetLineView,
  SheetMemory
} from '@shared/memory/views'
import { KNOWER_KINDS } from '@shared/memory/knows'
import { sceneSecrets } from '@shared/memory/whoKnows'
import { searchableText } from '@shared/search'
import type { NodeRow } from '../../db/schema'
import { currentDraftId } from '../../draft/draftStore'
import { getNode, listNodes, type TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { listNameMentions, nameScanShared } from '../nameIndexer'
import { getRecord, listRecords } from '../recordStore'
import { storedSceneDetails } from '../sceneDetailStore'
import { getCard } from './cardStore'
import { draftClaims, getClaim, recordClaims, sceneClaims } from './claimStore'
import { secretTopic, sheetKnows, storedGrid, storedKnows } from './knowsViews'
import type { KnowsAsOf } from '@shared/memory/whoKnows'
import { getReading, lastReading } from './readingStore'
import { getSceneRead } from './sceneReadStore'
import { heldCard, hereChips, readingOrder, rowTexts } from './readingFrame'
import { sheetTime, timeFrame, type TimeFrame } from './timeViews'

/**
 * What the reading shows (F-16.18), built from the stores: the This scene panel's
 * `SceneMemory`, a sheet's "From the book, as of" (`SheetMemory`) and ⓘ's `ClaimInfo`. Read-only:
 * nothing here writes, so a read-only project and a project with no drafts answer too.
 */

/**
 * Claims as the as-of rules read them, each with where its quote starts in its paragraph when
 * another claim shares the paragraph (so the text's order holds inside it); the scenes' texts are
 * read only for those.
 */
function asOfClaims(db: TreeDb, claims: readonly Claim[]): AsOfClaim[] {
  const counts = new Map<string, number>()
  for (const each of claims) {
    const key = `${each.nodeId}|${each.para}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const shared = claims.filter((each) => (counts.get(`${each.nodeId}|${each.para}`) ?? 0) > 1)
  const texts = new Map<string, readonly string[]>()
  if (shared.length > 0) {
    const wanted = new Set(shared.map((each) => each.nodeId))
    for (const row of manuscriptDocuments(db)) {
      if (!wanted.has(row.id)) continue
      texts.set(row.id, rowTexts(row))
    }
  }
  return claims.map((each) => {
    const paragraph = texts.get(each.nodeId)?.[each.para]
    const pos =
      paragraph === undefined ? null : (locateInText(paragraph, each.quote)?.start ?? null)
    return { ...each, pos }
  })
}

const refOf = (reading: ReadingOrder, nodeId: string): string => reading.refs.get(nodeId) ?? ''

export function claimView(each: Claim, reading: ReadingOrder): ClaimView {
  return {
    id: each.id,
    recordId: each.recordId,
    slot: each.slot,
    label: slotLabel(each.slot),
    value: each.value,
    voice: each.voice,
    mode: each.mode,
    speakerId: each.speakerId,
    objectId: each.objectId,
    how: each.how,
    fromId: each.fromId,
    state: each.state,
    proof: each.proof,
    nodeId: each.nodeId,
    ref: refOf(reading, each.nodeId),
    para: each.para,
    quote: each.quote
  }
}

/** The names `compareTyped` reads, from the roster. */
export function typedNames(db: TreeDb): TypedNames {
  const records = new Map(listRecords(db).map((each) => [each.id, each]))
  return {
    nameOf: (id) => records.get(id)?.name ?? null,
    aliasesOf: (id) => records.get(id)?.aliases.map((alias) => alias.text) ?? []
  }
}

/**
 * What the book states about records as of a scene, as the Story notes block carries it (F-16.20,
 * design §2.6): per record, its fixed and lasting values that are live (narration in `now` mode,
 * the sentence unchanged since it was read), then the transient values this scene itself states
 * ("Last seen at: the quay"), each `Label: value`. Never dialogue, thought, rumour, memory or a
 * dream as fact, never a stale line, never an absence, never one side of a fixed slot the book
 * contradicts itself on: a record with nothing stated has no entry.
 */
export function hereValues(
  db: TreeDb,
  reading: ReadingOrder,
  nodeId: string,
  recordIds: readonly string[]
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const draftId = currentDraftId(db)
  if (draftId === null || recordIds.length === 0 || !reading.at.has(nodeId)) return out
  const names = new Map(listRecords(db).map((each) => [each.id, each.name]))
  const labelled = (slot: Slot, value: string, objectId: string | null): string => {
    const object = objectId === null ? undefined : names.get(objectId)
    return `${slotLabel(slot)}: ${value}${object === undefined ? '' : ` (${object})`}`
  }
  for (const recordId of recordIds) {
    const claims = asOfClaims(db, recordClaims(db, recordId, draftId))
    if (claims.length === 0) continue
    const sheet = sheetAsOf(claims, reading, nodeId)
    // A fixed slot the book gives two different values for is left out: until the author
    // settles it, a prompt is steered toward neither side.
    const fixed = sheet.fixed
      .filter(
        (line) =>
          !line.value.stale &&
          !line.also.some((other) => !other.stale && !detailsAgree(other.value, line.value.value))
      )
      .map((line) => labelled(line.slot, line.value.value, line.objectId))
    const now = trueNow(claims, reading, nodeId).filter((line) => !line.stale)
    const lasting = now
      .filter((line) => line.kind === 'since')
      .map((line) => labelled(line.slot, line.value, line.objectId))
    const here = now
      .filter((line) => line.kind === 'lastStated' && line.nodeId === nodeId)
      .map((line) => labelled(line.slot, line.value, line.objectId))
    const values = [...fixed, ...lasting, ...here]
    if (values.length > 0) out.set(recordId, values)
  }
  return out
}

/** Finished sentences of the scene the active draft has not read yet. */
function unreadCount(db: TreeDb, nodeId: string, draftId: string | null): number {
  const row = manuscriptDocuments(db).find((document) => document.id === nodeId)
  if (row === undefined) return 0
  const texts = rowTexts(row)
  const names = nameScanShared(db).index
  const current = gateSentences(texts, { caretPara: null, names })
  const read = draftId === null ? null : getSceneRead(db, nodeId, draftId)
  if (read === null) return current.length
  return unreadSentences(current, readSetOf(read.entries, names)).length
}

/**
 * The This scene panel's memory of one scene (P2a-D21): Here (the POV, with the text's POV over
 * a typed one that differs; characters on the page with a verified quote; "+ also here"),
 * Mentioned (named for certain, not Here), True now for those records as of this scene, the
 * typed details against the card (decision 4), the last reading, and what is unread. Only what of
 * the card still stands on the text counts (`heldCard`): a POV, place or character whose quote's
 * sentence was edited since is shown dimmed in the card and never overrides the typed details.
 */
export function sceneMemory(db: TreeDb, nodeId: string): SceneMemory {
  const draftId = currentDraftId(db)
  const nodes = listNodes(db)
  const reading = readingOrder(db, nodes)
  const details = storedSceneDetails(db, nodeId)
  const card = draftId === null ? null : getCard(db, nodeId, draftId)
  const held = card === null ? null : heldCard(db, card, reading.order.has(nodeId))
  const records = new Map(listRecords(db).map((each) => [each.id, each]))

  const here = hereChips(details, held, records)

  const counts = new Map<string, number>()
  for (const mention of listNameMentions(db, nodeId)) {
    if (mention.ambiguous || here.some((each) => each.recordId === mention.recordId)) continue
    counts.set(mention.recordId, (counts.get(mention.recordId) ?? 0) + 1)
  }
  const mentioned: MentionedChip[] = [...counts]
    .filter(([recordId]) => records.has(recordId))
    .map(([recordId, count]) => ({ recordId, count }))

  const shown = new Set([...here.map((each) => each.recordId), ...counts.keys()])
  const claims = draftId === null ? [] : draftClaims(db, draftId)
  const lines = trueNow(
    asOfClaims(
      db,
      claims.filter((each) => each.recordId !== null && shown.has(each.recordId))
    ),
    reading,
    nodeId
  ).map((line) => ({ ...line, label: slotLabel(line.slot) }))

  const last = draftId === null ? null : lastReading(db, nodeId, draftId)
  const knowers = knowersOf(here, records)
  return {
    nodeId,
    ref: reading.refs.get(nodeId) ?? null,
    card:
      card === null || held === null
        ? null
        : {
            line: card.line,
            gist: card.gist,
            fields: held.shown,
            stale: held.stale,
            mood: card.mood,
            theme: card.theme,
            readingId: card.readingId,
            created: card.created
          },
    here,
    mentioned,
    trueNow: lines,
    typed: compareTyped(details, held?.fields ?? null, typedNames(db)),
    lastRead:
      last === null
        ? null
        : { readingId: last.id, at: last.created, model: last.model, costUsd: last.costUsd },
    unread: unreadCount(db, nodeId, draftId),
    paused: null,
    claims:
      draftId === null
        ? []
        : sceneClaims(db, nodeId, draftId).map((each) => claimView(each, reading)),
    // F-16.22: the secrets the scene touches and its tension lines, as of the scene. Only the
    // characters and groups Here can know (a place or a thread *+ also here* is no learner).
    secrets: sceneSecrets(
      storedKnows(db, nodeId, reading, nodes),
      nodeId,
      knowers.map((chip) => chip.recordId),
      povOf(knowers)
    )
  }
}

/** The Here chips whose record can know a secret (`KNOWER_KINDS`), in order. */
const knowersOf = (
  here: readonly HereChip[],
  records: ReadonlyMap<string, Pick<StoryRecordSummary, 'kind'>>
): HereChip[] =>
  here.filter((chip) => {
    const kind = records.get(chip.recordId)?.kind
    return kind !== undefined && KNOWER_KINDS.includes(kind)
  })

/** The POV among a scene's Here chips, or null. */
const povOf = (here: readonly HereChip[]): string | null =>
  here.find((chip) => chip.why === 'pov')?.recordId ?? null

/**
 * The Book's who-knows-what grid (`memory:knows`, F-16.22) as of scene `asOf` (null: the end of
 * the book), with that scene's POV as a column.
 */
export function knowsGridMemory(db: TreeDb, asOf: string | null): KnowsGrid {
  const nodes = listNodes(db)
  const reading = readingOrder(db, nodes)
  let pov: string | null = null
  if (asOf !== null && reading.at.has(asOf)) {
    const draftId = currentDraftId(db)
    const card = draftId === null ? null : getCard(db, asOf, draftId)
    const held = card === null ? null : heldCard(db, card, reading.order.has(asOf))
    const records = new Map(listRecords(db).map((each) => [each.id, each]))
    pov = povOf(hereChips(storedSceneDetails(db, asOf), held, records))
  }
  return storedGrid(storedKnows(db, asOf, reading, nodes), db, pov)
}

const sheetLine = (line: SheetLine): SheetLineView => ({ ...line, label: slotLabel(line.slot) })

/**
 * What several sheets read as of one scene share (F-16.24: Step 0 digests up to three records of
 * a question at once): the book's order, who knows what and the threads and years as of `asOf`.
 */
export interface SheetFrame {
  asOf: string | null
  nodes: NodeRow[]
  reading: ReadingOrder
  knows: KnowsAsOf
  time: TimeFrame
}

/** The shared reads of `sheetMemory` as of scene `asOf`, for several sheets read together. */
export function sheetFrame(
  db: TreeDb,
  asOf: string | null,
  nodes: NodeRow[] = listNodes(db),
  reading: ReadingOrder = readingOrder(db, nodes)
): SheetFrame {
  return {
    asOf,
    nodes,
    reading,
    knows: storedKnows(db, asOf, reading, nodes),
    time: timeFrame(db, asOf, reading, nodes)
  }
}

/**
 * One record's sheet "From the book, as of" scene `asOf` (null: the end of the book). `frame`,
 * read as of the same scene (`sheetFrame`), is shared by several sheets read together.
 */
export function sheetMemory(
  db: TreeDb,
  recordId: string,
  asOf: string | null,
  frame?: SheetFrame
): SheetMemory {
  const draftId = currentDraftId(db)
  const shared = frame?.asOf === asOf ? frame : undefined
  const nodes = shared?.nodes ?? listNodes(db)
  const reading = shared?.reading ?? readingOrder(db, nodes)
  // F-16.22: a knower's Knows, a secret's own view; F-16.23: a named record's Threads, a
  // character's Age, a thread's own view; all as of the same scene.
  const kind = getRecord(db, recordId)?.kind ?? null
  const knower = kind !== null && KNOWER_KINDS.includes(kind)
  const knows =
    knower || kind === 'secret' ? (shared?.knows ?? storedKnows(db, asOf, reading, nodes)) : null
  const time = sheetTime(db, recordId, kind, asOf, reading, nodes, shared?.time)
  const sheet = sheetAsOf(
    draftId === null ? [] : asOfClaims(db, recordClaims(db, recordId, draftId)),
    reading,
    asOf
  )
  return {
    recordId,
    asOf,
    // A node that is not a manuscript scene has no place in the book: no reference.
    asOfRef: asOf === null || !reading.at.has(asOf) ? null : (reading.refs.get(asOf) ?? null),
    fixed: sheet.fixed.map(sheetLine),
    lasting: sheet.lasting.map(sheetLine),
    transient: sheet.transient.map(sheetLine),
    accumulating: sheet.accumulating.map(sheetLine),
    others: sheet.others.map((line) => ({ ...line, label: slotLabel(line.slot) })),
    later: sheet.later,
    knows: knows !== null && knower ? sheetKnows(knows, recordId) : null,
    threads: time.threads,
    age: time.age,
    topic:
      knows !== null && kind === 'secret'
        ? secretTopic(knows, recordId)
        : time.thread === null
          ? null
          : { kind: 'thread', ...time.thread }
  }
}

/** ⓘ on an AI line: the claim, its scene, its spot check and its reading; null when it is gone. */
export function claimInfo(db: TreeDb, claimId: string): ClaimInfo | null {
  const each = getClaim(db, claimId)
  if (each === null) return null
  const reading = each.readingId === null ? null : getReading(db, each.readingId)
  const scene = getNode(db, each.nodeId)
  return {
    claim: claimView(each, readingOrder(db)),
    sceneTitle: scene === undefined ? '' : searchableText(scene.title),
    spot:
      each.spot === null || each.spotTier === null || each.spotAt === null
        ? null
        : { verdict: each.spot, tier: each.spotTier, at: each.spotAt },
    reading:
      reading === null
        ? null
        : {
            id: reading.id,
            purpose: reading.purpose,
            model: reading.model,
            promptVersion: reading.promptVersion,
            created: reading.created,
            costUsd: reading.costUsd
          }
  }
}
