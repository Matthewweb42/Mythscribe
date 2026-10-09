import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Entity } from '@shared/ipc/contract'
import type { Fact, FactStatus } from '@shared/facts'
import {
  isObservedDismissed,
  observedAttributeLabel,
  type ExtractedFact
} from '@shared/observedFacts'
import { RELATION_LABEL, relationAttribute, relationTypeOf } from '@shared/relations'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import {
  SUMMARY_NEW_THREADS_MAX,
  type ExtractedRelation,
  type ExtractedTag,
  type ExtractedThreadEvent
} from '@shared/summary'
import { THREAD_EVENT_LABEL, THREAD_KIND, threadAttribute, threadEventOf } from '@shared/threads'
import { applyAutoTags, type AutoTagsChange } from '../ai/autoTags'
import {
  resolveName,
  resolveObservedFacts,
  sheetTagRule,
  type ObservedFactsChange
} from '../ai/observedFacts'
import { node } from '../db/schema'
import { createEntity, listEntities, type EntityWrite } from '../entity/entityStore'
import { applySceneFacts, type SceneFactInput } from '../entity/factStore'
import { AppError } from '../ipc/errors'
import { getObservedDismissed } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'
import { logChanges, type ChangeInput } from './changeLog'

/**
 * What one reading of a scene derives (F-9.13, `applyDerivedKnowledge`, which took over F-5.16's
 * `applyObservedFacts` call in the summary run): the dated facts and the sheets they need, then
 * the scene's tags and the records of new name tags (F-4.13, F-9.12), then F-9.14's relationships
 * between two records and the plot-thread events (with the thread records they need), then one
 * Changes-log run listing everything that was added, each with its Undo. One transaction, nested
 * in the summary's own, so the summary, the facts, the tags, and the log land together or not at
 * all. No scene text is read beyond what the summary request sent, and none is written.
 */

export interface DerivedKnowledgeInput {
  nodeId: string
  facts: readonly ExtractedFact[]
  tags: readonly ExtractedTag[]
  /** F-9.14: the relationships the scene states; both ends must be records already. */
  relations?: readonly ExtractedRelation[]
  /** F-9.14: the plot-thread events the scene holds. */
  threads?: readonly ExtractedThreadEvent[]
  /** The scene as it was sent; a fact whose quote is no longer in it goes. */
  sceneText: string
  now: string
}

