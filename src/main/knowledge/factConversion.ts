import { randomUUID } from 'node:crypto'
import { asc, gt, sql } from 'drizzle-orm'
import { parseEntityFields } from '@shared/entities'
import { aiFactKey } from '@shared/facts'
import { KNOWLEDGE_FACTS_VERSION } from '@shared/knowledge'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import { entity, fact, node, observedFact } from '../db/schema'
import type { EntityDb } from '../entity/entityStore'
import { syncAuthorBaseline } from '../entity/factStore'
import { getKnowledgeModel, setKnowledgeModel } from '../project/settingsStore'

/**
 * F-9.13's conversion, run on every project open (local, free, idempotent):
 *
 * - The F-5.16 observed facts are copied into `fact` as AI facts (hidden ones stay hidden; a
 *   fact of a scene the author marked Idea is an idea, D7). The first open copies them all; every
 *   later open copies the rows an older build wrote since (`knowledgeModel.factsImportedAt`),
 *   because `observed_fact` stays and an older build still writes it (D9).
 * - Every record's sheet text is mirrored as undated author facts (`syncAuthorBaseline`), so an
 *   edit an older build made straight to `entity.fields` is picked up too.
 *
 * Only `fact` and the settings row are written. Scene text is never read or changed.
 */

export interface FactConversion {
  /** Observed facts read since the last open (a copy already held keeps its row, its hidden flag merged). */
  imported: number
  /** Baseline author facts written, changed, or removed to match the sheets. */
  reconciled: number
}

export function convertKnowledgeFacts(db: EntityDb): FactConversion {
  return db.transaction((tx) => {
    const state = getKnowledgeModel(tx)
    const since = state.factsImportedAt
    const rows = tx
      .select()
      .from(observedFact)
      .where(since === '' ? undefined : gt(observedFact.createdAt, since))
      .orderBy(asc(observedFact.createdAt), asc(observedFact.id))
      .all()
    const idea = new Set(
      tx
        .select({ id: node.id, sceneMeta: node.sceneMeta })
        .from(node)
        .all()
        .filter((row) => parseStoredSceneMeta(row.sceneMeta).status === 'idea')
        .map((row) => row.id)
    )
    let imported = 0
    let newest = since
    for (const row of rows) {
      if (row.createdAt > newest) newest = row.createdAt
      tx.insert(fact)
        .values({
          id: randomUUID(),
          entityId: row.entityId,
          attribute: row.attribute,
          value: row.value,
          nodeId: row.nodeId,
          quote: row.quote,
          origin: 'ai',
          status: idea.has(row.nodeId) ? 'idea' : 'canon',
          hidden: row.hidden,
          factKey: aiFactKey(row.nodeId, row.attribute, row.value),
          createdAt: row.createdAt,
          updatedAt: row.createdAt
        })
        .onConflictDoUpdate({
          target: [fact.entityId, fact.factKey],
          // Hidden in either build stays hidden: a tombstone is never lifted by a copy.
          set: { hidden: sql`max(${fact.hidden}, excluded.hidden)` }
        })
        .run()
      imported += 1
    }

    let reconciled = 0
    for (const each of tx.select({ id: entity.id, fields: entity.fields }).from(entity).all()) {
      reconciled += syncAuthorBaseline(tx, each.id, parseEntityFields(each.fields))
    }

    if (state.facts < KNOWLEDGE_FACTS_VERSION || newest !== since) {
      setKnowledgeModel(tx, { facts: KNOWLEDGE_FACTS_VERSION, factsImportedAt: newest })
    }
    return { imported, reconciled }
  })
}
