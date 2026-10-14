import { eq, inArray } from 'drizzle-orm'
import type { Claim } from '@shared/memory/claims'
import { cardEntryIsRecord, dismissedKey, type Dismissed } from '@shared/memory/dismissed'
import { gateText } from '@shared/memory/gate'
import { HOW_LABEL, KNOWER_KINDS, keepsFrom, parseHow } from '@shared/memory/knows'
import { locateQuote } from '@shared/memory/quote'
import { parseVerifyAnswer } from '@shared/memory/readerAnswer'
import { notRightLine } from '@shared/memory/reconcile'
import { slotLabel } from '@shared/memory/slots'
import { SPOT_STRONG_AROUND } from '@shared/memory/spot'
import type { CardNotRight } from '@shared/memory/views'
import { VERIFY_V3_PROMPT_VERSION, buildVerifyV3Prompt } from '../../ai/prompts/verify.v3'
import { runAiRequest, sha256, type AiRequestDeps } from '../../ai/request'
import {
  claim as claimTable,
  draft,
  node,
  reading,
  record,
  topicQuote,
  type ClaimRow
} from '../../db/schema'
import { currentDraftId } from '../../draft/draftStore'
import { AppError } from '../../ipc/errors'
import type { TreeDb } from '../../tree/treeStore'
import { dismiss, dismissedIds } from '../dismissedStore'
import { getRecord, listRecords } from '../recordStore'
import { getCard } from './cardStore'
import { claimRows, deleteClaims, getClaim } from './claimStore'
import { agrees, hereCheck, notAboutCheck } from './pipeline'
import { loadReadingScene, readBook, type Book, type ReadingScene } from './readerContext'
import {
  getNotAboutMoves,
  getNotRightStash,
  setNotAboutMoves,
  setNotRightStash,
  type NotAboutMoves,
  type NotRightStash
} from './readerRows'
import { knowsThinker } from './recordEvidence'
import { readerRoster } from './rosterCache'
import { topicItemLines } from './topicContext'
import { heldCard, hereChips, readingOrder } from './readingFrame'

/**
 * *Not right* on an AI line (F-16.18; design §2.7 "Dismissed", plan P2a §4). Two choices:
 *
 * - **Wrong value**: a `notRight` Dismissed row keyed by the record, slot, value and the quote's
 *   own sentences (their gate texts, names folded: `statingKey`), so a new sentence stating it is
 *   new evidence, and the line goes. A stale line whose quote is no longer in its scene is keyed by
 *   its stored anchor instead (nothing new can match it, but the row is there to undo). The claim
 *   row is kept beside the tombstone (the settings row `memoryNotRight`), so *Undo* in Dismissed
 *   always brings the line back as it was; the anchors job then re-checks it against the text.
 * - **Not about Mara** (the author picks the record): one `verify.v3` call, the fast tier, with
 *   the reading's subject safeguards (`notAboutCheck`: every record named in reach is a candidate,
 *   the picked one marked "not named here" when nothing names it), the quote's sentences ±3.
 *   Supported for the picked record with the line's voice and mode: the line moves to that record
 *   (proved by the checker now), the first record gets a `notRight` row, and the move is kept
 *   (`memoryNotAbout`) so a later reading, a rebuild too, stores the line for the picked record.
 *   Refused by the checker: dismissed as a wrong value. No verdict, or no check possible (the
 *   sentence changed since it was read): `unchecked`, nothing changes. No `reading` row is
 *   written: the request is in the ledger, and the health gate stays about readings (decided by
 *   Claude, unconfirmed).
 *
 * P2b: a knows line's tombstone keys by its secret and how (`notRightLine`) and reads "Orrin: knows
 * the sold map (overheard)"; *Not about* re-checks it as a knows item for the picked learner (the
 * checker must also give its how): only a character or a group may be picked (VALIDATION), a
 * character not Here is checked on the page in the same request (P2b-D8; not shown there: the
 * move is refused as for an unsupported line), and the moved line takes the source the checker
 * named among the candidates for the new learner (only for told, overheard, read; never the
 * learner), else none. A thread step is about its thread: *Not about* does not apply
 * (`unchecked`).
 */

