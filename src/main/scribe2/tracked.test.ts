import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEdit } from '@shared/agent'
import { createProposal } from '../ai/proposalStore'
import {
  createPass,
  createScribePass,
  evictPasses,
  isScribePass,
  listPassRows,
  pendingChangesFor,
  settleChanges,
  updatePass
} from '../editPass/editPassStore'
import { createFlowRun, listFlowRuns } from '../editFlow/flowStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { SCRIBE_TRACKED_RATIONALE, trackScribeProposals } from './tracked'

let tmp: string
let session: ProjectSession
let db: TreeDb
let scene: string
let proposalId: string

const TEXT = 'Mara climbed the ridge alone. Below the ridge the sea lay flat as hammered tin.'

const prose = (find: string, replace: string): AgentEdit => ({
  kind: 'text',
  nodeId: scene,
  title: 'Scene 1',
  find,
  replace,
  brief: ''
})

const note: AgentEdit = {
  kind: 'notebook',
  pageId: 'pg-1',
  title: 'Mara',
  created: false,
  versionId: 'v-1',
  section: null,
  before: 'a',
  after: 'b'
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-scribe-tracked-'))
  session = createProject(projectFolderFor(tmp, 'Tracked'), 'Tracked', 'novel')
  db = session.connection.orm
  scene = listNodes(db).find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')?.id ?? ''
  if (!scene) throw new Error('skeleton not seeded')
  proposalId = createProposal(db, {
    feature: 'scribe',
    nodeId: scene,
    promptVersion: 'scribe.v3',
    model: 'deepseek-v4-pro',
    promptTokens: 100,
    completionTokens: 10,
    costUsd: 0.001,
    cached: false,
    content: '{}',
    flagged: false,
    violation: null
  }).id
})

afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('trackScribeProposals (notes fixes, 2026-10-15)', () => {
  it('writes each prose suggestion as a pending tracked change of one hidden row, in order', () => {
    const ids = trackScribeProposals(
      db,
      [
        { edit: note, violation: null, applied: true },
        {
          edit: prose('the sea lay flat', 'the sea lay still'),
          violation: 'Too long.',
          applied: false
        },
        { edit: prose('Mara climbed the ridge alone.', ''), violation: null, applied: false }
      ],
      proposalId,
      () => TEXT
    )
    expect(ids[0]).toBeNull()
    expect(ids[1]).toEqual(expect.any(String))
    expect(ids[2]).toEqual(expect.any(String))
    const rows = listPassRows(db)
    expect(rows).toHaveLength(1)
    expect(isScribePass(rows[0]!)).toBe(true)
    expect(rows[0]).toMatchObject({ status: 'done', instruction: null })

    // The editor's list for the scene holds them, as an edit pass's own.
    const pending = pendingChangesFor(db, scene)
    expect(pending.map((change) => change.id)).toEqual([ids[1], ids[2]])
    expect(pending[0]).toMatchObject({
      kind: 'change',
      original: 'the sea lay flat',
      replacement: 'the sea lay still',
      rationale: SCRIBE_TRACKED_RATIONALE,
      flagged: true,
      violation: 'Too long.',
      proposalId,
      position: TEXT.indexOf('the sea lay flat')
    })
    expect(pending[1]).toMatchObject({ replacement: '', position: 0 })

    // Settled like any tracked change.
    expect(settleChanges(db, [ids[1]!], 'accepted').map((c) => c.status)).toEqual(['accepted'])
    expect(pendingChangesFor(db, scene).map((change) => change.id)).toEqual([ids[2]])
  })

  it('writes nothing for a turn with no prose suggestion', () => {
    expect(
      trackScribeProposals(
        db,
        [{ edit: note, violation: null, applied: true }],
        proposalId,
        () => TEXT
      )
    ).toEqual([null])
    expect(listPassRows(db)).toHaveLength(0)
  })

  it('is neither an edit-flow run nor counted against the passes’ cap, and keeps its own', () => {
    const flow = createFlowRun(db, {
      spec: { categories: ['copy'], depth: 'quick', scope: { kind: 'scene', nodeId: scene } },
      scopeTitle: 'Scene 1',
      nodeIds: [scene],
      total: 1,
      now: '2026-10-15T09:00:00.000Z'
    })
    updatePass(db, flow.id, { status: 'done' })
    trackScribeProposals(
      db,
      [{ edit: prose('the sea lay flat', 'the sea lay still'), violation: null, applied: false }],
      proposalId,
      () => TEXT,
      '2026-10-15T10:00:00.000Z'
    )
    expect(listFlowRuns(db)).toHaveLength(1)

    // Two edit passes with a cap of two: the flow run (the oldest) goes; Ms Scribe's row stays.
    for (const hour of ['11', '12']) {
      createPass(db, {
        type: 'line',
        instruction: null,
        nodeIds: [scene],
        now: `2026-10-15T${hour}:00:00.000Z`
      })
    }
    evictPasses(db, 2)
    const rows = listPassRows(db)
    expect(rows.filter((row) => isScribePass(row))).toHaveLength(1)
    expect(listFlowRuns(db)).toHaveLength(0)

    // Her own cap: the oldest of her rows goes, with its changes.
    createScribePass(db, [scene], '2026-10-15T13:00:00.000Z', 1)
    expect(listPassRows(db).filter((row) => isScribePass(row))).toHaveLength(1)
    expect(pendingChangesFor(db, scene)).toHaveLength(0)
    expect(listPassRows(db).filter((row) => !isScribePass(row))).toHaveLength(2)
  })
})
