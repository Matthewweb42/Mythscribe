import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { entity, fact } from '../db/schema'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { deleteNode, duplicateNode, listNodes } from '../tree/treeStore'
import { createEntity, deleteEntity, getEntity, mergeEntities, updateEntity } from './entityStore'
import {
  applySceneFacts,
  factsForEntities,
  factsForNode,
  hasAiFacts,
  listFactsForEntity,
  setFactHidden,
  setFactStatus,
  syncAuthorBaseline,
  writeAuthorFact,
  type FactDb,
  type SceneFactInput
} from './factStore'

let tmp: string
let session: ProjectSession
let db: FactDb
let sceneA: string
let sceneB: string
let mara: string
let tash: string

const TEXT = 'Mara had her grey eyes on the river. She was nineteen that spring.'

const grey = (entityId: string): SceneFactInput => ({
  entityId,
  attribute: 'appearance',
  value: 'Grey eyes',
  quote: 'her grey eyes'
})
const age = (entityId: string): SceneFactInput => ({
  entityId,
  attribute: 'age',
  value: 'nineteen',
  quote: 'She was nineteen that spring.'
})

/** What the record's listed facts say, without the minted ids and dates. */
function said(entityId: string): [string | null, string, string, string, boolean][] {
  return listFactsForEntity(db, entityId)
    .map((row): [string | null, string, string, string, boolean] => [
      row.nodeId,
      row.origin,
      row.attribute,
      row.value,
      row.hidden
    ])
    .sort()
}

/** Every stored row of the record, baseline included, as origin/node/attribute/value. */
function stored(entityId: string): string[] {
  return db
    .select()
    .from(fact)
    .where(eq(fact.entityId, entityId))
    .all()
    .map((row) => `${row.origin}:${row.nodeId ?? '-'}:${row.attribute}=${row.value}`)
    .sort()
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-facts-'))
  session = createProject(projectFolderFor(tmp, 'Facts'), 'Facts', 'novel')
  db = session.connection.orm
  const scene = listNodes(db).find((row) => row.kind === 'document' && row.sectionType === null)
  if (scene === undefined) throw new Error('the seeded project has no scene')
  sceneA = scene.id
  const copy = duplicateNode(db, sceneA)[0]
  if (copy === undefined) throw new Error('the scene was not duplicated')
  sceneB = copy.id
  mara = createEntity(db, { kind: 'character', name: 'Mara' }).entity.id
  tash = createEntity(db, { kind: 'character', name: 'Tash' }).entity.id
})
afterEach(() => {
  vi.useRealTimers()
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the author baseline (one writer of entity.fields)', () => {
  it('mirrors every filled field as an undated author fact, kept out of the listed facts', () => {
    const ada = createEntity(db, {
      kind: 'character',
      name: 'Ada',
      fields: { age: '36', goals: 'Finish the engine.' }
    }).entity
    expect(stored(ada.id)).toEqual(['author:-:age=36', 'author:-:goals=Finish the engine.'])
    expect(listFactsForEntity(db, ada.id)).toEqual([])
    updateEntity(db, ada.id, { fields: { age: '37', goals: '' } })
    expect(getEntity(db, ada.id)?.fields).toEqual({ age: '37' })
    expect(stored(ada.id)).toEqual(['author:-:age=37'])
  })

  it('dates an author line at a scene (D4) without touching the sheet text', () => {
    updateEntity(db, mara, { fields: { age: '19' } })
    updateEntity(db, mara, { fields: { age: '20' }, asOf: sceneB })
    expect(getEntity(db, mara)?.fields).toEqual({ age: '19' })
    expect(said(mara)).toEqual([[sceneB, 'author', 'age', '20', false]])
    // Writing the same scene again replaces that line; '' removes it.
    writeAuthorFact(db, mara, 'age', '21', sceneB)
    expect(said(mara)).toEqual([[sceneB, 'author', 'age', '21', false]])
    writeAuthorFact(db, mara, 'age', '', sceneB)
    expect(said(mara)).toEqual([])
  })

  it('refuses to date a line at a node that is not a scene', () => {
    const root = listNodes(db).find((row) => row.parentId === null)
    expect(() => updateEntity(db, mara, { fields: { age: '9' }, asOf: root?.id ?? '' })).toThrow(
      /dated at a scene/
    )
    expect(() => updateEntity(db, mara, { fields: { age: '9' }, asOf: 'missing' })).toThrow(
      /Scene not found/
    )
  })

  it('reconciles a sheet an older build edited straight in the column', () => {
    updateEntity(db, mara, { fields: { age: '19' } })
    db.update(entity).set({ fields: '{"age":"44","goals":"Run"}' }).where(eq(entity.id, mara)).run()
    expect(syncAuthorBaseline(db, mara, { age: '44', goals: 'Run' })).toBe(2)
    expect(stored(mara)).toEqual(['author:-:age=44', 'author:-:goals=Run'])
    expect(syncAuthorBaseline(db, mara, { age: '44', goals: 'Run' })).toBe(0)
  })

  it('keeps an author line, undated, when its scene is deleted, and drops the AI facts of it', () => {
    writeAuthorFact(db, mara, 'age', '20', sceneB)
    applySceneFacts(db, sceneB, [grey(mara)], TEXT)
    expect(deleteNode(db, sceneB)).toEqual([mara])
    expect(said(mara)).toEqual([[null, 'author', 'age', '20', false]])
  })
})