/** The gate texts of a claim's quote sentences (what a `notRight` dismissal keys on), or null. */
function statingOf(scene: ReadingScene, claim: Claim): string[] | null {
  const only = scene.texts.map((text, i) => (i === claim.para ? text : ''))
  const location = locateQuote(only, claim.para, claim.quote)
  if (!location.ok) return null
  return location.sentences.map((i) =>
    gateText(scene.spans[claim.para]?.[i]?.text ?? '', scene.shared.index)
  )
}

/**
 * A claim's `notRight` tombstone, keyed by its record (or `recordId`) and its quote's sentences,
 * or, when its quote is no longer in its scene (a stale line), by its stored anchor.
 */
function writeNotRight(
  db: TreeDb,
  scene: ReadingScene | null,
  claim: Claim,
  recordId: string,
  now: Date
): Dismissed {
  const stating = scene === null ? null : statingOf(scene, claim)
  const name = getRecord(db, recordId)?.name ?? ''
  // P2b-D6: a knows line keys by its secret and how (`notRightLine`), so a merge re-keys it.
  const about = { recordId, ...notRightLine({ ...claim, recordId }) }
  const topic = (id: string | null): string => (id === null ? '' : (getRecord(db, id)?.name ?? ''))
  const how = parseHow(claim.how)
  const said =
    claim.slot === 'knows'
      ? `knows ${topic(claim.objectId)} (${how === null ? (claim.how ?? claim.value) : HOW_LABEL[how]})`
      : claim.slot === 'thread'
        ? `${claim.how ?? ''} ${claim.value}`.trim()
        : `${slotLabel(claim.slot)} ${claim.value}`
  return dismiss(
    db,
    {
      kind: 'notRight',
      key: dismissedKey(
        stating === null
          ? { kind: 'notRight', ...about, anchor: claim.anchor }
          : { kind: 'notRight', ...about, stating }
      ),
      recordId,
      nodeId: claim.nodeId,
      label: `${name}: ${said}`,
      quote: claim.quote
    },
    now
  )
}

/** The stash without the rows of tombstones that are gone (undone, or gone with their record). */
function prunedStash(db: TreeDb): NotRightStash {
  const stash = getNotRightStash(db)
  const live = dismissedIds(db, 'notRight')
  return Object.fromEntries(Object.entries(stash).filter(([id]) => live.has(id)))
}

/**
 * *Not right › Wrong value* for these claims (also the rebuild summary's bulk *Not right*): a
 * `notRight` Dismissed row for each claim with a record (`writeNotRight`), its row kept for
 * *Undo*, and those claims go. A claim still waiting on its subject has no record to key a row
 * by: it is left alone. Answers the rows written (one per tombstone).
 */
export function dismissClaimsNotRight(
  db: TreeDb,
  claims: readonly Claim[],
  now: Date
): Dismissed[] {
  const scenes = new Map<string, ReadingScene | null>()
  let book: Book | null = null
  const rows = new Map(
    claimRows(
      db,
      claims.map((each) => each.id)
    ).map((row) => [row.id, row])
  )
  const stash = prunedStash(db)
  const written = new Map<string, Dismissed>()
  const gone: string[] = []
  for (const claim of claims) {
    if (claim.recordId === null) continue
    if (!scenes.has(claim.nodeId)) {
      book ??= readBook(db)
      scenes.set(claim.nodeId, loadReadingScene(db, claim.nodeId, book))
    }
    const row = writeNotRight(db, scenes.get(claim.nodeId) ?? null, claim, claim.recordId, now)
    gone.push(claim.id)
    written.set(row.id, row)
    const stored = rows.get(claim.id)
    if (stored !== undefined) stash[row.id] = [...(stash[row.id] ?? []), stored]
  }
  deleteClaims(db, gone)
  setNotRightStash(db, stash)
  return [...written.values()]
}

