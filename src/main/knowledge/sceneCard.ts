import { eq, inArray } from 'drizzle-orm'
import { recordNameForTag } from '@shared/knowledge'
import {
  SCENE_CARD_CAST_MAX,
  SCENE_CARD_THREADS_MAX,
  isEmptyCard,
  type SceneCard,
  type SceneCardThread,
  type SceneCardValue
} from '@shared/sceneCard'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import type { Fact } from '@shared/facts'
import { threadEventOf, threadEventRank, type ThreadEvent } from '@shared/threads'
import { entity, node, tag } from '../db/schema'
import { getSummary } from '../document/summaryStore'
import { eventFactsForNode } from '../entity/factStore'
import { listMentionsForNode } from '../tag/mentionStore'
import type { TreeDb } from '../tree/treeStore'

/**
 * A scene's card (F-9.14), put together at read time from what is already stored, with no AI and
 * no write: the AI's reading of where, when, POV, and what changed (`scene_summary.card`, written
 * by `summary.v4`), the author's own scene metadata winning over it field by field, the cast from
 * the local mention index (the character tags the scene names, most mentioned first, each by its
 * record's name), else the summary's cast, and the thread events the scene holds. Null when the
 * node has nothing to show (no summary yet and no metadata) or is not a node at all.
 */
export function sceneCardFor(db: TreeDb, nodeId: string): SceneCard | null {
  const row = db.select({ sceneMeta: node.sceneMeta }).from(node).where(eq(node.id, nodeId)).get()
  if (row === undefined) return null
  const meta = parseStoredSceneMeta(row.sceneMeta)
  const summary = getSummary(db, nodeId)
  const ai = summary?.card ?? null

  const pick = (author: string, read: string | undefined): SceneCardValue | null => {
    if (author.trim() !== '') return { value: author.trim(), origin: 'author' }
    if (read !== undefined && read !== '') return { value: read, origin: 'ai' }
    return null
  }

  const card: SceneCard = {
    where: pick(meta.location, ai?.where),
    when: pick(meta.timeline, ai?.when),
    pov: pick(meta.pov, ai?.pov),
    changed: ai?.changed ?? '',
    cast: castOf(db, nodeId, summary?.characters ?? []),
    threads: threadsOf(db, nodeId)
  }
  return isEmptyCard(card) ? null : card
}

/** The character tags the scene names, most mentioned first, by record name; else the summary's cast. */
function castOf(db: TreeDb, nodeId: string, fallback: readonly string[]): string[] {
  const mentions = listMentionsForNode(db, nodeId)
  if (mentions.length > 0) {
    const tags = db
      .select({ id: tag.id, name: tag.name, category: tag.category })
      .from(tag)
      .where(
        inArray(
          tag.id,
          mentions.map((mention) => mention.tagId)
        )
      )
      .all()
      .filter((row) => row.category === 'character')
    const records = new Map(
      tags.length === 0
        ? []
        : db
            .select({ tagId: entity.tagId, name: entity.name })
            .from(entity)
            .where(
              inArray(
                entity.tagId,
                tags.map((row) => row.id)
              )
            )
            .all()
            .map((row) => [row.tagId, row.name])
    )
    const count = new Map(mentions.map((mention) => [mention.tagId, mention.count]))
    const names = tags
      .sort(
        (a, b) => (count.get(b.id) ?? 0) - (count.get(a.id) ?? 0) || a.name.localeCompare(b.name)
      )
      .map((row) => records.get(row.id) ?? recordNameForTag(row.name))
    if (names.length > 0) return names.slice(0, SCENE_CARD_CAST_MAX)
  }
  return fallback.slice(0, SCENE_CARD_CAST_MAX)
}

/** The scene's thread events, one per thread (the last event the scene states for it). */
function threadsOf(db: TreeDb, nodeId: string): SceneCardThread[] {
  const events: { fact: Fact; event: ThreadEvent }[] = []
  for (const fact of eventFactsForNode(db, nodeId)) {
    const event = threadEventOf(fact.attribute)
    if (event !== null) events.push({ fact, event })
  }
  if (events.length === 0) return []
  const names = new Map(
    db
      .select({ id: entity.id, name: entity.name })
      .from(entity)
      .where(
        inArray(
          entity.id,
          events.map((each) => each.fact.entityId)
        )
      )
      .all()
      .map((row) => [row.id, row.name])
  )
  const byThread = new Map<string, SceneCardThread>()
  for (const { fact, event } of events) {
    // The last in stored order, but a resolution or a drop over an opening or an advance.
    const held = byThread.get(fact.entityId)
    if (held !== undefined && threadEventRank(held.event) > threadEventRank(event)) continue
    byThread.set(fact.entityId, {
      entityId: fact.entityId,
      name: names.get(fact.entityId) ?? '',
      event
    })
  }
  return [...byThread.values()].slice(0, SCENE_CARD_THREADS_MAX)
}