describe('applySceneFacts (sticky, D13)', () => {
  it('stores the scene’s facts, stamped and visible, and names the records touched', () => {
    vi.useFakeTimers({ now: new Date('2026-10-02T10:00:00.000Z') })
    const diff = applySceneFacts(db, sceneA, [grey(mara), age(tash)], TEXT, 'idea')
    expect(diff.entityIds).toEqual([mara, tash].sort())
    expect(diff.removed).toEqual([])
    expect(diff.added).toHaveLength(2)
    const [first, ...rest] = listFactsForEntity(db, mara)
    expect(rest).toEqual([])
    expect(first).toEqual({
      id: first?.id,
      entityId: mara,
      attribute: 'appearance',
      value: 'Grey eyes',
      objectEntityId: null,
      nodeId: sceneA,
      quote: 'her grey eyes',
      origin: 'ai',
      status: 'idea',
      hidden: false,
      createdAt: '2026-10-02T10:00:00.000Z',
      updatedAt: '2026-10-02T10:00:00.000Z'
    })
    expect(
      factsForNode(db, sceneA)
        .map((row) => row.entityId)
        .sort()
    ).toEqual([mara, tash].sort())
  })

  it('keeps a statement whose quote is still in the scene, and drops one whose quote left', () => {
    applySceneFacts(db, sceneA, [grey(mara), age(mara)], TEXT)
    // Re-read: the model only mentions the age now, but her grey eyes are still in the text.
    expect(applySceneFacts(db, sceneA, [age(mara)], TEXT)).toMatchObject({
      added: [],
      removed: [],
      entityIds: []
    })
    expect(said(mara)).toHaveLength(2)
    // The author cut the sentence: the fact goes with its quote.
    const cut = applySceneFacts(db, sceneA, [age(mara)], 'She was nineteen that spring.')
    expect(cut.removed.map((row) => row.value)).toEqual(['Grey eyes'])
    expect(said(mara)).toEqual([[sceneA, 'ai', 'age', 'nineteen', false]])
  })

  it('stores a statement given twice once, compared by fact key, and leaves another scene alone', () => {
    applySceneFacts(db, sceneA, [grey(mara), { ...grey(mara), value: ' grey  eyes. ' }], TEXT)
    applySceneFacts(db, sceneB, [grey(mara)], TEXT)
    expect(said(mara)).toEqual(
      [
        [sceneA, 'ai', 'appearance', 'Grey eyes', false],
        [sceneB, 'ai', 'appearance', 'Grey eyes', false]
      ].sort()
    )
  })

  it('keeps a hidden fact out of every scene of its record, never removes it, and lifts on restore', () => {
    applySceneFacts(db, sceneA, [grey(mara)], TEXT)
    const hidden = listFactsForEntity(db, mara)[0]
    setFactHidden(db, hidden?.id ?? '', true)
    expect(
      applySceneFacts(db, sceneB, [{ ...grey(mara), value: 'grey eyes.' }], TEXT).added
    ).toEqual([])
    // An empty reading never takes a tombstone away.
    applySceneFacts(db, sceneA, [], '')
    expect(said(mara)).toEqual([[sceneA, 'ai', 'appearance', 'Grey eyes', true]])
    // The same words about Tash are still logged: the tombstone is Mara's alone.
    expect(applySceneFacts(db, sceneB, [grey(tash)], TEXT).added).toHaveLength(1)
    setFactHidden(db, hidden?.id ?? '', false)
    expect(applySceneFacts(db, sceneB, [grey(mara)], TEXT).added).toHaveLength(1)
  })

  it('rolls the whole reading back when a row names an unknown record', () => {
    applySceneFacts(db, sceneA, [grey(mara)], TEXT)
    expect(() => applySceneFacts(db, sceneA, [age(mara), age('missing')], TEXT)).toThrow(
      /FOREIGN KEY/
    )
    expect(said(mara)).toEqual([[sceneA, 'ai', 'appearance', 'Grey eyes', false]])
  })
})

