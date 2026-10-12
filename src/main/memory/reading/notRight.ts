import { eq, inArray } from 'drizzle-orm'
import type { Claim } from '@shared/memory/claims'
import { dismissedKey, type Dismissed } from '@shared/memory/dismissed'
import { gateText } from '@shared/memory/gate'
import { locateQuote } from '@shared/memory/quote'
import { parseVerifyAnswer } from '@shared/memory/readerAnswer'
import { slotLabel } from '@shared/memory/slots'
import { SPOT_STRONG_AROUND } from '@shared/memory/spot'
import { VERIFY_PROMPT_VERSION, buildVerifyPrompt } from '../../ai/prompts/verify.v1'
import { runAiRequest, sha256, type AiRequestDeps } from '../../ai/request'
import { claim as claimTable, draft, node, reading, record, type ClaimRow } from '../../db/schema'
import { AppError } from '../../ipc/errors'
import type { TreeDb } from '../../tree/treeStore'
import { dismiss, dismissedIds } from '../dismissedStore'
import { getRecord } from '../recordStore'
import { claimRows, deleteClaims, getClaim } from './claimStore'
import { agrees, claimCheck } from './pipeline'
import { loadReadingScene, readBook, type Book, type ReadingScene } from './readerContext'
import { getNotRightStash, setNotRightStash, type NotRightStash } from './readerRows'
import { readerRoster } from './rosterCache'

