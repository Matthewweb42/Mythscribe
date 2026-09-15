import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StoredSceneSummary } from '@shared/summary'
import { node, sceneSummary, type NodeRow } from '../db/schema'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { deleteSummary, getSummary, summariesFor, upsertSummary } from './summaryStore'

let tmp: string
let session: ProjectSession
let db: TreeDb

function documents(): NodeRow[] {
  return listNodes(db).filter((row) => row.kind === 'document' && row.sectionType === null)
}

function scene(index = 0): NodeRow {
  const row = documents()[index]
  if (!row) throw new Error(`no document at ${index}`)
  return row
}

const summaryFor = (nodeId: string): StoredSceneSummary => ({
  nodeId,
  summary: 'Mara meets Tomas at the ferry landing and tells him where her brother is.',
  keyPoints: ['Tomas wants the copied ledger', 'Mara names the north pasture'],
  characters: ['Mara', 'Tomas'],
  contentHash: 'hash-1',
  promptVersion: 'summary.v1',
  model: 'gpt-fast',
  truncated: false,
  createdAt: '2026-09-15T00:00:00.000Z'
})

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-summary-'))
  session = createProject(projectFolderFor(tmp, 'Summaries'), 'Summaries', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('summaryStore (F-5.6)', () => {
  it('has no summary for a scene that was never summarised', () => {
    expect(getSummary(db, scene().id)).toBeNull()
    expect(getSummary(db, 'nope')).toBeNull()
  })

  it('round-trips a summary with its key points and characters', () => {
    const row = summaryFor(scene().id)
    upsertSummary(db, row)
    expect(getSummary(db, scene().id)).toEqual(row)
  })

  it('replaces the row when the scene is summarised again, keeping one row per node', () => {
    const first = summaryFor(scene().id)
    upsertSummary(db, first)
    const second: StoredSceneSummary = {
      ...first,
      summary: 'Mara leaves Tomas on the boards.',
      keyPoints: [],
      characters: ['Mara'],
      contentHash: 'hash-2',
      truncated: true,
      createdAt: '2026-09-15T01:00:00.000Z'
    }
    upsertSummary(db, second)
    expect(getSummary(db, scene().id)).toEqual(second)
    expect(db.select().from(sceneSummary).all()).toHaveLength(1)
  })

  it('deletes a summary, and says nothing about a node that has none', () => {
    upsertSummary(db, summaryFor(scene().id))
    deleteSummary(db, scene().id)
    expect(getSummary(db, scene().id)).toBeNull()
    expect(() => deleteSummary(db, 'nope')).not.toThrow()
  })

  it('goes with the scene: deleting the node drops its summary', () => {
    const id = scene().id
    upsertSummary(db, summaryFor(id))
    db.delete(node).where(eq(node.id, id)).run()
    expect(db.select().from(sceneSummary).all()).toHaveLength(0)
  })

  it('reads several nodes in one query, skipping the ids with no row', () => {
    const [first, second] = [scene(0), scene(1)]
    upsertSummary(db, summaryFor(first.id))
    const found = summariesFor(db, [first.id, second?.id ?? 'nope', 'missing'])
    expect([...found.keys()]).toEqual([first.id])
    expect(found.get(first.id)?.summary).toBe(summaryFor(first.id).summary)
    expect(summariesFor(db, []).size).toBe(0)
  })

  it('reads a corrupt row as no summary, so a fresh run replaces it', () => {
    const id = scene().id
    upsertSummary(db, summaryFor(id))
    db.update(sceneSummary).set({ keyPoints: '{not json' }).where(eq(sceneSummary.nodeId, id)).run()
    expect(getSummary(db, id)).toBeNull()
    expect(summariesFor(db, [id]).size).toBe(0)
  })
})
