import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SEARCH_MISS_MAX } from '@shared/scribe'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { deleteNode, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { logSearchMiss, searchMisses } from './searchMissStore'

let tmp: string
let session: ProjectSession
let db: TreeDb
let scene: string

const at = (second: number): Date => new Date(Date.UTC(2026, 9, 13, 12, 0, second))

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-search-miss-'))
  session = createProject(projectFolderFor(tmp, 'Misses'), 'Misses', 'novel', {
    storyMemoryOverride: 'v2'
  })
  db = session.connection.orm
  scene = manuscriptDocuments(db)[0]?.id ?? ''
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const miss = (n: number): Parameters<typeof logSearchMiss>[1] => ({
  question: `When does Orrin first hear about the map? (${n})`,
  terms: ['overheard', 'heard'],
  nodeId: scene,
  para: n,
  quote: 'Orrin overheard Tomas',
  promptVersion: 'agent.v9'
})

describe('search misses (F-16.25, P3-D15)', () => {
  it('logs a miss with its question, terms and quote cut to size, newest first', () => {
    expect(searchMisses(db, 10)).toEqual({ count: 0, recent: [] })
    logSearchMiss(db, miss(1), at(1))
    logSearchMiss(
      db,
      {
        ...miss(2),
        question: `${'why '.repeat(100)}?`,
        terms: [' a ', '', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
        quote: 'q'.repeat(400)
      },
      at(2)
    )
    const listed = searchMisses(db, 10)
    expect(listed.count).toBe(2)
    expect(listed.recent.map((row) => row.para)).toEqual([2, 1])
    const [newest] = listed.recent
    expect(newest?.question.length).toBe(300)
    expect(newest?.question.endsWith('…')).toBe(true)
    expect(newest?.terms).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
    expect(newest?.quote.length).toBe(240)
    expect(listed.recent[1]).toMatchObject({
      terms: ['overheard', 'heard'],
      nodeId: scene,
      quote: 'Orrin overheard Tomas',
      promptVersion: 'agent.v9',
      created: at(1).toISOString()
    })
    expect(searchMisses(db, 1).recent).toHaveLength(1)
    expect(searchMisses(db, 0)).toEqual({ count: 2, recent: [] })
  })

  it(`keeps the newest ${SEARCH_MISS_MAX}: an insert prunes the oldest`, () => {
    for (let n = 0; n < SEARCH_MISS_MAX + 3; n += 1) logSearchMiss(db, miss(n), at(n))
    const listed = searchMisses(db, 5)
    expect(listed.count).toBe(SEARCH_MISS_MAX)
    expect(listed.recent[0]?.para).toBe(SEARCH_MISS_MAX + 2)
    // The three oldest went.
    const all = db.all<{ para: number }>('SELECT para FROM search_miss ORDER BY para LIMIT 1')
    expect(all[0]?.para).toBe(3)
  })

  it('drops a scene’s misses with the scene', () => {
    logSearchMiss(db, miss(1), at(1))
    deleteNode(db, scene)
    expect(searchMisses(db, 10).count).toBe(0)
  })
})
