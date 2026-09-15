import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptySceneMeta, type SceneBrief } from '@shared/sceneMeta'
import { node, type NodeRow } from '../db/schema'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { setSceneMeta } from './sceneMetaStore'
import { sceneBriefBlock, sceneNeighbours } from './sceneNeighbours'

let tmp: string
let session: ProjectSession
let db: TreeDb
/** The six seeded scenes, in reading order (Part 1 → Chapter 1–3, Part 2 → Chapter 1–3). */
let scenes: NodeRow[]

const brief = (over: Partial<SceneBrief> = {}): SceneBrief => ({
  ...emptySceneMeta().brief,
  ...over
})

/** Writes a brief onto a node through the store, leaving the rest of its metadata alone. */
function setBrief(id: string, over: Partial<SceneBrief>): void {
  setSceneMeta(db, id, { ...emptySceneMeta(), brief: brief(over) })
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-neighbours-'))
  session = createProject(projectFolderFor(tmp, 'Briefs'), 'Briefs', 'novel')
  db = session.connection.orm
  scenes = manuscriptDocuments(db)
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('manuscriptDocuments in reading order (F-14.3)', () => {
  it('walks the seeded skeleton in tree order, across chapter and part boundaries', () => {
    const titled = scenes.map((row) => {
      const rows = listNodes(db)
      const chapter = rows.find((r) => r.id === row.parentId)
      const part = rows.find((r) => r.id === chapter?.parentId)
      return `${part?.title ?? '?'} / ${chapter?.title ?? '?'}`
    })
    expect(titled).toEqual([
      'Part 1 / Chapter 1',
      'Part 1 / Chapter 2',
      'Part 1 / Chapter 3',
      'Part 2 / Chapter 1',
      'Part 2 / Chapter 2',
      'Part 2 / Chapter 3'
    ])
  })

  it('leaves out documents outside the manuscript', () => {
    const front = listNodes(db).find((r) => r.sectionType === 'front')
    if (!front) throw new Error('no front section')
    const now = new Date().toISOString()
    db.insert(node)
      .values({
        id: 'matter-1',
        parentId: front.id,
        kind: 'document',
        title: 'Dedication',
        position: 0,
        created: now,
        modified: now
      })
      .run()
    expect(manuscriptDocuments(db).map((r) => r.id)).not.toContain('matter-1')
  })
})

describe('sceneNeighbours (F-14.3)', () => {
  it('reads the scene before and the scene after in reading order, chapter boundaries included', () => {
    setBrief(scenes[0]!.id, { after: 'The crossing is off until dawn.' })
    setBrief(scenes[1]!.id, { goal: 'Mara wants the ledger back.' })
    setBrief(scenes[2]!.id, { goal: 'Tomas wants the mill paid.' })
    expect(sceneNeighbours(db, scenes[1]!.id)).toEqual({
      current: brief({ goal: 'Mara wants the ledger back.' }),
      previous: brief({ after: 'The crossing is off until dawn.' }),
      next: brief({ goal: 'Tomas wants the mill paid.' })
    })
  })

  it('has no previous at the first scene and no next at the last', () => {
    expect(sceneNeighbours(db, scenes[0]!.id).previous).toBeNull()
    expect(sceneNeighbours(db, scenes[0]!.id).next).not.toBeNull()
    expect(sceneNeighbours(db, scenes.at(-1)!.id).next).toBeNull()
  })

  it('gives a folder its own brief and no neighbours, and an unknown id an empty one', () => {
    const chapter = listNodes(db).find((r) => r.kind === 'folder' && r.hierarchyLevel === 'chapter')
    if (!chapter) throw new Error('no chapter')
    setBrief(chapter.id, { goal: 'The chapter turns on the ledger.' })
    expect(sceneNeighbours(db, chapter.id)).toEqual({
      current: brief({ goal: 'The chapter turns on the ledger.' }),
      previous: null,
      next: null
    })
    expect(sceneNeighbours(db, 'nope')).toEqual({ current: brief(), previous: null, next: null })
  })
})

describe('sceneBriefBlock (F-14.3)', () => {
  it('renders the scene’s own lines with the neighbours’ one line each', () => {
    setBrief(scenes[0]!.id, { turn: 'She decides to wait for morning.' })
    setBrief(scenes[1]!.id, {
      goal: 'Mara wants the ledger back.',
      conflict: 'Tomas will not give it up.',
      turn: 'She takes the copy instead.',
      beat: 'Dread giving way to resolve.',
      after: 'The ledger is a copy.'
    })
    setBrief(scenes[2]!.id, { goal: 'Tomas wants the mill paid.' })
    expect(sceneBriefBlock(db, scenes[1]!.id)).toBe(
      [
        'Scene brief:',
        '- Goal: Mara wants the ledger back.',
        '- Conflict: Tomas will not give it up.',
        '- Turn: She takes the copy instead.',
        '- Emotional beat: Dread giving way to resolve.',
        '- Reader knows after: The ledger is a copy.',
        // The previous scene has no `after`, so its `turn` stands in.
        'Previous scene, reader knows after: She decides to wait for morning.',
        "Next scene's goal: Tomas wants the mill paid."
      ].join('\n')
    )
  })

  it('is null when neither the scene nor its neighbours have a brief', () => {
    expect(sceneBriefBlock(db, scenes[1]!.id)).toBeNull()
  })

  it('carries the neighbours even when the scene itself has no brief yet', () => {
    setBrief(scenes[0]!.id, { after: 'The crossing is off until dawn.' })
    expect(sceneBriefBlock(db, scenes[1]!.id)).toBe(
      'Previous scene, reader knows after: The crossing is off until dawn.'
    )
  })
})
