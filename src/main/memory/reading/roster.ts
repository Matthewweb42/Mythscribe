import { eq } from 'drizzle-orm'
import { settings } from '../../db/schema'
import type { TreeDb } from '../../tree/treeStore'

/**
 * The reader's roster cache (F-16.17; plan P2a §2.5): a settings row (`memoryRoster`) keeps the
 * roster prefix of the reader (`reader.v2`) byte for byte across calls, so the provider's prompt cache holds.
 * `rosterCache.ts` builds and appends to it; a removal, rename, merge, split, *Rebuild memory* or a
 * new reader version rebuilds it, which here means dropping the row so the next reading builds it
 * afresh.
 */
export const MEMORY_ROSTER_KEY = 'memoryRoster'

/** Marks the roster for a rebuild: the next reading builds it from the records as they are. */
export function markRosterForRebuild(db: TreeDb): void {
  db.delete(settings).where(eq(settings.key, MEMORY_ROSTER_KEY)).run()
}