/** Whether a row with this id exists in one of the tables a claim points at. */
function exists(
  db: TreeDb,
  table: typeof node | typeof draft | typeof reading | typeof record | typeof topicQuote,
  id: string
): boolean {
  return db.select({ id: table.id }).from(table).where(eq(table.id, id)).get() !== undefined
}

/**
 * *Undo* on a `notRight` row (after the tombstone went): its claims come back as they were, where
 * their scene, draft and record still exist (a reading, object, speaker or source gone since is
 * cleared); a claim already there again is left alone. Answers the scenes and records touched, so
 * the anchors job re-checks them against the text as it is now.
 */
export function restoreNotRight(
  db: TreeDb,
  dismissedId: string
): { nodeIds: string[]; recordIds: string[] } {
  const stash = getNotRightStash(db)
  const rows = stash[dismissedId] ?? []
  const rest = Object.fromEntries(Object.entries(stash).filter(([id]) => id !== dismissedId))
  setNotRightStash(db, rest)
  // A *Not about* undone: the first record may be handed the line again by a later reading.
  const moves = getNotAboutMoves(db)
  if (moves[dismissedId] !== undefined) {
    setNotAboutMoves(
      db,
      Object.fromEntries(Object.entries(moves).filter(([id]) => id !== dismissedId))
    )
  }
  if (rows.length === 0) return { nodeIds: [], recordIds: [] }
  const present = new Set(
    db
      .select({ id: claimTable.id })
      .from(claimTable)
      .where(
        inArray(
          claimTable.id,
          rows.map((row) => row.id)
        )
      )
      .all()
      .map((row) => row.id)
  )
  const optional = (id: string | null): string | null =>
    id !== null && exists(db, record, id) ? id : null
  const nodeIds = new Set<string>()
  const recordIds = new Set<string>()
  for (const row of rows) {
    if (present.has(row.id)) continue
    if (!exists(db, node, row.nodeId) || !exists(db, draft, row.draftId)) continue
    if (row.recordId !== null && !exists(db, record, row.recordId)) continue
    // A knows thought whose thinker is gone would come back as the knower's own (P2b-D7).
    const thinker = knowsThinker(row)
    if (thinker !== null && !exists(db, record, thinker)) continue
    const restored: ClaimRow = {
      ...row,
      readingId:
        row.readingId !== null && exists(db, reading, row.readingId) ? row.readingId : null,
      objectId: optional(row.objectId),
      speakerId: optional(row.speakerId),
      fromId: optional(row.fromId),
      topicQuoteId:
        row.topicQuoteId !== null && exists(db, topicQuote, row.topicQuoteId)
          ? row.topicQuoteId
          : null
    }
    db.insert(claimTable).values(restored).run()
    nodeIds.add(row.nodeId)
    if (row.recordId !== null) recordIds.add(row.recordId)
  }
  return { nodeIds: [...nodeIds], recordIds: [...recordIds] }
}

export interface NotAboutInput {
  claimId: string
  /** The record the author says the line is about. */
  recordId: string
  /** The request's id for `ai:cancel` (`runAiRequest` registers it). */
  requestId: string
  /** The request's reported cost as it returns. */
  onSpend?: (usd: number) => void
}

export interface NotRightOutcome {
  outcome: 'moved' | 'dismissed' | 'unchecked' | 'gone'
  dismissed: Dismissed | null
  nodeIds: string[]
  recordIds: string[]
}

const goneOutcome = (): NotRightOutcome => ({
  outcome: 'gone',
  dismissed: null,
  nodeIds: [],
  recordIds: []
})

/** *Not right › Wrong value* for one line. */
export function wrongValue(db: TreeDb, claimId: string, now: Date): NotRightOutcome {
  const claim = getClaim(db, claimId)
  if (claim === null) return goneOutcome()
  if (claim.recordId === null) {
    throw new AppError('VALIDATION', 'This line is still waiting on who it is about', { claimId })
  }
  const [row] = db.transaction((tx) => dismissClaimsNotRight(tx, [claim], now))
  return {
    outcome: 'dismissed',
    dismissed: row ?? null,
    nodeIds: [claim.nodeId],
    recordIds: [claim.recordId]
  }
}

