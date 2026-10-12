import type { StoryRecord } from '@shared/memory/records'
import {
  renderStoryNotes,
  type StoryNotesFacts,
  type StoryNotesRecord
} from '@shared/memory/storyNotes'
import type { PromptSceneMeta, SceneMeta } from '@shared/sceneMeta'
import { getNode, type TreeDb } from '../tree/treeStore'
import { labelsForNode } from './labelStore'
import { listNameMentions } from './nameIndexer'
import { getRecord } from './recordStore'
import { storedSceneDetails } from './sceneDetailStore'

/**
 * The Story notes block a v2 prose prompt carries (F-16.14, P1 slice 5): the facts gathered here
 * and rendered by the pure `renderStoryNotes`. Here is the scene's typed POV and *+ also here*
 * (F-16.11); Named is the local name scan's certain mentions of the scene, most named first, then
 * first named first (the This scene panel's chips); the records are read with their Pinned page
 * (Ideas rides along unread); the labels are the scene's own. A few cheap queries, no cache: the
 * rendered string goes into each feature's context hash, as the bible does, so a changed note or
 * name never answers from a stale cache entry. Null with no document open, for a node that is
 * gone, and when the block would say nothing.
 */

export interface StoryNotesInput {
  /** The document the request is about, or null with none open. */
  nodeId: string | null
  /** `STORY_BIBLE_TOKEN_BUDGET`, or `STORY_BIBLE_GHOST_TOKEN_BUDGET` for ghost text. */
  maxTokens: number
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

  return {
    pov: details.povRecordId === null ? null : recordOf(details.povRecordId),
    alsoHere: present(details.alsoHere),
    named: present(named),
    labels: labelsForNode(db, nodeId).map((label) => ({ name: label.name, kind: label.kind }))
  }
}

/** The rendered block for `input.nodeId`, or null when there is nothing to tell. */
export function buildStoryNotes(db: TreeDb, input: StoryNotesInput): string | null {
  if (input.nodeId === null) return null
  const facts = storyNotesFacts(db, input.nodeId)
  return facts === null ? null : renderStoryNotes(facts, input.maxTokens)
}

/**
 * The scene line of a v2 prose prompt (`Scene: location …, POV …, timeline …`): in story memory v2
 * the author keeps a scene's place, POV and time in its typed details (F-16.11), which replace the
 * v1 Location, POV and Timeline fields, so the line reads them (the place record's name and the
 * place text; the POV record's name; the time text and the story year). The brief stays the scene
 * meta's. Null when all three are empty, as `promptSceneMeta` is.
 */
export function typedSceneMeta(
  db: TreeDb,
  nodeId: string,
  meta: Pick<SceneMeta, 'brief'>
): PromptSceneMeta | null {
  const details = storedSceneDetails(db, nodeId)
  const nameOf = (id: string | null): string => (id === null ? '' : (getRecord(db, id)?.name ?? ''))
  const location = [nameOf(details.place.recordId), details.place.text]
    .filter((part) => part !== '')
    .join(', ')
  const pov = nameOf(details.povRecordId)
  const timeline = [
    details.time.text,
    details.storyYear === null ? '' : `year ${details.storyYear}`
  ]
    .filter((part) => part !== '')
    .join(', ')
  return location || pov || timeline ? { location, pov, timeline, brief: meta.brief } : null
}
