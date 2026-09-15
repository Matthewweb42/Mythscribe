import { parseStoredSceneMeta, renderSceneBriefBlock, type SceneBrief } from '@shared/sceneMeta'
import type { NodeRow } from '../db/schema'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'

/** A scene's brief and the two briefs around it (F-14.3); each neighbour is null at an edge. */
export interface SceneNeighbourBriefs {
  current: SceneBrief
  previous: SceneBrief | null
  next: SceneBrief | null
}

const briefOf = (row: NodeRow | undefined): SceneBrief | null =>
  row === undefined ? null : parseStoredSceneMeta(row.sceneMeta).brief

/**
 * The briefs (F-14.3) of a node and of the manuscript documents each side of it in reading
 * order, regardless of chapter boundaries: that is the sequence the reader meets. A node that
 * is not a manuscript document (a folder, a document outside the manuscript) has no
 * neighbours — only its own brief, which folders carry like the rest of the metadata. An
 * unknown id reads as an empty brief, never a throw: a prompt must not fail over metadata.
 */
export function sceneNeighbours(db: TreeDb, nodeId: string): SceneNeighbourBriefs {
  const documents = manuscriptDocuments(db)
  const index = documents.findIndex((row) => row.id === nodeId)
  const current = index === -1 ? undefined : documents[index]
  if (current === undefined) {
    const own = listNodes(db).find((row) => row.id === nodeId)
    return { current: briefOf(own) ?? parseStoredSceneMeta(null).brief, previous: null, next: null }
  }
  return {
    current: parseStoredSceneMeta(current.sceneMeta).brief,
    previous: briefOf(documents[index - 1]),
    next: briefOf(documents[index + 1])
  }
}

/**
 * The scene-brief prompt block (F-14.3) for a node, or null when neither it nor its
 * neighbours have anything to say. Every prompt that carries a brief builds it through here,
 * so ghost text, the assistant, and the editor's notes all read the same block.
 */
export function sceneBriefBlock(db: TreeDb, nodeId: string): string | null {
  return renderSceneBriefBlock(sceneNeighbours(db, nodeId))
}
