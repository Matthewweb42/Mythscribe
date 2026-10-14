import { eq, inArray, isNotNull } from 'drizzle-orm'
import type { z } from 'zod'
import { emptySceneDetails, SceneDetails, type SceneDetailsView } from '@shared/memory/sceneDetails'
import { record, sceneDetail, type SceneDetailRow } from '../db/schema'
import { AppError } from '../ipc/errors'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { manuscriptRootId } from '../voice/voiceJob'

/**
 * Typed scene details (F-16.11): the one writer of `scene_detail`. Any node under the manuscript
 * root may carry them (a scene, a chapter, a part, as scene meta does); the records they name
 * must exist when saved.
 */

function parseAlsoHere(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/**
 * A stored row read field by field: a column that does not parse reads as empty on its own, so
 * one bad value never hides the others.
 */
function toDetails(row: SceneDetailRow): SceneDetails {
  const shape = SceneDetails.shape
  const empty = emptySceneDetails()
  const read = <T>(schema: z.ZodType<T>, value: unknown, fallback: T): T => {
    const parsed = schema.safeParse(value)
    return parsed.success ? parsed.data : fallback
  }
  return {
    povRecordId: read(shape.povRecordId, row.povRecordId, empty.povRecordId),
    place: {
      recordId: read(shape.place.shape.recordId, row.placeRecordId, empty.place.recordId),
      text: read(shape.place.shape.text, row.placeText, empty.place.text)
    },
    time: { text: read(shape.time.shape.text, row.timeText, empty.time.text) },
    storyYear: read(shape.storyYear, row.storyYear, empty.storyYear),
    alsoHere: read(shape.alsoHere, parseAlsoHere(row.alsoHere), empty.alsoHere),
    flashback: read(shape.flashback, row.flashback, empty.flashback)
  }
}

/** Whether `nodeId` is under the manuscript root (the root itself excluded). */
function isManuscriptNode(db: TreeDb, nodeId: string): boolean {
  const root = manuscriptRootId(db)
  if (root === null || nodeId === root) return false
  const parents = new Map(listNodes(db).map((row) => [row.id, row.parentId]))
  let at: string | null | undefined = parents.get(nodeId)
  while (at !== undefined && at !== null) {
    if (at === root) return true
    at = parents.get(at)
  }
  return false
}

function requireTarget(db: TreeDb, nodeId: string): void {
  if (!isManuscriptNode(db, nodeId)) {
    throw new AppError(
      'NOT_FOUND',
      'Scene details belong to a scene, chapter or part of the manuscript',
      {
        nodeId
      }
    )
  }
}

/** The ids among `ids` that name a record. */
function existingRecords(db: TreeDb, ids: readonly string[]): Set<string> {
  if (ids.length === 0) return new Set()
  return new Set(
    db
      .select({ id: record.id })
      .from(record)
      .where(inArray(record.id, [...ids]))
      .all()
      .map((row) => row.id)
  )
}

/**
 * A node's stored details, empty when it has none or is no manuscript node (no target check):
 * what the Story notes block and the v2 prompts' scene line read for any open document.
 */
export function storedSceneDetails(db: TreeDb, nodeId: string): SceneDetails {
  const row = db.select().from(sceneDetail).where(eq(sceneDetail.nodeId, nodeId)).get()
  return row === undefined ? emptySceneDetails() : toDetails(row)
}

/**
 * Every node's stored details, by node, in one read (the Timeline reads the typed year, time and
 * Here of every scene, F-16.23); a node with none is not in the map.
 */
export function allSceneDetails(db: TreeDb): Map<string, SceneDetails> {
  return new Map(
    db
      .select()
      .from(sceneDetail)
      .all()
      .map((row) => [row.nodeId, toDetails(row)])
  )
}

/**
 * The nodes whose Flashback switch is set, with its answer (null rows left out), in one small read:
 * what loose ends read when they hold no details (`sceneFlashback` takes it with the card).
 */
export function typedFlashbacks(db: TreeDb): Map<string, boolean> {
  return new Map(
    db
      .select({ nodeId: sceneDetail.nodeId, flashback: sceneDetail.flashback })
      .from(sceneDetail)
      .where(isNotNull(sceneDetail.flashback))
      .all()
      .map((row) => [row.nodeId, row.flashback === true])
  )
}

/** A node's details (empty when it has none), with the "+ also here" ids whose record is gone. */
export function getSceneDetails(db: TreeDb, nodeId: string): SceneDetailsView {
  requireTarget(db, nodeId)
  const row = db.select().from(sceneDetail).where(eq(sceneDetail.nodeId, nodeId)).get()
  const details = row === undefined ? emptySceneDetails() : toDetails(row)
  const present = existingRecords(db, details.alsoHere)
  return { ...details, gone: details.alsoHere.filter((id) => !present.has(id)) }
}

/** Saves a node's details; every record they name must exist. */
export function setSceneDetails(
  db: TreeDb,
  nodeId: string,
  details: SceneDetails,
  now: Date
): SceneDetailsView {
  requireTarget(db, nodeId)
  const alsoHere = [...new Set(details.alsoHere)]
  const named = [details.povRecordId, details.place.recordId, ...alsoHere].filter(
    (id): id is string => id !== null
  )
  const present = existingRecords(db, named)
  const missing = named.filter((id) => !present.has(id))
  if (missing.length > 0) {
    throw new AppError('VALIDATION', 'A record in these details no longer exists', { missing })
  }
  const row: SceneDetailRow = {
    nodeId,
    povRecordId: details.povRecordId,
    placeRecordId: details.place.recordId,
    placeText: details.place.text.trim(),
    timeText: details.time.text.trim(),
    storyYear: details.storyYear,
    alsoHere: JSON.stringify(alsoHere),
    modified: now.toISOString(),
    flashback: details.flashback
  }
  db.insert(sceneDetail)
    .values(row)
    .onConflictDoUpdate({ target: sceneDetail.nodeId, set: { ...row } })
    .run()
  return getSceneDetails(db, nodeId)
}

/** Whether any scene's details point at the record (as POV, place or "+ also here"). */
export function recordInDetails(db: TreeDb, recordId: string): boolean {
  return db
    .select({
      nodeId: sceneDetail.nodeId,
      alsoHere: sceneDetail.alsoHere,
      pov: sceneDetail.povRecordId,
      place: sceneDetail.placeRecordId
    })
    .from(sceneDetail)
    .all()
    .some(
      (row) =>
        row.pov === recordId ||
        row.place === recordId ||
        parseAlsoHere(row.alsoHere).includes(recordId)
    )
}

/** The typed POV of a node, for the name scan's shared-alias rule; null without one. */
export function povOf(db: TreeDb, nodeId: string): string | null {
  return (
    db
      .select({ pov: sceneDetail.povRecordId })
      .from(sceneDetail)
      .where(eq(sceneDetail.nodeId, nodeId))
      .get()?.pov ?? null
  )
}
