import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FactStatus } from '@shared/facts'
import { observedAttributeLabel, type ExtractedFact } from '@shared/observedFacts'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import type { ExtractedTag } from '@shared/summary'
import { applyAutoTags, type AutoTagsChange } from '../ai/autoTags'
import { applyObservedFacts, type ObservedFactsChange } from '../ai/observedFacts'
import { node } from '../db/schema'
import { listEntities } from '../entity/entityStore'
import type { TreeDb } from '../tree/treeStore'
import { logChanges, type ChangeInput } from './changeLog'

/**
 * What one reading of a scene derives (F-9.13, `applyDerivedKnowledge`, which took over F-5.16's
 * `applyObservedFacts` call in the summary run): the dated facts and the sheets they need, then
 * the scene's tags and the records of new name tags (F-4.13, F-9.12), then one Changes-log run
 * listing everything that was added, each with its Undo. One transaction, nested in the summary's
 * own, so the summary, the facts, the tags, and the log land together or not at all. No scene
 * text is read beyond what the summary request sent, and none is written.
 */

export interface DerivedKnowledgeInput {
  nodeId: string
  facts: readonly ExtractedFact[]
  tags: readonly ExtractedTag[]
  /** The scene as it was sent; a fact whose quote is no longer in it goes. */
  sceneText: string
  now: string
}

export interface DerivedKnowledge {
  facts: ObservedFactsChange
  tags: AutoTagsChange
  /** The log run's id; its rows are what "Undo this run" takes back. */
  runId: string
  /** How many rows the run logged; 0 when nothing was added. */
  logged: number
}

/** D7: what the scene states is canon, except in a scene the author marked as an idea. */
function sceneFactStatus(db: TreeDb, nodeId: string): FactStatus {
  const row = db.select({ sceneMeta: node.sceneMeta }).from(node).where(eq(node.id, nodeId)).get()
  return row !== undefined && parseStoredSceneMeta(row.sceneMeta).status === 'idea'
    ? 'idea'
    : 'canon'
}

export function applyDerivedKnowledge(db: TreeDb, input: DerivedKnowledgeInput): DerivedKnowledge {
  return db.transaction((tx) => {
    const { nodeId } = input
    const facts = applyObservedFacts(
      tx,
      nodeId,
      input.facts,
      input.sceneText,
      sceneFactStatus(tx, nodeId)
    )
    const tags = applyAutoTags(tx, nodeId, input.tags, input.sceneText)

    const entities = new Map(listEntities(tx).map((each) => [each.id, each]))
    const changes: ChangeInput[] = []
    const firstQuote = (entityId: string): string | null =>
      facts.added.find((added) => added.entityId === entityId)?.quote ?? null
    for (const write of [...facts.created, ...tags.records]) {
      changes.push({
        kind: 'record',
        nodeId,
        quote: firstQuote(write.entity.id),
        entityId: write.entity.id,
        targetId: write.entity.id,
        label: write.entity.name,
        undo: { type: 'deleteRecord', entityId: write.entity.id }
      })
      const made = write.tagChange
      if (made?.created === true) {
        changes.push({
          kind: 'tag',
          nodeId,
          quote: null,
          entityId: write.entity.id,
          targetId: made.tag.id,
          label: `#${made.tag.name}`,
          undo: { type: 'deleteTag', tagId: made.tag.id }
        })
      }
    }
    for (const added of facts.added) {
      const owner = entities.get(added.entityId)
      const label =
        owner === undefined ? added.attribute : observedAttributeLabel(owner.kind, added.attribute)
      changes.push({
        kind: 'fact',
        nodeId,
        quote: added.quote,
        entityId: added.entityId,
        targetId: added.id,
        label: `${owner?.name ?? 'A sheet'} · ${label}: ${added.value}`,
        undo: { type: 'hideFact', factId: added.id }
      })
    }
    for (const created of tags.created) {
      changes.push({
        kind: 'tag',
        nodeId,
        quote: null,
        entityId: null,
        targetId: created.id,
        label: `#${created.name}`,
        undo: { type: 'deleteTag', tagId: created.id }
      })
    }
    for (const linked of tags.linked) {
      changes.push({
        kind: 'tagLink',
        nodeId,
        quote: null,
        entityId: null,
        targetId: linked.id,
        label: `#${linked.name}`,
        undo: { type: 'unlinkTag', nodeId, tagId: linked.id }
      })
    }
    const runId = randomUUID()
    return { facts, tags, runId, logged: logChanges(tx, runId, changes, input.now) }
  })
}
