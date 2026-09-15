import { parseStoredSceneMeta } from '@shared/sceneMeta'
import {
  renderStoryBible,
  STORY_BIBLE_CATEGORIES,
  type SceneNeighbor,
  type StoryBibleCategory,
  type StoryBibleFacts,
  type StoryBibleScene
} from '@shared/storyBible'
import type { NodeRow } from '../../db/schema'
import { listDocumentTags } from '../../tag/documentTagStore'
import { listTags } from '../../tag/tagStore'
import { listNodes, type TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'

export interface StoryBibleInput {
  /** The document the request is about, or null when none is open (chat outside the manuscript). */
  nodeId: string | null
  /** `STORY_BIBLE_TOKEN_BUDGET`, or the ghost-text budget for the feature that runs on every pause. */
  maxTokens: number
}

/**
 * The story bible block a prompt carries (F-14.9): the facts the project already holds,
 * gathered here and rendered by the pure `renderStoryBible`. The bank is every tag in a story
 * category in `tag:list` order; the scene part exists only for a document under the
 * manuscript root: its tags, its containing folders nearest first, its position among its
 * sibling documents, and the documents either side of it in reading order (the same
 * `manuscriptDocuments` order the voice profile and the scene brief's neighbours use, so the
 * last scene of one chapter precedes the first of the next) with their metadata. Front and end
 * matter get the bank alone. A few cheap queries, no cache: the rendered string goes into the
 * feature's context hash, so a changed bible never answers from a stale local cache entry.
 * F-9 entity sheets and F-5.6 summaries plug in here later.
 */
export function buildStoryBible(db: TreeDb, input: StoryBibleInput): string | null {
  const bank = listTags(db).flatMap((tag) =>
    isStoryCategory(tag.category) ? [{ category: tag.category, name: tag.name }] : []
  )
  const facts: StoryBibleFacts = { bank, scene: null, previous: null, next: null }
  if (input.nodeId !== null) Object.assign(facts, scenePart(db, input.nodeId))
  return renderStoryBible(facts, input.maxTokens)
}

function isStoryCategory(category: string): category is StoryBibleCategory {
  return (STORY_BIBLE_CATEGORIES as readonly string[]).includes(category)
}

/** The scene, previous, and next facts for a manuscript document; all null for any other node. */
function scenePart(
  db: TreeDb,
  nodeId: string
): Pick<StoryBibleFacts, 'scene' | 'previous' | 'next'> {
  const none = { scene: null, previous: null, next: null }
  const documents = manuscriptDocuments(db)
  const at = documents.findIndex((row) => row.id === nodeId)
  const current = documents[at]
  if (current === undefined) return none

  // The containing folders nearest first, stopping short of the manuscript root itself.
  const byId = new Map(listNodes(db).map((row) => [row.id, row]))
  const ancestors: string[] = []
  for (let row = byId.get(current.parentId ?? ''); row && row.parentId !== null; ) {
    ancestors.push(row.title)
    row = byId.get(row.parentId)
  }

  const siblings = documents.filter((row) => row.parentId === current.parentId)
  const scene: StoryBibleScene = {
    title: current.title,
    ancestors,
    index: siblings.findIndex((row) => row.id === nodeId) + 1,
    count: siblings.length,
    tags: listDocumentTags(db, nodeId).map((tag) => tag.name)
  }
  const previous = at > 0 ? documents[at - 1] : undefined
  const next = documents[at + 1]
  return {
    scene,
    previous: previous ? neighbor(previous) : null,
    next: next ? neighbor(next) : null
  }
}

function neighbor(row: NodeRow): SceneNeighbor {
  const meta = parseStoredSceneMeta(row.sceneMeta)
  return { title: row.title, location: meta.location, pov: meta.pov, timeline: meta.timeline }
}