/**
 * *Not right* on an AI line (F-16.18; design §2.7 "Dismissed", plan P2a §4). Two choices:
 *
 * - **Wrong value**: a `notRight` Dismissed row keyed by the record, slot, value and the quote's
 *   own sentences (their gate texts, names folded: `statingKey`), so a new sentence stating it is
 *   new evidence, and the line goes. The claim row is kept beside the tombstone (the settings row
 *   `memoryNotRight`), so *Undo* in Dismissed brings the line back as it was; the anchors job
 *   then re-checks it against the text as it is now.
 * - **Not about Mara** (the author picks the record): one `verify.v1` call, the fast tier, the
 *   quote's sentences ±3 so a pronoun's antecedent is in reach. Supported for the picked record
 *   with the line's voice and mode: the line moves to that record (proved by the checker now), and
 *   the first record gets a `notRight` row (nothing to restore: the line lives on). Not
 *   supported: dismissed as a wrong value. No `reading` row is written: the request is in the
 *   ledger, and the health gate stays about readings (decided by Claude, unconfirmed).
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

/** A claim's `notRight` tombstone, keyed by its record (or `recordId`), or null when its quote is gone. */
function writeNotRight(
  db: TreeDb,
  scene: ReadingScene | null,
  claim: Claim,
  recordId: string,
  now: Date
): Dismissed | null {
  const stating = scene === null ? null : statingOf(scene, claim)
  if (stating === null) return null
  const name = getRecord(db, recordId)?.name ?? ''
  return dismiss(
    db,
    {
      kind: 'notRight',
      key: dismissedKey({
        kind: 'notRight',
        recordId,
        slot: claim.slot,
        value: claim.value,
        stating
      }),
      recordId,
      nodeId: claim.nodeId,
      label: `${name}: ${slotLabel(claim.slot)} ${claim.value}`,
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
 * `notRight` Dismissed row for each claim whose quote can still be found to key it, its row kept
 * for *Undo*, and every claim goes. Answers the rows written (one per tombstone).
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
    gone.push(claim.id)
    if (claim.recordId === null) continue
    if (!scenes.has(claim.nodeId)) {
      book ??= readBook(db)
      scenes.set(claim.nodeId, loadReadingScene(db, claim.nodeId, book))
    }
    const row = writeNotRight(db, scenes.get(claim.nodeId) ?? null, claim, claim.recordId, now)
    const stored = rows.get(claim.id)
    if (row === null) continue
    written.set(row.id, row)
    if (stored !== undefined) stash[row.id] = [...(stash[row.id] ?? []), stored]
  }
  deleteClaims(db, gone)
  setNotRightStash(db, stash)
  return [...written.values()]
}

/** Whether a row with this id exists in one of the tables a claim points at. */
function exists(
  db: TreeDb,
  table: typeof node | typeof draft | typeof reading | typeof record,
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
    const restored: ClaimRow = {
      ...row,
      readingId:
        row.readingId !== null && exists(db, reading, row.readingId) ? row.readingId : null,
      objectId: optional(row.objectId),
      speakerId: optional(row.speakerId),
      fromId: optional(row.fromId)
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
  outcome: 'moved' | 'dismissed' | 'gone'
  dismissed: Dismissed | null
  nodeIds: string[]
  recordIds: string[]
}

/** *Not right › Wrong value* for one line. */
export function wrongValue(db: TreeDb, claimId: string, now: Date): NotRightOutcome {
  const claim = getClaim(db, claimId)
  if (claim === null) return { outcome: 'gone', dismissed: null, nodeIds: [], recordIds: [] }
  const [row] = db.transaction((tx) => dismissClaimsNotRight(tx, [claim], now))
  return {
    outcome: 'dismissed',
    dismissed: row ?? null,
    nodeIds: [claim.nodeId],
    recordIds: claim.recordId === null ? [] : [claim.recordId]
  }
}

/**
 * *Not right › Not about Mara*: the line re-checked for the record the author picks (one
 * `verify.v1` call). Supported: it moves there; else it is dismissed as a wrong value. A line whose
 * quote is no longer in its scene cannot be checked and is dismissed (the author said it is wrong
 * for its record).
 */
export async function notAbout(
  db: TreeDb,
  deps: { ai: AiRequestDeps },
  input: NotAboutInput
): Promise<NotRightOutcome> {
  const claim = getClaim(db, input.claimId)
  if (claim === null) return { outcome: 'gone', dismissed: null, nodeIds: [], recordIds: [] }
  if (getRecord(db, input.recordId) === null) {
    throw new AppError('NOT_FOUND', 'That record no longer exists', { recordId: input.recordId })
  }
  const was = claim.recordId
  if (was === input.recordId) {
    return { outcome: 'moved', dismissed: null, nodeIds: [claim.nodeId], recordIds: [was] }
  }
  const now = (): Date => deps.ai.now()
  const scene = loadReadingScene(db, claim.nodeId, readBook(db))
  const roster = readerRoster(db)
  const check =
    scene === null
      ? null
      : claimCheck(scene, { ...claim, recordId: input.recordId }, roster, SPOT_STRONG_AROUND)
  let supported = false
  if (check !== null) {
    const prompt = buildVerifyPrompt({ items: [check] })
    const result = await runAiRequest(deps.ai, {
      feature: 'verify',
      tier: 'fast',
      messages: prompt.messages,
      maxTokens: prompt.maxTokens,
      json: true,
      contextHash: sha256(JSON.stringify(prompt.messages)),
      promptVersion: VERIFY_PROMPT_VERSION,
      requestId: input.requestId,
      cacheIf: (text) => parseVerifyAnswer(text).size > 0
    })
    input.onSpend?.(result.costUsd)
    const verdict = parseVerifyAnswer(result.text).get(1)
    supported =
      verdict !== undefined &&
      agrees(verdict, { expect: check.expect, voice: claim.voice, mode: claim.mode })
  }
  // The text may have changed while the check was out: the line is read again from the store.
  const current = getClaim(db, claim.id)
  if (current === null) return { outcome: 'gone', dismissed: null, nodeIds: [], recordIds: [] }
  const recordIds = [...new Set([...(was === null ? [] : [was]), input.recordId])]
  if (!supported) {
    const outcome = wrongValue(db, current.id, now())
    return { ...outcome, recordIds }
  }
  const dismissed = db.transaction((tx) => {
    const row = was === null ? null : writeNotRight(tx, scene, current, was, now())
    tx.update(claimTable)
      .set({
        recordId: input.recordId,
        pending: null,
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
