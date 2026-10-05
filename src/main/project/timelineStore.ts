import { eq, isNotNull } from 'drizzle-orm'
import { parseStoredSceneMeta, type SceneMeta } from '@shared/sceneMeta'
import { TIMELINE_KEY, ProjectTimeline, eventText } from '@shared/timeline'
import { node, settings } from '../db/schema'
import { AppError } from '../ipc/errors'
import type { TreeDb } from '../tree/treeStore'

/** What `timeline:set` answers: the stored timeline and the nodes whose metadata it rewrote. */
export interface TimelineSetResult {
  timeline: ProjectTimeline
  changedNodeIds: string[]
}

/**
 * Replaces the project's timeline (F-11.2) and keeps every linked scene in step, in one
 * transaction. For each node whose stored scene metadata carries an `eventId`: an event that is
 * gone drops the link and keeps the scene's timeline text as it was (the author's words stay); an
 * event whose `eventText` differs from the scene's text rewrites the text. Rewritten rows get a
 * new `modified` stamp, like `setSceneMeta`. An unlinked node is never touched. A value outside
 * the schema (a blank label, a duplicate id or label, over a cap) is refused with VALIDATION and
 * nothing is written. `getProjectTimeline` (`settingsStore.ts`) is the read path.
 */
export function setProjectTimeline(db: TreeDb, value: ProjectTimeline): TimelineSetResult {
  const parsed = ProjectTimeline.safeParse(value)
  if (!parsed.success) {
    throw new AppError('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid timeline')
  }
  const timeline = parsed.data
  const byId = new Map(timeline.events.map((event) => [event.id, event]))
  const serialized = JSON.stringify(timeline)
  return db.transaction((tx) => {
    tx.insert(settings)
      .values({ key: TIMELINE_KEY, value: serialized })
      .onConflictDoUpdate({ target: settings.key, set: { value: serialized } })
      .run()
    const rows = tx
      .select({ id: node.id, sceneMeta: node.sceneMeta })
      .from(node)
      .where(isNotNull(node.sceneMeta))
      .all()
    const modified = new Date().toISOString()
    const changedNodeIds: string[] = []
    for (const row of rows) {
      const meta = parseStoredSceneMeta(row.sceneMeta)
      if (meta.eventId === undefined) continue
      const event = byId.get(meta.eventId)
      let next: SceneMeta
      if (event === undefined) {
        next = { ...meta }
        delete next.eventId
      } else {
        const text = eventText(event)
        if (meta.timeline === text) continue
        next = { ...meta, timeline: text }
      }
      tx.update(node)
        .set({ sceneMeta: JSON.stringify(next), modified })
        .where(eq(node.id, row.id))
        .run()
      changedNodeIds.push(row.id)
    }
    return { timeline, changedNodeIds }
  })
}
