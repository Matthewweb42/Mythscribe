import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STATS_LOG_DAYS, STATS_ROWS_MAX } from '@shared/statsDashboard'
import { emptySceneMeta, type SceneMeta } from '@shared/sceneMeta'
import type { TiptapNodeT } from '@shared/tiptap'
import { writingLog, type NodeRow } from '../db/schema'
import { saveDocument } from '../document/documentStore'
import { setSceneMeta } from '../document/sceneMetaStore'
import { createEntity } from '../entity/entityStore'
import { resetGoalsSession } from '../goals/goalsStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { addDocumentTag } from '../tag/documentTagStore'
import { replaceNodeMentions } from '../tag/mentionStore'
import { createTag } from '../tag/tagStore'
import { createNode, deleteNode, listNodes, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { statsDashboard } from './dashboardStore'

let tmp: string
let session: ProjectSession
let db: TreeDb

const words = (n: number): TiptapNodeT => ({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: Array(n).fill('word').join(' ') }] }
  ]
})

const meta = (pov: string, location = ''): SceneMeta => ({ ...emptySceneMeta(), pov, location })

function find(predicate: (row: NodeRow) => boolean, what: string): NodeRow {
  const row = listNodes(db).find(predicate)
  if (!row) throw new Error(`no ${what}`)
  return row
}

/** Empties the template manuscript of documents, then adds three scenes to its first chapter, in reading order. */
function threeScenes(): NodeRow[] {
  for (const row of manuscriptDocuments(db)) deleteNode(db, row.id)
  const chapter = find((r) => r.hierarchyLevel === 'chapter', 'chapter')
  return ['Scene 1', 'Scene 2', 'Scene 3'].map((title) =>
    createNode(db, 'novel', {
      parentId: chapter.id,
      kind: 'document',
      hierarchyLevel: 'scene',
      title
    })
  )
}

const mention = (tagId: string, count: number): Map<string, [number, number][]> =>
  new Map([[tagId, Array.from({ length: count }, (_, i): [number, number] => [i, i + 1])]])

