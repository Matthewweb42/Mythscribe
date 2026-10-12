import { passageParagraphs } from '@shared/mentions'
import { anchorInPlace, sceneSentences } from '@shared/memory/anchor'
import { EMPTY_DOC } from '@shared/tiptap'
import { currentDraftId } from '../../draft/draftStore'
import type { TreeDb } from '../../tree/treeStore'
import { documentJson, manuscriptDocuments } from '../../voice/profile'
import { attachClaims, claimsWaitingOnName, deleteClaims } from './claimStore'

/**
 * Facts waiting on a new name (F-16.17; design §2.2 identity rule 7, plan P2a §2.4 step 7): the
 * reader proposed a name not on the roster with a proved fact, the author is asked about the name
 * once (P1's name questions), and nothing is guessed onto a look-alike record meanwhile. Her
 * answer settles them:
 * - **Yes** (*Add as* a new record, or a nickname's *Yes*): an anchor check first. A fact whose
 *   sentences still stand in place goes live on the record; any other is attached stale, so the
 *   next reading of its paragraph proves it again through the ladder or drops it (P2a-D23). Facts
 *   in another draft are attached stale too: their text is not the scene's now.
 * - **No** (*Not a name*, a nickname's *No*): the name is on the Dismissed list (P1) and its
 *   waiting facts are deleted.
 */

export interface SettledName {
  attached: string[]
  /** Attached stale: read again through the ladder at the next reading of their paragraph. */
  restaled: string[]
  deleted: string[]
  /** The scenes whose facts moved. */
  nodeIds: string[]
}

/** Settles the facts waiting on `norm`: attaches them to `recordId`, or deletes them when null. */
export function settleWaitingName(
  db: TreeDb,
  norm: string,
  recordId: string | null,
  now: Date
): SettledName {
  const waiting = claimsWaitingOnName(db, norm)
  const settled: SettledName = { attached: [], restaled: [], deleted: [], nodeIds: [] }
  if (waiting.length === 0) return settled
  settled.nodeIds = [...new Set(waiting.map((claim) => claim.nodeId))]
  if (recordId === null) {
    settled.deleted = waiting.map((claim) => claim.id)
    deleteClaims(db, settled.deleted)
    return settled
  }
  const draftId = currentDraftId(db)
  const scenes = new Map(manuscriptDocuments(db).map((row) => [row.id, row]))
  const hashes = new Map<string, string[]>()
  const hashesOf = (nodeId: string): string[] => {
    const known = hashes.get(nodeId)
    if (known !== undefined) return known
    const row = scenes.get(nodeId)
    const texts =
      row === undefined
        ? []
        : passageParagraphs(documentJson(row) ?? EMPTY_DOC).map((paragraph) => paragraph.text)
    const found = sceneSentences(texts).map((sentence) => sentence.hash)
    hashes.set(nodeId, found)
    return found
  }
  for (const claim of waiting) {
    const holds = claim.draftId === draftId && anchorInPlace(claim.anchor, hashesOf(claim.nodeId))
    if (holds) settled.attached.push(claim.id)
    else settled.restaled.push(claim.id)
  }
  db.transaction((tx) => {
    attachClaims(tx, settled.attached, recordId, now)
    attachClaims(tx, settled.restaled, recordId, now, 'stale')
  })
  return settled
}