describe('reading the facts', () => {
  it('lists hidden facts too, and gives prompts only visible dated ones', () => {
    updateEntity(db, mara, { fields: { goals: 'Cross' } })
    applySceneFacts(db, sceneA, [grey(mara), age(mara), age(tash)], TEXT)
    setFactHidden(db, listFactsForEntity(db, mara)[0]?.id ?? '', true)
    expect(listFactsForEntity(db, mara)).toHaveLength(2)
    const visible = factsForEntities(db, [mara, tash])
    expect(visible).toHaveLength(2)
    expect(visible.every((row) => !row.hidden && row.origin === 'ai')).toBe(true)
    expect(factsForEntities(db, [])).toEqual([])
    expect(listFactsForEntity(db, 'missing')).toEqual([])
  })

  it('counts a hidden AI fact as the manuscript stating something, but not the author’s text', () => {
    updateEntity(db, mara, { fields: { goals: 'Cross' } })
    expect(hasAiFacts(db, mara)).toBe(false)
    applySceneFacts(db, sceneA, [grey(mara)], TEXT)
    setFactHidden(db, listFactsForEntity(db, mara)[0]?.id ?? '', true)
    expect(hasAiFacts(db, mara)).toBe(true)
    deleteEntity(db, mara)
    expect(stored(mara)).toEqual([])
  })

  it('sets a status and a hidden flag, and refuses an unknown id', () => {
    applySceneFacts(db, sceneA, [grey(mara)], TEXT)
    const row = listFactsForEntity(db, mara)[0]
    expect(setFactStatus(db, row?.id ?? '', 'plan')).toMatchObject({ status: 'plan' })
    expect(setFactHidden(db, row?.id ?? '', true)).toMatchObject({ status: 'plan', hidden: true })
    for (const call of [() => setFactStatus(db, 'x', 'idea'), () => setFactHidden(db, 'x', true)]) {
      try {
        call()
        throw new Error('expected NOT_FOUND')
      } catch (err) {
        expect(err).toBeInstanceOf(AppError)
        expect((err as AppError).code).toBe('NOT_FOUND')
      }
    }
  })

  it('moves dated facts with a merge, keeping the target’s copy of a shared statement', () => {
    applySceneFacts(db, sceneA, [grey(mara), grey(tash), age(tash)], TEXT)
    mergeEntities(db, mara, [tash])
    expect(said(mara)).toEqual([
      [sceneA, 'ai', 'age', 'nineteen', false],
      [sceneA, 'ai', 'appearance', 'Grey eyes', false]
    ])
  })
})
