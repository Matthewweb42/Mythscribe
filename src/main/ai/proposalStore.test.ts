import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PROPOSAL_RETENTION_MAX } from '@shared/proposal'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { deleteNode, listNodes } from '../tree/treeStore'
import {
  createProposal,
  evictProposals,
  getProposal,
  proposalCount,
  settleProposal,
  type ProposalInput
} from './proposalStore'
import type { AiDb } from './usageStore'

let tmp: string
let session: ProjectSession
let db: AiDb
let scene: string

const input = (over: Partial<ProposalInput> = {}): ProposalInput => ({
  feature: 'ghostText',
  nodeId: scene,
  promptVersion: 'ghostText.v1',
  model: 'gpt-5.4-mini',
  promptTokens: 120,
  completionTokens: 12,
  costUsd: 0.0001,
  cached: false,
  content: ' Somewhere ahead the river was rising.',
  flagged: false,
  violation: null,
  ...over
})

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-proposal-'))
  session = createProject(projectFolderFor(tmp, 'Prop'), 'Prop', 'novel')
  db = session.connection.orm
  scene = listNodes(db).find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')?.id ?? ''
  if (!scene) throw new Error('skeleton not seeded')
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('proposalStore (F-14.5)', () => {
  it('creates a pending row with a minted id and timestamp, nullable columns defaulted', () => {
    const row = createProposal(db, input())
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(row).toMatchObject({
      feature: 'ghostText',
      nodeId: scene,
      promptVersion: 'ghostText.v1',
      model: 'gpt-5.4-mini',
      promptTokens: 120,
      completionTokens: 12,
      costUsd: 0.0001,
      cached: false,
      content: ' Somewhere ahead the river was rising.',
      flagged: false,
      violation: null,
      targetFrom: null,
      targetTo: null,
      status: 'pending',
      note: null,
      settledAt: null,
      regeneratedFrom: null
    })
    expect(getProposal(db, row.id)).toEqual(row)
    expect(proposalCount(db)).toBe(1)
  })

  it('keeps a tag batch as a JSON snapshot with no fidelity columns and links a regenerate to its predecessor', () => {
    const first = createProposal(db, input({ feature: 'tags', content: '["dark-forest"]' }))
    const second = createProposal(
      db,
      input({
        feature: 'tags',
        content: '["protagonist"]',
        flagged: null,
        regeneratedFrom: first.id
      })
    )
    expect(second.flagged).toBeNull()
    expect(second.regeneratedFrom).toBe(first.id)
  })

  it('stores a predecessor that is already gone as null instead of refusing the row', () => {
    const row = createProposal(db, input({ feature: 'tags', regeneratedFrom: 'evicted' }))
    expect(row.regeneratedFrom).toBeNull()
  })

  it('settles a pending row once with the status, the note, and a timestamp; later settlements are no-ops', () => {
    const row = createProposal(db, input())
    expect(settleProposal(db, row.id, 'rejected', 'Too purple.')).toBe(true)
    const settled = getProposal(db, row.id)
    expect(settled).toMatchObject({ status: 'rejected', note: 'Too purple.' })
    expect(settled?.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(settleProposal(db, row.id, 'accepted')).toBe(false)
    expect(getProposal(db, row.id)).toEqual(settled)
    expect(settleProposal(db, 'nope', 'accepted')).toBe(false)
  })

  it('settles without a note by default', () => {
    const row = createProposal(db, input())
    expect(settleProposal(db, row.id, 'acceptedPart')).toBe(true)
    expect(getProposal(db, row.id)).toMatchObject({ status: 'acceptedPart', note: null })
  })

  it('evicts the oldest rows once the cap is passed, keeping the newest rows whatever their status', () => {
    const stamp = (i: number): string =>
      `2026-09-14T${String(Math.floor(i / 3600)).padStart(2, '0')}:${String(Math.floor((i % 3600) / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`
    const ids: string[] = []
    for (let i = 0; i < PROPOSAL_RETENTION_MAX; i++) {
      ids.push(createProposal(db, input({ createdAt: stamp(i) })).id)
    }
    settleProposal(db, ids[0]!, 'accepted')
    expect(proposalCount(db)).toBe(PROPOSAL_RETENTION_MAX)
    const newest = createProposal(db, input({ createdAt: stamp(PROPOSAL_RETENTION_MAX) }))
    expect(proposalCount(db)).toBe(PROPOSAL_RETENTION_MAX)
    expect(getProposal(db, ids[0]!)).toBeUndefined()
    expect(getProposal(db, ids[1]!)).toBeDefined()
    expect(getProposal(db, newest.id)).toBeDefined()
  })

  it('evictProposals reports how many rows went and does nothing under the cap', () => {
    const a = createProposal(db, input({ createdAt: '2026-09-14T10:00:00.000Z' }))
    createProposal(db, input({ createdAt: '2026-09-14T10:00:01.000Z' }))
    const c = createProposal(db, input({ createdAt: '2026-09-14T10:00:02.000Z' }))
    expect(evictProposals(db)).toBe(0)
    expect(evictProposals(db, 2)).toBe(1)
    expect(getProposal(db, a.id)).toBeUndefined()
    expect(getProposal(db, c.id)).toBeDefined()
  })

  it('clears the node reference when the node goes and the predecessor link when that row is evicted', () => {
    const first = createProposal(db, input({ createdAt: '2026-09-14T10:00:00.000Z' }))
    const second = createProposal(
      db,
      input({ createdAt: '2026-09-14T10:00:01.000Z', regeneratedFrom: first.id })
    )
    deleteNode(db, scene)
    expect(getProposal(db, second.id)?.nodeId).toBeNull()
    expect(getProposal(db, second.id)?.regeneratedFrom).toBe(first.id)
    evictProposals(db, 1)
    expect(getProposal(db, first.id)).toBeUndefined()
    expect(getProposal(db, second.id)?.regeneratedFrom).toBeNull()
  })
})
