import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptySceneMeta } from '@shared/sceneMeta'
import { STORY_MAP_LATEST_NOTE } from '@shared/storyTime'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../../document/documentStore'
import { setSceneMeta } from '../../document/sceneMetaStore'
import { upsertSummary } from '../../document/summaryStore'
import { projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { createSeededProject } from '../../project/testProject'
import { listNodes, type TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { buildStoryMap, positionNote, storyMapItems, storyTime } from './storyTime'

let tmp: string
let session: ProjectSession
let db: TreeDb
let scenes: string[]

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-storytime-'))
  session = createSeededProject(projectFolderFor(tmp, 'Time'), 'Time', 'novel')
  db = session.connection.orm
  scenes = manuscriptDocuments(db).map((row) => row.id)
  saveDocument(db, scenes[0]!, doc('Mara lands at Keep.'))
  saveDocument(db, scenes[1]!, doc('Tomas wants the ledger back.'))
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('storyTime (F-5.23)', () => {
  it('puts now at the open scene, at the last scene of a selected chapter, or at the latest written scene', () => {
    expect(storyTime(db, scenes[2]!)).toMatchObject({ nowId: scenes[2], basis: 'open' })
    const chapter = listNodes(db).find((row) => row.id === scenes[0])?.parentId ?? ''
    expect(storyTime(db, chapter)).toMatchObject({ nowId: scenes[0], basis: 'open' })
    expect(storyTime(db, null)).toMatchObject({ nowId: scenes[1], basis: 'latest' })
    const time = storyTime(db, scenes[1]!)
    expect(time.positionOf(scenes[0]!)).toBe('earlier')
    expect(time.positionOf(scenes[3]!)).toBe('later')
    expect(positionNote(time, scenes[3]!)).toBe('after now: has not happened yet')
    expect(positionNote(time, 'not-a-scene')).toBe(
      "outside the manuscript: the author's notes and research"
    )
  })

  it('maps the manuscript with progress and summaries, leaving out a planned scene already fulfilled', () => {
    upsertSummary(db, {
      nodeId: scenes[0]!,
      summary: 'Mara lands at Keep. She is tired.',
      keyPoints: [],
      characters: [],
      contentHash: 'h',
      promptVersion: 'summary.v3',
      model: 'm',
      truncated: false,
      createdAt: '2026-10-08T10:00:00.000Z'
    })
    setSceneMeta(db, scenes[1]!, { ...emptySceneMeta(), status: 'final' })
    setSceneMeta(db, scenes[2]!, { ...emptySceneMeta(), fulfilledBy: scenes[1] })
    const rows = listNodes(db)
    const items = storyMapItems(db, rows)
    expect(items.some((item) => item.id === scenes[2])).toBe(false)
    expect(items.find((item) => item.id === scenes[0])).toMatchObject({
      progress: 'drafted',
      summary: 'Mara lands at Keep. She is tired.'
    })
    expect(items.find((item) => item.id === scenes[1])?.progress).toBe('revised')
    expect(items.find((item) => item.id === scenes[3])?.progress).toBe('planned')
    const map = buildStoryMap(db, storyTime(db, null), { maxTokens: 1_200 }) ?? ''
    expect(map).toContain(STORY_MAP_LATEST_NOTE)
    expect(map).toContain('Scene 1 [drafted]: Mara lands at Keep.')
    expect(map).toContain('Scene 1 [revised] ▶ NOW')
  })
})
