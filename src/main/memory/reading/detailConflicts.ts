import { dismissedKey, type Dismissed } from '@shared/memory/dismissed'
import { compareTyped, foldDetail, TYPED_FIELDS, type TypedField } from '@shared/memory/typedVsText'
import type { DetailConflictNotice } from '@shared/memory/views'
import { currentDraftId } from '../../draft/draftStore'
import type { TreeDb } from '../../tree/treeStore'
import { dismiss, dismissedKeys } from '../dismissedStore'
import { listRecords } from '../recordStore'
import { storedSceneDetails } from '../sceneDetailStore'
import { draftCards } from './cardStore'
import { readingOrder, typedNames } from './views'

/**
 * Decision 4's one question (F-16.18, P2a-D13; design §2.7 "Typed details"): where a scene's
 * card quotes a POV, place, time or year that disagrees with what the author typed, Needs a look
 * asks once: "14.2: the text says the quay; you typed the harbour · Update my detail · Keep mine".
 * *Keep mine* writes a `notProblem` Dismissed row keyed by the scene, the field and the text's
 * value, so the same disagreement is never asked again (a new value in the text is). Computed on
 * each look from the active draft's cards; readable scenes only.
 */

export type DetailConflict = DetailConflictNotice

/** How each field reads in a Dismissed row's label. */
const FIELD_NOUN: Record<TypedField, string> = {
  pov: 'POV',
  place: 'place',
  time: 'time',
  year: 'story year'
}

/** A conflict's notice id. */
export const detailConflictId = (nodeId: string, field: TypedField): string =>
  `detail:${nodeId}:${field}`

const keyOf = (conflict: { nodeId: string; field: TypedField; text: string }): string =>
  dismissedKey({
    kind: 'notProblem',
    detail: { nodeId: conflict.nodeId, field: conflict.field, value: conflict.text }
  })

/** The one place record the text's place names (its name or a nickname, whole words), or null. */
function placeRecordOf(
  text: string,
  places: readonly { id: string; names: string[] }[]
): string | null {
  const folded = ` ${foldDetail(text)} `
  const hits = places.filter((place) =>
    place.names.some((name) => name !== '' && folded.includes(` ${name} `))
  )
  return hits.length === 1 ? (hits[0]?.id ?? null) : null
}

/** Every typed-detail conflict of the active draft's readable scenes, in reading order. */
export function detailConflicts(db: TreeDb): DetailConflict[] {
  const draftId = currentDraftId(db)
  if (draftId === null) return []
  const cards = draftCards(db, draftId)
  if (cards.length === 0) return []
  const names = typedNames(db)
  const kept = dismissedKeys(db, 'notProblem')
  const found: { conflict: Omit<DetailConflict, 'ref'>; nodeId: string }[] = []
  let places: { id: string; names: string[] }[] | null = null
  for (const card of cards) {
    const typed = compareTyped(storedSceneDetails(db, card.nodeId), card.fields, names)
    for (const field of TYPED_FIELDS) {
      const entry = typed[field]
      if (entry.outcome !== 'differs' || entry.typed === null || entry.text === null) continue
      const base = { nodeId: card.nodeId, field, text: entry.text }
      if (kept.has(keyOf(base))) continue
      let textRecordId: string | null = null
      if (field === 'pov') textRecordId = card.fields.pov?.value ?? null
      if (field === 'place') {
        places ??= listRecords(db)
          .filter((record) => record.kind === 'place')
          .map((record) => ({
            id: record.id,
            names: [record.name, ...record.aliases.map((alias) => alias.text)].map(foldDetail)
          }))
        textRecordId = placeRecordOf(entry.text, places)
      }
      found.push({
        nodeId: card.nodeId,
        conflict: {
          id: detailConflictId(card.nodeId, field),
          kind: 'detailConflict',
          nodeId: card.nodeId,
          field,
          typed: entry.typed,
          text: entry.text,
          textRecordId,
          quote: entry.quote ?? ''
        }
      })
    }
  }
  if (found.length === 0) return []
  // The scene references, only when something disagrees (the walk reads the whole tree).
  const order = readingOrder(db)
  return found
    .filter((each) => order.order.has(each.nodeId))
    .sort(
      (a, b) =>
        (order.order.get(a.nodeId) ?? 0) - (order.order.get(b.nodeId) ?? 0) ||
        TYPED_FIELDS.indexOf(a.conflict.field) - TYPED_FIELDS.indexOf(b.conflict.field)
    )
    .map((each) => ({ ...each.conflict, ref: order.refs.get(each.nodeId) ?? '' }))
}

/** *Keep mine*: the typed value stays, and this disagreement is not asked again. */
export function keepMine(db: TreeDb, conflict: DetailConflict, now: Date): Dismissed {
  return dismiss(
    db,
    {
      kind: 'notProblem',
      key: keyOf(conflict),
      nodeId: conflict.nodeId,
      label: `${conflict.ref}: kept your ${FIELD_NOUN[conflict.field]} “${conflict.typed}” over the text’s “${conflict.text}”`,
      quote: conflict.quote === '' ? null : conflict.quote
    },
    now
  )
}