/**
 * *Not right › Not about Mara*: the line re-checked for the record the author picks (one
 * `verify.v3` call). Supported: it moves there; refused: it is dismissed as a wrong value. A line
 * whose quote is no longer in its scene cannot be checked, and a reply with no verdict for it
 * says nothing: both answer `unchecked`, and the line stays as it is.
 */
export async function notAbout(
  db: TreeDb,
  deps: { ai: AiRequestDeps },
  input: NotAboutInput
): Promise<NotRightOutcome> {
  const claim = getClaim(db, input.claimId)
  if (claim === null) return goneOutcome()
  const picked = getRecord(db, input.recordId)
  if (picked === null) {
    throw new AppError('NOT_FOUND', 'That record no longer exists', { recordId: input.recordId })
  }
  // P2b-D6: only a character or a group can know a secret.
  if (claim.slot === 'knows' && !KNOWER_KINDS.includes(picked.kind)) {
    throw new AppError('VALIDATION', 'Only a character or a group can know a secret', {
      recordId: input.recordId
    })
  }
  const was = claim.recordId
  if (was === input.recordId) {
    return { outcome: 'moved', dismissed: null, nodeIds: [claim.nodeId], recordIds: [was] }
  }
  const now = (): Date => deps.ai.now()
  const unchecked: NotRightOutcome = {
    outcome: 'unchecked',
    dismissed: null,
    nodeIds: [],
    recordIds: []
  }
  const scene = loadReadingScene(db, claim.nodeId, readBook(db))
  const roster = readerRoster(db)
  const check =
    scene === null
      ? null
      : notAboutCheck(
          scene,
          claim,
          input.recordId,
          roster,
          SPOT_STRONG_AROUND,
          topicItemLines(db, roster, claim.draftId)
        )
  if (check === null || scene === null) return unchecked
  // P2b-D8: a character who learns a secret is Here (the typed details, the held card) or shown
  // on the page by the same request's on-page check.
  const card = getCard(db, claim.nodeId, claim.draftId)
  const here = new Set(
    hereChips(
      scene.details,
      card === null ? null : heldCard(db, card, true),
      new Map(listRecords(db).map((each) => [each.id, each]))
    ).map((chip) => chip.recordId)
  )
  const onPage =
    claim.slot === 'knows' && picked.kind === 'character' && !here.has(input.recordId)
      ? hereCheck(scene, claim, input.recordId, roster)
      : null
  const prompt = buildVerifyV3Prompt({
    items: onPage === null ? [check.item] : [check.item, onPage]
  })
  const result = await runAiRequest(deps.ai, {
    feature: 'verify',
    tier: 'fast',
    messages: prompt.messages,
    maxTokens: prompt.maxTokens,
    json: true,
    contextHash: sha256(JSON.stringify(prompt.messages)),
    promptVersion: VERIFY_V3_PROMPT_VERSION,
    requestId: input.requestId,
    cacheIf: (text) => parseVerifyAnswer(text).size > 0
  })
  input.onSpend?.(result.costUsd)
  const answers = parseVerifyAnswer(result.text)
  const verdict = answers.get(1)
  const shown = onPage === null ? undefined : answers.get(2)
  if (verdict === undefined || (onPage !== null && shown === undefined)) return unchecked
  const supported =
    agrees(verdict, {
      expect: check.expect,
      voice: claim.voice,
      mode: claim.mode,
      how: check.how
    }) &&
    (onPage === null || shown?.ok === true)
  // A knows line keeps a source only for told, overheard or read, one of the candidates the
  // checker named, and never the learner (P2b-D6).
  const how = parseHow(claim.how)
  const fr = verdict.fr?.trim() ?? null
  const named = fr === null ? null : (check.from.find((id) => roster.shortOf(id) === fr) ?? null)
  const fromId =
    claim.slot === 'knows' && how !== null && keepsFrom(how) && named !== input.recordId
      ? named
      : null
  // The text may have changed while the check was out: the line is read again from the store.
  const current = getClaim(db, claim.id)
  if (current === null) return goneOutcome()
  const recordIds = [...new Set([...(was === null ? [] : [was]), input.recordId])]
  if (!supported) {
    const outcome = wrongValue(db, current.id, now())
    return { ...outcome, recordIds }
  }
  const dismissed = db.transaction((tx) => {
    const row = was === null ? null : writeNotRight(tx, scene, current, was, now())
    if (row !== null) setNotAboutMoves(tx, { ...prunedMoves(tx), [row.id]: input.recordId })
    tx.update(claimTable)
      .set({
        recordId: input.recordId,
        pending: null,
        ...(current.slot === 'knows' ? { fromId } : {}),
        // A line that waited on its subject has it now.
        state: current.state === 'waiting' ? 'live' : current.state,
        proof: 'verified',
        spot: null,
        spotTier: null,
        spotAt: null,
        proved: now().toISOString()
      })
      .where(eq(claimTable.id, current.id))
      .run()
    return row
  })
  return { outcome: 'moved', dismissed, nodeIds: [current.nodeId], recordIds }
}