beforeEach(() => {
  resetGoalsSession()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-stats-'))
  session = createProject(projectFolderFor(tmp, 'Stats'), 'Stats', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  resetGoalsSession()
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('statsDashboard (F-10.5)', () => {
  it('answers empty panels for a new project', () => {
    threeScenes()
    const stats = statsDashboard(db, new Date(2026, 9, 4, 12))
    expect(stats.today).toBe('2026-10-04')
    expect(stats.days).toEqual([])
    expect(stats.hours).toHaveLength(24)
    expect(stats.hours.every((h) => h.words === 0 && h.activeMs === 0)).toBe(true)
    expect(stats.scenes.count).toBe(3)
    expect(stats.pov).toEqual([{ pov: null, scenes: 3, words: 0 }])
    expect(stats.characters).toEqual([])
    expect(stats.settings).toEqual([])
    expect(stats.truncated).toEqual({ characters: false, settings: false })
  })

  it('sums the log by day within the window and by hour over all of it, positive hours only', () => {
    const today = '2026-10-04'
    db.insert(writingLog)
      .values([
        { day: today, hour: 9, words: 100, activeMs: 60_000 },
        { day: today, hour: 21, words: -30, activeMs: 30_000 },
        { day: '2026-10-01', hour: 9, words: 50, activeMs: 10_000 },
        // The oldest day the heatmap can show, and one day before it.
        { day: '2025-09-29', hour: 21, words: 7, activeMs: 0 },
        { day: '2025-09-28', hour: 21, words: 1000, activeMs: 0 }
      ])
      .run()
    const stats = statsDashboard(db, new Date(2026, 9, 4, 22))
    expect(STATS_LOG_DAYS).toBe(371)
    expect(stats.days).toEqual([
      { day: '2025-09-29', words: 7, activeMs: 0 },
      { day: '2026-10-01', words: 50, activeMs: 10_000 },
      { day: today, words: 70, activeMs: 90_000 }
    ])
    expect(stats.hours[9]).toEqual({ hour: 9, words: 150, activeMs: 70_000 })
    expect(stats.hours[21]).toEqual({ hour: 21, words: 1007, activeMs: 30_000 })
  })

  it('reads scene lengths and POVs from manuscript documents only, never matter', () => {
    const [a, b, c] = threeScenes()
    saveDocument(db, a!.id, words(600))
    saveDocument(db, b!.id, words(20))
    saveDocument(db, c!.id, words(3000))
    setSceneMeta(db, a!.id, meta('Mara'))
    setSceneMeta(db, c!.id, meta(' mara '))
    const front = find((r) => r.sectionType === 'front', 'front matter')
    const dedication = createNode(db, 'novel', {
      parentId: front.id,
      kind: 'document',
      hierarchyLevel: null,
      title: 'Dedication'
    })
    saveDocument(db, dedication.id, words(9000))
    const stats = statsDashboard(db)
    expect(stats.scenes).toMatchObject({
      count: 3,
      median: 600,
      mean: 1207,
      shortest: { id: b!.id, title: 'Scene 2', words: 20 },
      longest: { id: c!.id, title: 'Scene 3', words: 3000 }
    })
    expect(stats.scenes.buckets.find((x) => x.label === '5,000+')?.count).toBe(0)
    expect(stats.pov).toEqual([
      { pov: 'Mara', scenes: 2, words: 3600 },
      { pov: null, scenes: 1, words: 20 }
    ])
  })

  it('counts characters by link, mention, and POV, named after their entity', () => {
    const [a, b, c] = threeScenes()
    const { entity: mara } = createEntity(db, { kind: 'character', name: 'Mara Voss' })
    const ilse = createTag(db, { name: 'ilse', category: 'character' })
    const nobody = createTag(db, { name: 'nobody', category: 'character' })
    createTag(db, { name: 'grim', category: 'tone' })
    const maraTag = mara.tagId ?? ''
    addDocumentTag(db, a!.id, maraTag)
    replaceNodeMentions(db, a!.id, mention(maraTag, 3), 'h1', new Date())
    replaceNodeMentions(db, b!.id, mention(maraTag, 2), 'h2', new Date())
    addDocumentTag(db, c!.id, ilse.id)
    setSceneMeta(db, c!.id, meta('mara voss'))
    // A link from front matter never counts.
    const front = find((r) => r.sectionType === 'front', 'front matter')
    const matter = createNode(db, 'novel', {
      parentId: front.id,
      kind: 'document',
      hierarchyLevel: null,
      title: 'Prologue note'
    })
    addDocumentTag(db, matter.id, ilse.id)
    const stats = statsDashboard(db)
    expect(stats.characters).toEqual([
      { tagId: maraTag, name: 'Mara Voss', scenes: 3, mentions: 5, povScenes: 1 },
      { tagId: ilse.id, name: 'ilse', scenes: 1, mentions: 0, povScenes: 0 },
      { tagId: nobody.id, name: 'nobody', scenes: 0, mentions: 0, povScenes: 0 }
    ])
  })

  it('counts settings by link and location, and gives unmatched locations their own rows', () => {
    const [a, b, c] = threeScenes()
    const harbor = createTag(db, { name: 'harbor', category: 'setting' })
    addDocumentTag(db, a!.id, harbor.id)
    setSceneMeta(db, b!.id, meta('', 'Harbor'))
    setSceneMeta(db, c!.id, meta('', 'The Old Mill'))
    setSceneMeta(db, a!.id, meta('', 'the old mill'))
    const stats = statsDashboard(db)
    expect(stats.settings).toEqual([
      { tagId: harbor.id, name: 'harbor', scenes: 2, mentions: 0 },
      { tagId: null, name: 'the old mill', scenes: 2, mentions: 0 }
    ])
  })

  it(`caps each list at ${STATS_ROWS_MAX} rows and says so`, () => {
    for (let i = 0; i <= STATS_ROWS_MAX; i++)
      createTag(db, { name: `person-${String(i).padStart(2, '0')}`, category: 'character' })
    const stats = statsDashboard(db)
    expect(stats.characters).toHaveLength(STATS_ROWS_MAX)
    expect(stats.truncated).toEqual({ characters: true, settings: false })
  })
})
