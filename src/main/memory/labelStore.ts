import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  LABEL_DEFAULT_COLOUR,
  LABELS_MAX,
  labelNameKey,
  type Label,
  type LabelKind,
  type LabelLink
} from '@shared/storyLabels'
import { label, labelLink, node, type LabelRow } from '../db/schema'
import { AppError } from '../ipc/errors'
import type { TreeDb } from '../tree/treeStore'

/**
 * The author's labels (F-16.7): the one writer of `label` and `label_link`. Names are unique
 * case-insensitively (`labelNameKey`); positions are 0-based and contiguous. The AI never calls
 * any of this (answer 2).
 */

const toLabel = (row: LabelRow): Label => ({
  id: row.id,
  name: row.name,
  colour: row.colour,
  kind: row.kind,
  position: row.position,
  created: row.created,
  modified: row.modified
})

export function listLabels(db: TreeDb): Label[] {
  return db.select().from(label).orderBy(asc(label.position)).all().map(toLabel)
}

function requireLabel(db: TreeDb, id: string): Label {
  const row = db.select().from(label).where(eq(label.id, id)).get()
  if (row === undefined) throw new AppError('NOT_FOUND', 'That label no longer exists', { id })
  return toLabel(row)
}

function refuseTakenName(db: TreeDb, name: string, exceptId: string | null): void {
  const key = labelNameKey(name)
  const taken = listLabels(db).find(
    (other) => other.id !== exceptId && labelNameKey(other.name) === key
  )
  if (taken !== undefined) {
    throw new AppError('ALREADY_EXISTS', `There is already a label called "${taken.name}"`, {
      name
    })
  }
}

export interface LabelInput {
  name: string
  kind: LabelKind
  colour?: string
}

export function createLabel(db: TreeDb, input: LabelInput, now: Date): Label {
  const name = input.name.normalize('NFC').trim().replace(/\s+/g, ' ')
  const existing = listLabels(db)
  if (existing.length >= LABELS_MAX) {
    throw new AppError('VALIDATION', `A project keeps at most ${LABELS_MAX} labels`)
  }
  refuseTakenName(db, name, null)
  const at = now.toISOString()
  const row: LabelRow = {
    id: randomUUID(),
    name,
    colour: input.colour ?? LABEL_DEFAULT_COLOUR[input.kind],
    kind: input.kind,
    position: existing.length,
    legacyTagId: null,
    created: at,
    modified: at
  }
  db.insert(label).values(row).run()
  return toLabel(row)
}

export function updateLabel(
  db: TreeDb,
  id: string,
  patch: { name?: string; colour?: string; kind?: LabelKind },
  now: Date
): Label {
  requireLabel(db, id)
  const name = patch.name?.normalize('NFC').trim().replace(/\s+/g, ' ')
  if (name !== undefined) refuseTakenName(db, name, id)
  db.update(label)
    .set({
      ...(name === undefined ? {} : { name }),
      ...(patch.colour === undefined ? {} : { colour: patch.colour }),
      ...(patch.kind === undefined ? {} : { kind: patch.kind }),
      modified: now.toISOString()
    })
    .where(eq(label.id, id))
    .run()
  return requireLabel(db, id)
}

/** Deletes a label and its links; the others close up. Answers the list. */
export function deleteLabel(db: TreeDb, id: string): Label[] {
  requireLabel(db, id)
  db.transaction((tx) => {
    tx.delete(label).where(eq(label.id, id)).run()
    listLabels(tx).forEach((row, position) => {
      if (row.position !== position) {
        tx.update(label).set({ position }).where(eq(label.id, row.id)).run()
      }
    })
  })
  return listLabels(db)
}

/** Puts the labels in this order; `ids` must be every label exactly once. Answers the list. */
export function reorderLabels(db: TreeDb, ids: readonly string[]): Label[] {
  const current = listLabels(db).map((row) => row.id)
  if (
    ids.length !== current.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !current.includes(id))
  ) {
    throw new AppError('VALIDATION', 'The new order must list every label once')
  }
  db.transaction((tx) => {
    ids.forEach((id, position) => {
      tx.update(label).set({ position }).where(eq(label.id, id)).run()
    })
  })
  return listLabels(db)
}

/** A scene or document a label may be put on: any node but a section root. */
function requireLabelTarget(db: TreeDb, nodeId: string): void {
  const row = db.select({ parentId: node.parentId }).from(node).where(eq(node.id, nodeId)).get()
  if (row === undefined)
    throw new AppError('NOT_FOUND', 'That document no longer exists', { nodeId })
  if (row.parentId === null) throw new AppError('VALIDATION', 'A section cannot carry a label')
}

/** The labels of one node, in label order. */
export function labelsForNode(db: TreeDb, nodeId: string): Label[] {
  const ids = db
    .select({ labelId: labelLink.labelId })
    .from(labelLink)
    .where(eq(labelLink.nodeId, nodeId))
    .all()
    .map((row) => row.labelId)
  if (ids.length === 0) return []
  return db
    .select()
    .from(label)
    .where(inArray(label.id, ids))
    .orderBy(asc(label.position))
    .all()
    .map(toLabel)
}

/** The nodes that carry a label. */
export function nodesOfLabel(db: TreeDb, labelId: string): string[] {
  return db
    .select({ nodeId: labelLink.nodeId })
    .from(labelLink)
    .where(eq(labelLink.labelId, labelId))
    .all()
    .map((row) => row.nodeId)
}

/** Every label link, by node then label order: what the renderer's chips and filters read. */
export function listLabelLinks(db: TreeDb): LabelLink[] {
  return db
    .select({ labelId: labelLink.labelId, nodeId: labelLink.nodeId })
    .from(labelLink)
    .innerJoin(label, eq(label.id, labelLink.labelId))
    .orderBy(asc(labelLink.nodeId), asc(label.position))
    .all()
}

/** Puts a label on a node (once). Answers the node's labels. */
export function assignLabel(db: TreeDb, labelId: string, nodeId: string): Label[] {
  requireLabel(db, labelId)
  requireLabelTarget(db, nodeId)
  db.insert(labelLink).values({ labelId, nodeId }).onConflictDoNothing().run()
  return labelsForNode(db, nodeId)
}

/** Takes a label off a node. Answers the node's labels. */
export function unassignLabel(db: TreeDb, labelId: string, nodeId: string): Label[] {
  db.delete(labelLink)
    .where(and(eq(labelLink.labelId, labelId), eq(labelLink.nodeId, nodeId)))
    .run()
  return labelsForNode(db, nodeId)
}
