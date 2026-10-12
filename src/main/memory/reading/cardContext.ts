import type { Card } from '@shared/memory/claims'
import type { PromptCard } from '@shared/memory/cardText'
import { readerMayRead } from '@shared/memory/sources'
import { fromQuote } from '@shared/memory/typedVsText'
import { currentDraftId } from '../../draft/draftStore'
import type { TreeDb } from '../../tree/treeStore'
import { dismissedKeys } from '../dismissedStore'
import { listRecords } from '../recordStore'
import { storedSceneDetails } from '../sceneDetailStore'
import { draftCards, getCard } from './cardStore'
import { claimSources } from './claimStore'
import { heldCard, hereChips } from './views'

/**
 * The v2 card as the readers that used to read stored summaries take it (F-16.20, plan P2a §5.1):
 * the active draft's card of a scene, with only what still stands on the text (`heldCard`: a
 * field whose sentence was edited since, or one the author said is not right, is left out). The
 * POV is the verified record's name; a place or time is given only as the text words it
 * (verified, or the value is words of its own quote: `fromQuote`), never as the AI's paraphrase.
 * Only a readable scene has a card here: an Idea scene or one left out of compile never happened
 * (design §2.2), so a card it kept from before is no one's map (the story map, the agent's tools,
 * the beta reader, synopsis and notes suggestions, the mood slot). Reads only.
 */

/** Whether a manuscript scene is read at all (not an Idea, not left out of compile). */
function readableScenes(db: TreeDb): (nodeId: string) => boolean {
  const sourceOf = claimSources(db)
  return (nodeId) => readerMayRead(sourceOf(nodeId))
}

/** A held card as the readers take it; `names` maps a record id to its name. */
function toPromptCard(
  db: TreeDb,
  card: Card,
  notRight: ReadonlySet<string>,
  names: ReadonlyMap<string, string>
): PromptCard {
  const held = heldCard(db, card, true, notRight)
  const pov = held.fields.pov
  return {
    line: card.line,
    gist: card.gist,
    where: fromQuote(held.fields.where)?.value ?? null,
    when: fromQuote(held.fields.when)?.value ?? null,
    pov: pov?.verified === true ? (names.get(pov.value) ?? null) : null,
    mood: card.mood ?? '',
    theme: card.theme ?? ''
  }
}

/** The active draft's card of one readable scene as the readers take it, or null. */
export function promptCard(db: TreeDb, nodeId: string): PromptCard | null {
  return promptCards(db, [nodeId]).get(nodeId) ?? null
}

/** Several readable scenes' cards at once (the beta reader's map), sharing the reads. */
export function promptCards(db: TreeDb, nodeIds: readonly string[]): Map<string, PromptCard> {
  const draftId = currentDraftId(db)
  const out = new Map<string, PromptCard>()
  if (draftId === null || nodeIds.length === 0) return out
  const readable = readableScenes(db)
  const notRight = dismissedKeys(db, 'notRight')
  const names = new Map(listRecords(db).map((each) => [each.id, each.name]))
  for (const nodeId of nodeIds) {
    if (!readable(nodeId)) continue
    const card = getCard(db, nodeId, draftId)
    if (card === null) continue
    out.set(nodeId, toPromptCard(db, card, notRight, names))
  }
  return out
}

/** The active draft's card lines by readable scene (the story map, the Outline and the cork board). */
export function cardLines(db: TreeDb): Map<string, string> {
  const draftId = currentDraftId(db)
  if (draftId === null) return new Map()
  const readable = readableScenes(db)
  return new Map(
    draftCards(db, draftId)
      .filter((card) => card.line.trim() !== '' && readable(card.nodeId))
      .map((card) => [card.nodeId, card.line])
  )
}

/** The active draft's card mood and theme of one readable scene (the mood slot and the block). */
export function cardMoodOf(db: TreeDb, nodeId: string): { mood: string; theme: string } | null {
  const draftId = currentDraftId(db)
  if (draftId === null || !readableScenes(db)(nodeId)) return null
  const card = getCard(db, nodeId, draftId)
  return card === null ? null : { mood: card.mood ?? '', theme: card.theme ?? '' }
}

/**
 * Whether a record is Here in a scene, as the This scene panel's Here reads it (`hereChips`: the
 * POV, the text's over a typed one; a character on the page by a verified quote that stands; *+
 * also here*). A record merely named is not Here. Only a readable scene has anyone Here. The
 * returned test shares the reads across scenes.
 */
export function hereTest(db: TreeDb): (nodeId: string, recordId: string) => boolean {
  const draftId = currentDraftId(db)
  const readable = readableScenes(db)
  const notRight = dismissedKeys(db, 'notRight')
  const roster = new Map(listRecords(db).map((each) => [each.id, each]))
  return (nodeId, recordId) => {
    if (!readable(nodeId)) return false
    const card = draftId === null ? null : getCard(db, nodeId, draftId)
    const held = card === null ? null : heldCard(db, card, true, notRight)
    return hereChips(storedSceneDetails(db, nodeId), held, roster).some(
      (chip) => chip.recordId === recordId
    )
  }
}
