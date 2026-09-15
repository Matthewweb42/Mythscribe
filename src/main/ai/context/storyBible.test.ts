import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptySceneMeta } from '@shared/sceneMeta'
import { STORY_BIBLE_HEADING, STORY_BIBLE_TOKEN_BUDGET } from '@shared/storyBible'
import { setSceneMeta } from '../../document/sceneMetaStore'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { addDocumentTag } from '../../tag/documentTagStore'
import { createTag } from '../../tag/tagStore'
import { createNode, listNodes, renameNode, type TreeDb } from '../../tree/treeStore'
import { buildStoryBible } from './storyBible'

let tmp: string
let session: ProjectSession
let db: TreeDb
/** The seeded skeleton is two parts of three chapters with one scene each; these are the first of each. */
let scene: string
let chapter: string
let part: string
/** The second chapter's only scene: the next document in reading order after the first chapter's. */
let secondChapterScene: string
let frontRoot: string

const budget = { maxTokens: STORY_BIBLE_TOKEN_BUDGET }

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-bible-'))
  session = createProject(projectFolderFor(tmp, 'Bible'), 'Bible', 'novel')
  db = session.connection.orm
  const rows = listNodes(db)
  part = rows.find((r) => r.hierarchyLevel === 'part')?.id ?? ''
  const chapters = rows.filter((r) => r.hierarchyLevel === 'chapter' && r.parentId === part)
  chapter = chapters[0]?.id ?? ''
  scene = rows.find((r) => r.hierarchyLevel === 'scene' && r.parentId === chapter)?.id ?? ''
  secondChapterScene =
    rows.find((r) => r.hierarchyLevel === 'scene' && r.parentId === chapters[1]?.id)?.id ?? ''
  frontRoot = rows.find((r) => r.sectionType === 'front')?.id ?? ''
  if (!scene || !chapter || !part || !secondChapterScene || !frontRoot) {
    throw new Error('skeleton not seeded')
  }
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('buildStoryBible (F-14.9)', () => {
  it('is null with no document open and an empty bank; a fresh scene still has its neighbour', () => {
    expect(buildStoryBible(db, { nodeId: null, ...budget })).toBeNull()
    expect(buildStoryBible(db, { nodeId: scene, ...budget })).toBe(
      `${STORY_BIBLE_HEADING}\n` +
        'This scene: "Scene 1", in "Chapter 1", in "Part 1", scene 1 of 1.\n' +
        'Next scene: "Scene 1".'
    )
  })

  it('lists the bank by story category only, with no scene part when no document is open', () => {
    createTag(db, { name: 'Mara', category: 'character', color: '#112233' })
    createTag(db, { name: 'ridge', category: 'setting', color: '#112233' })
    createTag(db, { name: 'tense', category: 'tone', color: '#112233' })
    createTag(db, { name: 'violence', category: 'content', color: '#112233' })
    createTag(db, { name: 'oath', category: 'plotThread', color: '#112233' })
    expect(buildStoryBible(db, { nodeId: null, ...budget })).toBe(
      `${STORY_BIBLE_HEADING}\nCharacters: mara\nSettings: ridge\nPlot threads: oath`
    )
  })

  it('places the scene in its chapter and part, with its tags and the neighbours in reading order across chapters', () => {
    renameNode(db, scene, 'The Ferry')
    renameNode(db, secondChapterScene, 'Night')
    const leaving = createNode(db, 'novel', {
      parentId: chapter,
      kind: 'document',
      hierarchyLevel: 'scene',
      title: 'Leaving'
    })
    setSceneMeta(db, leaving.id, { ...emptySceneMeta(), location: 'Town', pov: 'Mara', timeline: 'Day 1' })
    setSceneMeta(db, secondChapterScene, { ...emptySceneMeta(), timeline: 'Day 2' })
    const mara = createTag(db, { name: 'Mara', category: 'character', color: '#112233' })
    const ferry = createTag(db, { name: 'ferry landing', category: 'setting', color: '#112233' })
    addDocumentTag(db, scene, mara.id)
    addDocumentTag(db, scene, ferry.id)

    expect(buildStoryBible(db, { nodeId: scene, ...budget })).toBe(
      `${STORY_BIBLE_HEADING}\n` +
        'Characters: mara\n' +
        'Settings: ferry-landing\n' +
        'This scene: "The Ferry", in "Chapter 1", in "Part 1", scene 1 of 2; tagged ferry-landing, mara.\n' +
        'Next scene: "Leaving" (location Town, POV Mara, timeline Day 1).'
    )
    expect(buildStoryBible(db, { nodeId: leaving.id, ...budget })).toBe(
      `${STORY_BIBLE_HEADING}\n` +
        'Characters: mara\n' +
        'Settings: ferry-landing\n' +
        'This scene: "Leaving", in "Chapter 1", in "Part 1", scene 2 of 2.\n' +
        'Previous scene: "The Ferry".\n' +
        'Next scene: "Night" (timeline Day 2).'
    )
  })

  it('gives a front-matter document the bank alone', () => {
    const front = createNode(db, 'novel', {
      parentId: frontRoot,
      kind: 'document',
      hierarchyLevel: null
    })
    createTag(db, { name: 'Mara', category: 'character', color: '#112233' })
    expect(buildStoryBible(db, { nodeId: front.id, ...budget })).toBe(
      `${STORY_BIBLE_HEADING}\nCharacters: mara`
    )
  })
})
