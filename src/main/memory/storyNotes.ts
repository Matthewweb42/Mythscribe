import type { StoryRecord } from '@shared/memory/records'
import type { HeldCard } from '@shared/memory/reproof'
import {
  renderStoryNotes,
  type StoryNotesFacts,
  type StoryNotesRecord
} from '@shared/memory/storyNotes'
import { compareTyped, effectiveSceneLine } from '@shared/memory/typedVsText'
import type { PromptSceneMeta, SceneMeta } from '@shared/sceneMeta'
import { currentDraftId } from '../draft/draftStore'
import { getNode, type TreeDb } from '../tree/treeStore'
import { labelsForNode } from './labelStore'
import { listNameMentions } from './nameIndexer'
import { getCard } from './reading/cardStore'
import { heldCard, hereChips, hereValues, readingOrder, typedNames } from './reading/views'
import { getRecord, listRecords } from './recordStore'
import { storedSceneDetails } from './sceneDetailStore'

/**
 * The Story notes block a v2 prose prompt carries (F-16.14, P1 slice 5): the facts gathered here
 * and rendered by the pure `renderStoryNotes`. Here is the This scene panel's Here (`hereChips`:
 * the POV, the text's over a typed one that differs, decision 4; since P2a also the characters on
 * the page by the scene's card; *+ also here*); Named is the local name scan's certain mentions of
 * the scene, most named first, then first named first (the panel's chips); the records are read
 * with their Pinned page (Ideas rides along unread); the labels are the scene's own. F-16.20 adds
 * what the book states about the Here records as of the scene (`hereValues`) and the card's mood.
 * A few cheap queries, no cache: the rendered string goes into each feature's context hash, as
 * the bible does, so a changed note, name or reading never answers from a stale cache entry. Null
 * with no document open, for a node that is gone, and when the block would say nothing.
 */

export interface StoryNotesInput {
  /** The document the request is about, or null with none open. */
  nodeId: string | null
  /** `STORY_BIBLE_TOKEN_BUDGET`, or `STORY_BIBLE_GHOST_TOKEN_BUDGET` for ghost text. */
  maxTokens: number
  /** The continuity pass's block (`StoryNotesOptions.continuity`). */
  continuity?: boolean
  /** F-16.20: false for rewrite and edit passes, which carry the mood in their own slot. */
  mood?: boolean
}

const toNotesRecord = (record: StoryRecord): StoryNotesRecord => ({
  id: record.id,
  name: record.name,
  aliases: record.aliases.filter((alias) => !alias.isMain).map((alias) => alias.text),
  pinned: record.pinned,
  ideas: record.ideas
})

/** The facts of the block for `nodeId`, or null for a node that does not exist (or a section root). */
export function storyNotesFacts(db: TreeDb, nodeId: string): StoryNotesFacts | null {
  if ((getNode(db, nodeId)?.parentId ?? null) === null) return null
  const cache = new Map<string, StoryNotesRecord | null>()
  const recordOf = (id: string): StoryNotesRecord | null => {
    if (!cache.has(id)) {
      const found = getRecord(db, id)
      cache.set(id, found === null ? null : toNotesRecord(found))
    }
    return cache.get(id) ?? null
  }
  const present = (ids: readonly string[]): StoryNotesRecord[] =>
    ids.flatMap((id) => {
      const found = recordOf(id)
      return found === null ? [] : [found]
    })

  const details = storedSceneDetails(db, nodeId)
  const reading = readingOrder(db)
  const held = sceneHeldCard(db, nodeId, reading.order.has(nodeId))
  const roster = new Map(listRecords(db).map((each) => [each.id, each]))
  const here = hereChips(details, held, roster)
  const povId = here.find((chip) => chip.why === 'pov')?.recordId ?? null
  const hereIds = here.map((chip) => chip.recordId)
  // Certain mentions only (an ambiguous span names nobody yet), most named first, then by where
  // the scene first names each: the order of the panel's chips.
  const counts = new Map<string, { count: number; first: number }>()
  for (const mention of listNameMentions(db, nodeId)) {
    if (mention.ambiguous) continue
    const seen = counts.get(mention.recordId)
    if (seen === undefined) counts.set(mention.recordId, { count: 1, first: mention.from })
    else seen.count += 1
  }
  const named = [...counts.entries()]
    .sort(([, a], [, b]) => b.count - a.count || a.first - b.first)
    .map(([id]) => id)

  const draftId = currentDraftId(db)
  const card = draftId === null ? null : getCard(db, nodeId, draftId)
  return {
    pov: povId === null ? null : recordOf(povId),
    alsoHere: present(hereIds.filter((id) => id !== povId)),
    named: present(named),
    labels: labelsForNode(db, nodeId).map((label) => ({ name: label.name, kind: label.kind })),
    values: Object.fromEntries(hereValues(db, reading, nodeId, hereIds)),
    mood: card === null ? null : { mood: card.mood ?? '', theme: card.theme ?? '' }
  }
}

/** The active draft's card of a scene as the views use it (what stands on the text), or null. */
function sceneHeldCard(db: TreeDb, nodeId: string, readable: boolean): HeldCard | null {
  const draftId = currentDraftId(db)
  const card = draftId === null ? null : getCard(db, nodeId, draftId)
  return card === null ? null : heldCard(db, card, readable)
}

/** The rendered block for `input.nodeId`, or null when there is nothing to tell. */
export function buildStoryNotes(db: TreeDb, input: StoryNotesInput): string | null {
  if (input.nodeId === null) return null
  const facts = storyNotesFacts(db, input.nodeId)
  return facts === null
    ? null
    : renderStoryNotes(facts, input.maxTokens, {
        continuity: input.continuity === true,
        mood: input.mood !== false
      })
}

/**
 * The scene line of a v2 prose prompt (`Scene: location …, POV …, timeline …`): in story memory v2
 * the author keeps a scene's place, POV and time in its typed details (F-16.11), which replace the
 * v1 Location, POV and Timeline fields, so the line reads them (the place record's name and the
 * place text; the POV record's name; the time text and the story year). F-16.20 (decision 4): it
 * is the effective scene line, so where the scene's card has the text say otherwise (a POV, place,
 * time or year whose quote stands on the text) the text's value is given in that field's place.
 * The brief stays the scene meta's. Null when all three are empty, as `promptSceneMeta` is.
 */
export function typedSceneMeta(
  db: TreeDb,
  nodeId: string,
  meta: Pick<SceneMeta, 'brief'>
): PromptSceneMeta | null {
  const details = storedSceneDetails(db, nodeId)
  const nameOf = (id: string | null): string => (id === null ? '' : (getRecord(db, id)?.name ?? ''))
  const readable = readingOrder(db).order.has(nodeId)
  const held = sceneHeldCard(db, nodeId, readable)
  const line = effectiveSceneLine(compareTyped(details, held?.fields ?? null, typedNames(db)))
  const fromText = new Set(line.fromText)
  const location = fromText.has('place')
    ? (line.place ?? '')
    : [nameOf(details.place.recordId), details.place.text].filter((part) => part !== '').join(', ')
  const pov = fromText.has('pov') ? (line.pov ?? '') : nameOf(details.povRecordId)
  const time = fromText.has('time') ? (line.time ?? '') : details.time.text
  const year = fromText.has('year')
    ? line.year
    : details.storyYear === null
      ? null
      : String(details.storyYear)
  const timeline = [time, year === null ? '' : `year ${year}`]
    .filter((part) => part !== '')
    .join(', ')
  return location || pov || timeline ? { location, pov, timeline, brief: meta.brief } : null
}
