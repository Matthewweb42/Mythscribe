import { passageParagraphs } from '@shared/mentions'
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
import { sceneRefs } from '@shared/memory/sceneRef'
import { slotLabel } from '@shared/memory/slots'
import { compareTyped, type TypedNames } from '@shared/memory/typedVsText'
import type {
  ClaimInfo,
  ClaimView,
  HereChip,
  MentionedChip,
  SceneMemory,
  SheetLineView,
  SheetMemory
} from '@shared/memory/views'
import { searchableText } from '@shared/search'
import { EMPTY_DOC } from '@shared/tiptap'
import type { NodeRow } from '../../db/schema'
import { currentDraftId } from '../../draft/draftStore'
import { nodesInTreeOrder } from '../../search/searchStore'
import { getNode, listNodes, type TreeDb } from '../../tree/treeStore'
import { documentJson, manuscriptDocuments } from '../../voice/profile'
import { listNameMentions, nameScanShared } from '../nameIndexer'
import { sceneStatuses } from '../passageIndexer'
import { listRecords } from '../recordStore'
import { storedSceneDetails } from '../sceneDetailStore'
import { getCard } from './cardStore'
import { draftClaims, getClaim, recordClaims, sceneClaims } from './claimStore'
import { getReading, lastReading } from './readingStore'
import { getSceneRead } from './sceneReadStore'

/**
 * What the reading shows (F-16.18), built from the stores: the This scene panel's
 * `SceneMemory`, a sheet's "From the book, as of" (`SheetMemory`) and ⓘ's `ClaimInfo`. Read-only:
 * nothing here writes, so a read-only project and a project with no drafts answer too.
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
  const texts = new Map<string, string[]>()
  if (shared.length > 0) {
    const wanted = new Set(shared.map((each) => each.nodeId))
    for (const row of manuscriptDocuments(db)) {
      if (!wanted.has(row.id)) continue
      texts.set(
        row.id,
        passageParagraphs(documentJson(row) ?? EMPTY_DOC).map((paragraph) => paragraph.text)
      )
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
    state: each.state,
    proof: each.proof,
    nodeId: each.nodeId,
    ref: refOf(reading, each.nodeId),
    para: each.para,
    quote: each.quote
  }
}

/** The names `compareTyped` reads, from the roster. */
function typedNames(db: TreeDb): TypedNames {
  const records = new Map(listRecords(db).map((each) => [each.id, each]))
  return {
    nameOf: (id) => records.get(id)?.name ?? null,
    aliasesOf: (id) => records.get(id)?.aliases.map((alias) => alias.text) ?? []
  }
}

/** Finished sentences of the scene the active draft has not read yet. */
function unreadCount(db: TreeDb, nodeId: string, draftId: string | null): number {
  const row = manuscriptDocuments(db).find((document) => document.id === nodeId)
  if (row === undefined) return 0
  const texts = passageParagraphs(documentJson(row) ?? EMPTY_DOC).map((paragraph) => paragraph.text)
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
 * typed details against the card (decision 4), the last reading, and what is unread.
 */
export function sceneMemory(db: TreeDb, nodeId: string): SceneMemory {
  const draftId = currentDraftId(db)
  const reading = readingOrder(db)
  const details = storedSceneDetails(db, nodeId)
  const card = draftId === null ? null : getCard(db, nodeId, draftId)
  const records = new Map(listRecords(db).map((each) => [each.id, each]))

  const here: HereChip[] = []
  const add = (chip: HereChip): void => {
    if (records.has(chip.recordId) && !here.some((each) => each.recordId === chip.recordId)) {
      here.push(chip)
    }
  }
  // A verified POV whose record is gone (deleted since) is no POV: the typed one stands.
  const cardPov = card?.fields.pov ?? null
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
  for (const present of card?.present ?? []) {
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
  return {
    nodeId,
    ref: reading.refs.get(nodeId) ?? null,
    card:
      card === null
        ? null
        : {
            line: card.line,
            gist: card.gist,
            fields: card.fields,
            mood: card.mood,
            theme: card.theme,
            readingId: card.readingId,
            created: card.created
          },
    here,
    mentioned,
    trueNow: lines,
    typed: compareTyped(details, card?.fields ?? null, typedNames(db)),
    lastRead:
      last === null
        ? null
        : { readingId: last.id, at: last.created, model: last.model, costUsd: last.costUsd },
    unread: unreadCount(db, nodeId, draftId),
    paused: null,
    claims:
      draftId === null
        ? []
        : sceneClaims(db, nodeId, draftId).map((each) => claimView(each, reading))
  }
}

const sheetLine = (line: SheetLine): SheetLineView => ({ ...line, label: slotLabel(line.slot) })

/** One record's sheet "From the book, as of" scene `asOf` (null: the end of the book). */
export function sheetMemory(db: TreeDb, recordId: string, asOf: string | null): SheetMemory {
  const draftId = currentDraftId(db)
  const reading = readingOrder(db)
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
    later: sheet.later
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
