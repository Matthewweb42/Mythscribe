import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExtractedFact } from '@shared/observedFacts'
import { emptySceneMeta } from '@shared/sceneMeta'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { createEntity, listEntities, updateEntity } from '../entity/entityStore'
import { listFactsForEntity } from '../entity/factStore'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { getDismissedNames } from '../project/settingsStore'
import { listDocumentTags } from '../tag/documentTagStore'
import { listTags } from '../tag/tagStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { listChanges, logChanges, pruneChanges, undoChange, undoRun } from './changeLog'
import { applyDerivedKnowledge } from './derive'

let tmp: string
let session: ProjectSession
let db: TreeDb
let scene: string

const TEXT = 'Kael kept his watchful eyes on the river. The storm broke over the ferry.'

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

const watchful: ExtractedFact = {
  entity: 'Kael',
  kind: 'character',
  attribute: 'personality',
  value: 'Watchful',
  quote: 'his watchful eyes'
}

/** One reading of the scene, as the summary run applies it. */
const read = (
  facts: ExtractedFact[] = [watchful],
  tags = [{ name: 'stormbound', category: 'tone' as const }]
): ReturnType<typeof applyDerivedKnowledge> =>
  applyDerivedKnowledge(db, {
    nodeId: scene,
    facts,
    tags,
    sceneText: TEXT,
    now: new Date().toISOString()
  })

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-changes-'))
  session = createProject(projectFolderFor(tmp, 'Changes'), 'Changes', 'novel')
  db = session.connection.orm
  scene = listNodes(db).find((row) => row.kind === 'document' && row.sectionType === null)?.id ?? ''
  if (!scene) throw new Error('skeleton not seeded')
  saveDocument(db, scene, doc(TEXT))
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('applyDerivedKnowledge logs what it added (F-9.13)', () => {
  it('logs the new sheet, its tag, the fact, the new tag, and the tag on the scene as one run', () => {
    const run = read()
    expect(run.logged).toBe(5)
    const page = listChanges(db, { limit: 50 })
    expect(page.more).toBe(false)
    expect(page.entries.every((entry) => entry.runId === run.runId)).toBe(true)
    expect(page.entries.map((entry) => [entry.kind, entry.label]).sort()).toEqual(
      [
        ['fact', 'Kael · Personality: Watchful'],
        ['record', 'Kael'],
        ['tag', '#kael'],
        ['tag', '#stormbound'],
        ['tagLink', '#stormbound']
      ].sort()
    )
    const factEntry = page.entries.find((entry) => entry.kind === 'fact')
    expect(factEntry).toMatchObject({
      nodeId: scene,
      quote: 'his watchful eyes',
      status: 'applied'
    })
  })

  it('logs nothing for a reading that adds nothing (a sticky re-read)', () => {
    read()
    expect(read().logged).toBe(0)
    expect(listChanges(db, { limit: 50 }).entries).toHaveLength(5)
  })

  it('marks a fact from a scene the author marked as an idea as an idea (D7)', () => {
    db.run(
      sql`UPDATE node SET scene_meta = ${JSON.stringify({ ...emptySceneMeta(), status: 'idea' })} WHERE id = ${scene}`
    )
    read()
    const kael = listEntities(db).find((each) => each.name === 'Kael')
    expect(listFactsForEntity(db, kael?.id ?? '')[0]?.status).toBe('idea')
  })
})

describe('undo (F-9.13)', () => {
  it('hides an undone fact, so the next reading does not bring it back', () => {
    read()
    const entry = listChanges(db, { limit: 50 }).entries.find((each) => each.kind === 'fact')
    const result = undoChange(db, entry?.id ?? '')
    const kael = listEntities(db).find((each) => each.name === 'Kael')
    expect(result.entries.map((each) => each.status)).toEqual(['undone'])
    expect(result.entityIds).toEqual([kael?.id])
    expect(listFactsForEntity(db, kael?.id ?? '').map((each) => each.hidden)).toEqual([true])
    expect(read().logged).toBe(0)
    expect(listFactsForEntity(db, kael?.id ?? '').map((each) => each.hidden)).toEqual([true])
    // Undoing it again changes nothing.
    expect(undoChange(db, entry?.id ?? '').entries).toEqual([])
  })

  it('takes a whole run back: tag off the scene, sheet and tags deleted, names remembered', () => {
    const run = read()
    const result = undoRun(db, run.runId)
    expect(result.entries).toHaveLength(5)
    expect(result.removedEntityIds).toHaveLength(1)
    expect(result.removedTagIds).toHaveLength(2)
    expect(listEntities(db)).toEqual([])
    expect(listTags(db).map((each) => each.name)).toEqual([])
    expect(listDocumentTags(db, scene)).toEqual([])
    expect(getDismissedNames(db).names).toEqual(expect.arrayContaining(['kael', 'stormbound']))
    // The next reading of the same answer recreates none of it.
    expect(read().logged).toBe(0)
    expect(listEntities(db)).toEqual([])
    expect(listTags(db)).toEqual([])
  })

  it('refuses to delete a sheet the author has edited since, and refuses the run whole', () => {
    const run = read([watchful], [])
    const kael = listEntities(db).find((each) => each.name === 'Kael')
    updateEntity(db, kael?.id ?? '', { body: 'Mine now.' })
    expect(() => undoRun(db, run.runId)).toThrow(/yours now/)
    expect(listChanges(db, { limit: 50 }).entries.every((e) => e.status === 'applied')).toBe(true)
    expect(listEntities(db)).toHaveLength(1)
  })

  it('answers NOT_FOUND for an unknown change or run', () => {
    for (const call of [() => undoChange(db, 'x'), () => undoRun(db, 'x')]) {
      expect(call).toThrow(AppError)
    }
  })
})

describe('listChanges and pruning', () => {
  it('pages newest first with a cursor, and prunes the oldest rows past the cap', () => {
    const mara = createEntity(db, { kind: 'character', name: 'Mara' }).entity
    for (const [i, at] of ['2026-10-01', '2026-10-02', '2026-10-03'].entries()) {
      logChanges(
        db,
        `run-${i}`,
        [
          {
            kind: 'record',
            nodeId: scene,
            quote: null,
            entityId: mara.id,
            targetId: mara.id,
            label: `change ${i}`,
            undo: { type: 'deleteRecord', entityId: mara.id }
          }
        ],
        `${at}T00:00:00.000Z`
      )
    }
    const first = listChanges(db, { limit: 2 })
    expect(first.entries.map((entry) => entry.label)).toEqual(['change 2', 'change 1'])
    expect(first.more).toBe(true)
    const second = listChanges(db, { before: first.entries[1]?.id, limit: 2 })
    expect(second.entries.map((entry) => entry.label)).toEqual(['change 0'])
    expect(second.more).toBe(false)
    pruneChanges(db, 2)
    expect(listChanges(db, { limit: 10 }).entries.map((entry) => entry.label)).toEqual([
      'change 2',
      'change 1'
    ])
  })
})
