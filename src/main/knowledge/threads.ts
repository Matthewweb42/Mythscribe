import { deriveThreads, THREAD_KIND, type ThreadView } from '@shared/threads'
import { listEntities } from '../entity/entityStore'
import { allFactsForEntities } from '../entity/factStore'
import type { TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'

/**
 * The Threads section's list (F-9.14, `thread:list`): every record in the thread category with
 * its events as of the end of the book, its derived status, setup, payoff, and open question
 * (`deriveThreads`). Reading order is the manuscript's (decision D2). Local and free.
 */
export function listThreads(db: TreeDb): ThreadView[] {
  const records = listEntities(db).filter((entity) => entity.kind === THREAD_KIND)
  const facts = allFactsForEntities(
    db,
    records.map((record) => record.id)
  )
  const order = manuscriptDocuments(db).map((row) => row.id)
  return deriveThreads(
    records.map((record) => ({ id: record.id, name: record.name, origin: record.origin })),
    facts,
    order
  )
}
