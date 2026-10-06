import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { continuityDedupeKey, type ContinuityRef } from '@shared/continuity'
import { createEntity, deleteEntity } from '../entity/entityStore'
import { AppError } from '../ipc/errors'
import { projectFolderFor, type ProjectSession } from '../project/projectStore'
import { createSeededProject } from '../project/testProject'
import { deleteNode, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import {
  deleteFindings,
  dismissedKeys,
  insertFindings,
  listOpenFindings,
  openFindingsForNode,
  proposalFindingStatuses,
  settleFinding,
  type FindingInput
} from './continuityFindingStore'
import { createProposal } from './proposalStore'

let tmp: string
let session: ProjectSession
let db: TreeDb
let first: string
let second: string
let mara: string

const ageRef = (value = '34'): ContinuityRef => ({
  kind: 'sheet',
  entityId: mara,
  entityName: 'Mara',
  entityKind: 'character',
  attribute: 'age',
  label: 'Age',
  value,
  nodeId: null,
  quote: null
})

const input = (over: Partial<FindingInput> = {}): FindingInput => ({
  ref: ageRef(),
  quote: 'Mara was twenty-nine that winter.',
  why: 'The sheet gives her age as 34.',
  fix: 'Mara was thirty-four that winter.',
  flagged: false,
  violation: null,
  ...over
})

const stamp = (createdAt: string, proposalId: string | null = null) =>
  ({ origin: 'request', proposalId, createdAt }) as const

const proposal = (): string =>
  createProposal(db, {
    feature: 'continuity',
    nodeId: first,
    promptVersion: 'continuity.v1',
    model: 'gpt-fake',
    promptTokens: 1,
    completionTokens: 1,
    costUsd: 0,
    cached: false,
    content: '[]',
    flagged: false,
    violation: null
  }).id

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-findings-'))
  session = createSeededProject(projectFolderFor(tmp, 'Findings'), 'Findings', 'novel')
  db = session.connection.orm
  const documents = manuscriptDocuments(db)
  first = documents[0]?.id ?? ''
  second = documents[1]?.id ?? ''
  if (!first || !second) throw new Error('skeleton not seeded')
  mara = createEntity(db, { kind: 'character', name: 'Mara' }).entity.id
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('continuityFindingStore (F-13.4)', () => {
  it('stores a run’s findings as open rows with both citations and answers them as stored', () => {
    const factRef: ContinuityRef = {
      ...ageRef('thirty-four'),
      kind: 'fact',
      nodeId: second,
      quote: 'She was thirty-four.'
    }
    const stored = insertFindings(
      db,
      first,
      [input(), input({ ref: factRef, fix: null, flagged: true, violation: 'Uses "suddenly".' })],
      { origin: 'background', proposalId: null, createdAt: '2026-10-02T10:00:00.000Z' }
    )
    expect(stored).toHaveLength(2)
    expect(stored[0]).toEqual({
      id: stored[0]?.id,
      nodeId: first,
      ref: ageRef(),
      quote: 'Mara was twenty-nine that winter.',
      why: 'The sheet gives her age as 34.',
      fix: 'Mara was thirty-four that winter.',
      flagged: false,
      violation: null,
      status: 'open',
      origin: 'background',
      proposalId: null,
      createdAt: '2026-10-02T10:00:00.000Z'
    })
    expect(stored[1]).toMatchObject({
      ref: factRef,
      fix: null,
      flagged: true,
      violation: 'Uses "suddenly".'
    })
    expect(openFindingsForNode(db, first)).toEqual(stored)
    expect(insertFindings(db, first, [], stamp('2026-10-02T10:00:00.000Z'))).toEqual([])
  })

  it('lists the open findings in reading order of their scenes, oldest first within a scene', () => {
    const late = insertFindings(db, second, [input()], stamp('2026-10-02T09:00:00.000Z'))
    const early = insertFindings(
      db,
      first,
      [input({ quote: 'one' }), input({ quote: 'two' })],
      stamp('2026-10-02T10:00:00.000Z')
    )
    const older = insertFindings(
      db,
      first,
      [input({ quote: 'zero' })],
      stamp('2026-10-01T10:00:00.000Z')
    )
    expect(listOpenFindings(db).map((finding) => finding.id)).toEqual(
      [...older, ...early, ...late].map((finding) => finding.id)
    )
  })

  it('settles a finding, takes it off the open list, and remembers a dismissal by its dedupe key', () => {
    const [age, eyes] = insertFindings(
      db,
      first,
      [input(), input({ ref: { ...ageRef('Grey eyes'), attribute: 'appearance' } })],
      stamp('2026-10-02T10:00:00.000Z')
    )
    expect(dismissedKeys(db, first).size).toBe(0)
    expect(settleFinding(db, age?.id ?? '', 'dismissed')).toEqual({ ...age, status: 'dismissed' })
    expect(settleFinding(db, eyes?.id ?? '', 'applied')).toEqual({ ...eyes, status: 'applied' })
    expect(listOpenFindings(db)).toEqual([])
    // Only the dismissal is a tombstone, and only for its own scene.
    expect([...dismissedKeys(db, first)]).toEqual([continuityDedupeKey(first, ageRef())])
    expect(dismissedKeys(db, second).size).toBe(0)
  })

  it('refuses to settle an unknown finding with NOT_FOUND', () => {
    expect(() => settleFinding(db, 'missing', 'dismissed')).toThrowError(AppError)
    try {
      settleFinding(db, 'missing', 'dismissed')
    } catch (err) {
      expect(err).toMatchObject({ code: 'NOT_FOUND' })
    }
  })

  it('deletes by id and reports the statuses left for a proposal', () => {
    const id = proposal()
    const [a, b, c] = insertFindings(
      db,
      first,
      [input({ quote: 'a' }), input({ quote: 'b' }), input({ quote: 'c' })],
      stamp('2026-10-02T10:00:00.000Z', id)
    )
    settleFinding(db, a?.id ?? '', 'applied')
    deleteFindings(db, [b?.id ?? '', 'missing'])
    deleteFindings(db, [])
    expect(proposalFindingStatuses(db, id).sort()).toEqual(['applied', 'open'])
    expect(openFindingsForNode(db, first)).toEqual([c])
    expect(proposalFindingStatuses(db, 'other')).toEqual([])
  })

  it('loses a scene’s findings with the scene and an entity’s with the entity', () => {
    insertFindings(db, first, [input()], stamp('2026-10-02T10:00:00.000Z'))
    insertFindings(db, second, [input()], stamp('2026-10-02T10:00:00.000Z'))
    deleteNode(db, second)
    expect(listOpenFindings(db).map((finding) => finding.nodeId)).toEqual([first])
    deleteEntity(db, mara)
    expect(listOpenFindings(db)).toEqual([])
  })
})
