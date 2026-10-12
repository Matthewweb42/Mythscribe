import type { Card } from '@shared/memory/claims'
import type { PromptCard } from '@shared/memory/cardText'
import { readerMayRead } from '@shared/memory/sources'
import { currentDraftId } from '../../draft/draftStore'
import type { TreeDb } from '../../tree/treeStore'
import { dismissedKeys } from '../dismissedStore'
import { listRecords } from '../recordStore'
import { draftCards, getCard } from './cardStore'
import { claimSources } from './claimStore'
import { heldCard } from './views'

/**
 * The v2 card as the readers that used to read stored summaries take it (F-16.20, plan P2a §5.1):
 * the active draft's card of a scene, with only what still stands on the text (`heldCard`: a
 * field whose sentence was edited since, or one the author said is not right, is left out). The
 * POV is the verified record's name; a place or time is given as the text words it. Reads only.
 */

/** A held card as the readers take it; `names` maps a record id to its name. */
function toPromptCard(
  db: TreeDb,
  card: Card,
  readable: boolean,
  notRight: ReadonlySet<string>,
  names: ReadonlyMap<string, string>
): PromptCard {
  const held = heldCard(db, card, readable, notRight)
  const pov = held.fields.pov
  return {
    line: card.line,
    gist: card.gist,
    where: held.fields.where?.value ?? null,
    when: held.fields.when?.value ?? null,
    pov: pov?.verified === true ? (names.get(pov.value) ?? null) : null,
    mood: card.mood ?? '',
    theme: card.theme ?? ''
  }
}

/** The active draft's card of one scene as the readers take it, or null when it has none. */
export function promptCard(db: TreeDb, nodeId: string): PromptCard | null {
  return promptCards(db, [nodeId]).get(nodeId) ?? null
}

/** Several scenes' cards at once (the beta reader's map), sharing the reads. */
export function promptCards(db: TreeDb, nodeIds: readonly string[]): Map<string, PromptCard> {
  const draftId = currentDraftId(db)
  const out = new Map<string, PromptCard>()
  if (draftId === null || nodeIds.length === 0) return out
  const sourceOf = claimSources(db)
  const notRight = dismissedKeys(db, 'notRight')
  const names = new Map(listRecords(db).map((each) => [each.id, each.name]))
  for (const nodeId of nodeIds) {
    const card = getCard(db, nodeId, draftId)
    if (card === null) continue
    out.set(nodeId, toPromptCard(db, card, readerMayRead(sourceOf(nodeId)), notRight, names))
  }
  return out
}

/** The active draft's card lines by scene (the story map, the Outline and the cork board). */
export function cardLines(db: TreeDb): Map<string, string> {
  const draftId = currentDraftId(db)
  if (draftId === null) return new Map()
  return new Map(
    draftCards(db, draftId)
      .filter((card) => card.line.trim() !== '')
      .map((card) => [card.nodeId, card.line])
  )
}

/** The active draft's card mood and theme of one scene (rewrite's and edit passes' mood slot). */
export function cardMoodOf(db: TreeDb, nodeId: string): { mood: string; theme: string } | null {
  const draftId = currentDraftId(db)
  const card = draftId === null ? null : getCard(db, nodeId, draftId)
  return card === null ? null : { mood: card.mood ?? '', theme: card.theme ?? '' }
}
