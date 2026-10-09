import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptySceneMeta } from '@shared/sceneMeta'
import { STORY_BIBLE_HEADING, STORY_BIBLE_TOKEN_BUDGET } from '@shared/storyBible'
import { setSceneMeta } from '../../document/sceneMetaStore'
import { upsertSummary } from '../../document/summaryStore'
import { createEntity, updateEntity } from '../../entity/entityStore'
import { listFactsForEntity, applySceneFacts, setFactHidden } from '../../entity/factStore'
import { projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { createSeededProject } from '../../project/testProject'
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
  session = createSeededProject(projectFolderFor(tmp, 'Bible'), 'Bible', 'novel')
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
    setSceneMeta(db, leaving.id, {
      ...emptySceneMeta(),
      location: 'Town',
      pov: 'Mara',
      timeline: 'Day 1'
    })
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

  it("carries the neighbours' stored summaries (F-5.6), and only theirs", () => {
    const stored = (nodeId: string, summary: string): void =>
      upsertSummary(db, {
        nodeId,
        summary,
        keyPoints: ['a key point'],
        characters: ['Mara'],
        contentHash: `hash-${nodeId}`,
        promptVersion: 'summary.v1',
        model: 'gpt-fast',
        truncated: false,
        createdAt: '2026-09-15T00:00:00.000Z'
      })
    stored(scene, 'Mara reached the ferry landing and waited.')
    stored(secondChapterScene, 'Tomas walked north before dawn.')

    // From the second scene: the first is its previous, and its own summary never goes out.
    expect(buildStoryBible(db, { nodeId: secondChapterScene, ...budget })).toBe(
      `${STORY_BIBLE_HEADING}\n` +
        'This scene: "Scene 1", in "Chapter 2", in "Part 1", scene 1 of 1.\n' +
        'Previous scene: "Scene 1".\n' +
        'Next scene: "Scene 1".\n' +
        'Previous scene summary: Mara reached the ferry landing and waited.'
    )
    expect(buildStoryBible(db, { nodeId: scene, ...budget })).toBe(
      `${STORY_BIBLE_HEADING}\n` +
        'This scene: "Scene 1", in "Chapter 1", in "Part 1", scene 1 of 1.\n' +
        'Next scene: "Scene 1".\n' +
        'Next scene summary: Tomas walked north before dawn.'
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

describe('buildStoryBible with entities (F-5.16)', () => {
  it('is unchanged by entities the scene is not tagged with', () => {
    const before = buildStoryBible(db, { nodeId: scene, ...budget })
    const mara = createEntity(db, { kind: 'character', name: 'Mara', fields: { age: '31' } }).entity
    applySceneFacts(
      db,
      scene,
      [{ entityId: mara.id, attribute: 'goals', value: 'Cross the river', quote: 'the river' }],
      ''
    )
    // The entity's tag joins the bank line, as any tag does; no entity line is added.
    expect(buildStoryBible(db, { nodeId: scene, ...budget })).toBe(
      (before ?? '').replace(
        `${STORY_BIBLE_HEADING}\n`,
        `${STORY_BIBLE_HEADING}\nCharacters: mara\n`
      )
    )
  })

  it("carries the sheet of each entity linked to the scene's tags, then the facts the sheet does not fill as of the scene (F-9.13)", () => {
    const mara = createEntity(db, { kind: 'character', name: 'Mara', fields: { age: '31' } }).entity
    addDocumentTag(db, scene, mara.tagId ?? '')
    applySceneFacts(
      db,
      secondChapterScene,
      [{ entityId: mara.id, attribute: 'appearance', value: 'Green eyes', quote: 'green eyes' }],
      ''
    )
    applySceneFacts(
      db,
      scene,
      [
        // The sheet gives her age: the author's word wins, the observed one is not sent.
        { entityId: mara.id, attribute: 'age', value: 'nineteen', quote: 'nineteen' },
        { entityId: mara.id, attribute: 'appearance', value: 'Grey eyes', quote: 'grey eyes' }
      ],
      ''
    )
    // A later scene's statement has not happened yet at this scene (F-9.13, `sheetAt`).
    const bible = buildStoryBible(db, { nodeId: scene, ...budget })
    expect(bible).toContain(
      'scene 1 of 1; tagged mara.\n' +
        'Mara (character): Age: 31. Seen in the manuscript: Appearance: Grey eyes.\n'
    )
    expect(bible).not.toContain('Green eyes')
    // A hidden fact never reaches a prompt.
    const grey = listFactsForEntity(db, mara.id).find((fact) => fact.value === 'Grey eyes')
    setFactHidden(db, grey?.id ?? '', true)
    expect(buildStoryBible(db, { nodeId: scene, ...budget })).not.toContain('Grey eyes')
  })

  it('sends no fields of a blank-template entity, only what the manuscript states', () => {
    const tash = createEntity(db, { kind: 'character', name: 'Tash', fields: { age: '40' } }).entity
    updateEntity(db, tash.id, { template: 'blank' })
    addDocumentTag(db, scene, tash.tagId ?? '')
    expect(buildStoryBible(db, { nodeId: scene, ...budget })).not.toContain('Tash (character)')
    applySceneFacts(
      db,
      scene,
      [{ entityId: tash.id, attribute: 'age', value: 'forty', quote: 'forty' }],
      ''
    )
    expect(buildStoryBible(db, { nodeId: scene, ...budget })).toContain(
      'Tash (character): Seen in the manuscript: Age: forty.\n'
    )
  })

  it("sends a blank-template entity's page ahead of what the manuscript states", () => {
    const tash = createEntity(db, { kind: 'character', name: 'Tash', template: 'blank' }).entity
    updateEntity(db, tash.id, { body: 'Tash is forty-one.\nShe limps.' })
    addDocumentTag(db, scene, tash.tagId ?? '')
    applySceneFacts(
      db,
      scene,
      [{ entityId: tash.id, attribute: 'age', value: 'forty', quote: 'forty' }],
      ''
    )
    expect(buildStoryBible(db, { nodeId: scene, ...budget })).toContain(
      'Tash (character): Notes: Tash is forty-one. She limps. Seen in the manuscript: Age: forty.\n'
    )
  })
})