/** The moves without those whose Dismissed row is gone (undone, or gone with its record). */
function prunedMoves(db: TreeDb): NotAboutMoves {
  const live = dismissedIds(db, 'notRight')
  return Object.fromEntries(Object.entries(getNotAboutMoves(db)).filter(([id]) => live.has(id)))
}

/** How a card value reads in its Dismissed row ("POV Tomas", "place “the quay”"). */
function cardPhrase(field: CardNotRight['field'], shown: string): string {
  switch (field) {
    case 'pov':
      return `POV ${shown}`
    case 'present':
      return `${shown} on the page`
    case 'where':
      return `place “${shown}”`
    case 'when':
      return `time “${shown}”`
    case 'year':
      return `story year ${shown}`
    case 'flashback':
      return `flashback ${shown}`
    case 'elapsed':
      return `time passed “${shown}”`
  }
}

/**
 * *Not right* on a value the scene's card gives (F-16.18): its POV, place, time or year, or a
 * character on the page. A `notRight` Dismissed row keyed by the scene, the field and the value
 * (for the POV and a character, the record's id, so the row goes with the record and a merge
 * re-keys it): Here, the card and decision 4's conflicts leave it out (`heldCard`), so the typed
 * detail stands; a later card stating the same value for this scene is left out too, until *Undo*
 * in Dismissed. NOT_FOUND when the active draft's card no longer gives that value.
 */
export function cardNotRight(db: TreeDb, input: CardNotRight, now: Date): Dismissed {
  const draftId = currentDraftId(db)
  const card = draftId === null ? null : getCard(db, input.nodeId, draftId)
  const field = input.field
  const entry =
    card === null
      ? undefined
      : field === 'present'
        ? card.present.find((each) => each.recordId === input.value)
        : [card.fields[field]].find((each) => each !== null && each.value === input.value)
  if (entry === undefined || entry === null) {
    throw new AppError('NOT_FOUND', 'The scene’s card no longer says that', {
      nodeId: input.nodeId
    })
  }
  const isRecord = cardEntryIsRecord(input.field)
  const recordId = isRecord && getRecord(db, input.value) !== null ? input.value : null
  const shown = isRecord ? (getRecord(db, input.value)?.name ?? input.value) : input.value
  const ref = readingOrder(db).refs.get(input.nodeId) ?? ''
  return dismiss(
    db,
    {
      kind: 'notRight',
      key: dismissedKey({ kind: 'notRight', card: input }),
      recordId,
      nodeId: input.nodeId,
      label: `${ref === '' ? '' : `${ref}: `}${cardPhrase(input.field, shown)}, from the card`,
      quote: entry.quote
    },
    now
  )
}