export interface DerivedKnowledge {
  facts: ObservedFactsChange
  tags: AutoTagsChange
  /** The log run's id; its rows are what "Undo run" takes back. */
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

/**
 * The scene's relationships as fact rows (F-9.14): each end resolved to a record the story bible
 * already has (`resolveName`, any kind but a thread; a relationship never makes a sheet, the "no
 * assuming" rule), the two ends different. Answers the rows and how many were left out.
 */
function resolveRelations(
  db: TreeDb,
  relations: readonly ExtractedRelation[]
): { rows: SceneFactInput[]; skipped: number } {
  const things = listEntities(db).filter((entity) => entity.kind !== THREAD_KIND)
  const rows: SceneFactInput[] = []
  let skipped = 0
  for (const relation of relations) {
    const from = resolveName(db, things, relation.from, null)
    const to = resolveName(db, things, relation.to, null)
    if (from === undefined || to === undefined || from.id === to.id) {
      skipped += 1
      continue
    }
    rows.push({
      entityId: from.id,
      attribute: relationAttribute(relation.type),
      value: '',
      quote: relation.quote,
      objectEntityId: to.id
    })
  }
  return { rows, skipped }
}

/**
 * The scene's thread events as fact rows on thread records (F-9.14): the name resolved to a
 * thread record (by name, alias, or its plot-thread tag), else a new AI-made thread record —
 * blank, with a plot-thread tag under the author's tag rule — at most
 * `SUMMARY_NEW_THREADS_MAX` per reading and never one the author deleted (its name is
 * remembered). The note is the open question of an opening, '' otherwise.
 */
function resolveThreadEvents(
  db: TreeDb,
  nodeId: string,
  events: readonly ExtractedThreadEvent[],
  sceneText: string
): { rows: SceneFactInput[]; created: EntityWrite[]; skipped: number } {
  const threads: Entity[] = listEntities(db).filter((entity) => entity.kind === THREAD_KIND)
  const dismissed = getObservedDismissed(db)
  const mayTag = sheetTagRule(db, nodeId, sceneText)
  const created: EntityWrite[] = []
  const rows: SceneFactInput[] = []
  let skipped = 0
  for (const event of events) {
    let thread = resolveName(db, threads, event.name, THREAD_KIND)
    if (thread === undefined) {
      if (
        created.length >= SUMMARY_NEW_THREADS_MAX ||
        isObservedDismissed(dismissed, THREAD_KIND, event.name)
      ) {
        skipped += 1
        continue
      }
      try {
        const write = db.transaction((tx) =>
          createEntity(tx, { kind: THREAD_KIND, name: event.name, template: 'blank' }, 'ai', {
            tag: mayTag(event.name)
          })
        )
        created.push(write)
        threads.push(write.entity)
        thread = write.entity
      } catch (err) {
        // A name a sheet of another kind already holds, or one no sheet can carry.
        if (!(err instanceof AppError)) throw err
        skipped += 1
        continue
      }
    }
    rows.push({
      entityId: thread.id,
      attribute: threadAttribute(event.event),
      value: event.event === 'opened' ? event.question : '',
      quote: event.quote
    })
  }
  return { rows, created, skipped }
}

/** The one line the Changes section shows for an added fact. */
function factLabel(added: Fact, entities: ReadonlyMap<string, Entity>): string {
  const owner = entities.get(added.entityId)
  const ownerName = owner?.name ?? 'A sheet'
  const relation = relationTypeOf(added.attribute)
  if (relation !== null) {
    const other =
      added.objectEntityId === null ? undefined : entities.get(added.objectEntityId)?.name
    return `${ownerName} · ${RELATION_LABEL[relation]} ${other ?? 'a sheet'}`
  }
  const event = threadEventOf(added.attribute)
  if (event !== null) {
    const note = added.value === '' ? '' : `: ${added.value}`
    return `Thread ${ownerName} · ${THREAD_EVENT_LABEL[event]}${note}`
  }
  const label =
    owner === undefined ? added.attribute : observedAttributeLabel(owner.kind, added.attribute)
  return `${ownerName} · ${label}: ${added.value}`
}

export function applyDerivedKnowledge(db: TreeDb, input: DerivedKnowledgeInput): DerivedKnowledge {
  return db.transaction((tx) => {
    const { nodeId } = input
    const resolved = resolveObservedFacts(tx, nodeId, input.facts, input.sceneText)
    const tags = applyAutoTags(tx, nodeId, input.tags, input.sceneText)
    // After the facts and the tags: a sheet either made is a record a relationship may name.
    const relations = resolveRelations(tx, input.relations ?? [])
    const threads = resolveThreadEvents(tx, nodeId, input.threads ?? [], input.sceneText)
    // One sticky apply for every statement of the scene, so none of them reads another as gone.
    const diff = applySceneFacts(
      tx,
      nodeId,
      [...resolved.rows, ...relations.rows, ...threads.rows],
      input.sceneText,
      sceneFactStatus(tx, nodeId)
    )
    const facts: ObservedFactsChange = {
      entityIds: diff.entityIds,
      added: diff.added,
      created: [...resolved.created, ...threads.created],
      skipped: resolved.skipped + relations.skipped + threads.skipped
    }

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
    // F-9.14: relationships and thread events are facts, logged and undone (hidden) as facts, so
    // the log's kinds stay the ones an older build can list.
    for (const added of facts.added) {
      changes.push({
        kind: 'fact',
        nodeId,
        quote: added.quote,
        entityId: added.entityId,
        targetId: added.id,
        label: factLabel(added, entities),
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
