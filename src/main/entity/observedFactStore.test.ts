import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { deleteNode, duplicateNode, listNodes } from '../tree/treeStore'
import { createEntity, deleteEntity } from './entityStore'
import {
  factsForEntities,
  hasFacts,
  listFactsForEntity,
  replaceSceneFacts,
  setFactHidden,
  type ObservedFactDb,
  type SceneFactInput
} from './observedFactStore'

let tmp: string
let session: ProjectSession
let db: ObservedFactDb
let sceneA: string
let sceneB: string
let mara: string
let tash: string

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

/** What a scene's facts say, without the minted ids and dates. */
function said(entityId: string): [string, string, string, boolean][] {
  return listFactsForEntity(db, entityId).map((fact) => [
    fact.nodeId,
    fact.attribute,
    fact.value,
    fact.hidden
  ])
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

describe('replaceSceneFacts', () => {
  it('stores the scene’s facts, stamped and visible, and names the entities touched', () => {
    vi.useFakeTimers({ now: new Date('2026-10-02T10:00:00.000Z') })
    expect(replaceSceneFacts(db, sceneA, [grey(mara), age(tash)])).toEqual([mara, tash].sort())
    const [fact, ...rest] = listFactsForEntity(db, mara)
    expect(rest).toEqual([])
    expect(fact).toEqual({
      id: fact?.id,
      entityId: mara,
      nodeId: sceneA,
      attribute: 'appearance',
      value: 'Grey eyes',
      quote: 'her grey eyes',
      hidden: false,
      createdAt: '2026-10-02T10:00:00.000Z'
    })
    expect(typeof fact?.id).toBe('string')
    expect(said(tash)).toEqual([[sceneA, 'age', 'nineteen', false]])
  })

  it('replaces the scene’s visible facts and leaves another scene’s alone', () => {
    replaceSceneFacts(db, sceneA, [grey(mara)])
    replaceSceneFacts(db, sceneB, [grey(mara)])
    // Mara lost a fact and Tash gained one: both pages have something new to show.
    expect(replaceSceneFacts(db, sceneA, [age(tash)])).toEqual([mara, tash].sort())
    expect(said(mara)).toEqual([[sceneB, 'appearance', 'Grey eyes', false]])
    expect(said(tash)).toEqual([[sceneA, 'age', 'nineteen', false]])
  })

  it('stores a statement given twice once, compared by fact key', () => {
    replaceSceneFacts(db, sceneA, [grey(mara), { ...grey(mara), value: ' grey  eyes. ' }])
    expect(said(mara)).toEqual([[sceneA, 'appearance', 'Grey eyes', false]])
  })

  it('clears the scene’s visible facts for an empty list', () => {
    replaceSceneFacts(db, sceneA, [grey(mara)])
    expect(replaceSceneFacts(db, sceneA, [])).toEqual([mara])
    expect(said(mara)).toEqual([])
    expect(replaceSceneFacts(db, sceneA, [])).toEqual([])
  })

  it('keeps a hidden fact as a tombstone and does not insert its twin again', () => {
    replaceSceneFacts(db, sceneA, [grey(mara), age(mara)])
    const hidden = listFactsForEntity(db, mara).find((fact) => fact.attribute === 'appearance')
    setFactHidden(db, hidden?.id ?? '', true)
    replaceSceneFacts(db, sceneA, [{ ...grey(mara), value: 'grey eyes' }, age(mara)])
    expect(said(mara).sort()).toEqual([
      [sceneA, 'age', 'nineteen', false],
      [sceneA, 'appearance', 'Grey eyes', true]
    ])
    // The tombstone is the hidden row itself, not a copy.
    expect(listFactsForEntity(db, mara).find((fact) => fact.hidden)?.id).toBe(hidden?.id)
    // It is this entity's alone: the same words about Tash are still logged.
    replaceSceneFacts(db, sceneA, [grey(tash)])
    expect(said(tash)).toEqual([[sceneA, 'appearance', 'Grey eyes', false]])
  })

  it('keeps a hidden fact out of every scene of its entity, not only the one it was read from', () => {
    replaceSceneFacts(db, sceneA, [grey(mara)])
    setFactHidden(db, listFactsForEntity(db, mara)[0]?.id ?? '', true)
    // Another scene repeats the statement: hidden for good means it is not logged there either.
    expect(
      replaceSceneFacts(db, sceneB, [{ ...grey(mara), value: 'grey eyes.' }, age(mara)])
    ).toEqual([mara])
    expect(said(mara)).toHaveLength(2)
    expect(said(mara)).toEqual(
      expect.arrayContaining([
        [sceneA, 'appearance', 'Grey eyes', true],
        [sceneB, 'age', 'nineteen', false]
      ])
    )
    // A different value of the same attribute is a different statement and is logged.
    replaceSceneFacts(db, sceneB, [{ ...grey(mara), value: 'Green eyes' }])
    expect(said(mara)).toEqual(
      expect.arrayContaining([[sceneB, 'appearance', 'Green eyes', false]])
    )
    // Restoring the fact lifts the tombstone.
    setFactHidden(db, listFactsForEntity(db, mara).find((fact) => fact.hidden)?.id ?? '', false)
    replaceSceneFacts(db, sceneB, [grey(mara)])
    expect(said(mara)).toHaveLength(2)
    expect(said(mara)).toEqual(
      expect.arrayContaining([
        [sceneA, 'appearance', 'Grey eyes', false],
        [sceneB, 'appearance', 'Grey eyes', false]
      ])
    )
  })

  it('rolls the whole replacement back when a row names an unknown entity', () => {
    replaceSceneFacts(db, sceneA, [grey(mara)])
    expect(() => replaceSceneFacts(db, sceneA, [age(mara), age('missing')])).toThrow(/FOREIGN KEY/)
    expect(said(mara)).toEqual([[sceneA, 'appearance', 'Grey eyes', false]])
  })
})

describe('listFactsForEntity / factsForEntities / hasFacts', () => {
  it('lists the hidden facts too, and sends only the visible ones to a prompt', () => {
    replaceSceneFacts(db, sceneA, [grey(mara), age(mara), age(tash)])
    const first = listFactsForEntity(db, mara)[0]
    setFactHidden(db, first?.id ?? '', true)
    expect(listFactsForEntity(db, mara)).toHaveLength(2)
    const visible = factsForEntities(db, [mara, tash])
    expect(visible).toHaveLength(2)
    expect(visible.every((fact) => !fact.hidden)).toBe(true)
    expect(factsForEntities(db, [tash]).map((fact) => fact.entityId)).toEqual([tash])
    expect(factsForEntities(db, [])).toEqual([])
    expect(listFactsForEntity(db, 'missing')).toEqual([])
  })

  it('counts a hidden fact as a fact', () => {
    expect(hasFacts(db, mara)).toBe(false)
    replaceSceneFacts(db, sceneA, [grey(mara)])
    setFactHidden(db, listFactsForEntity(db, mara)[0]?.id ?? '', true)
    expect(hasFacts(db, mara)).toBe(true)
    expect(hasFacts(db, tash)).toBe(false)
  })

  it('loses the facts with their scene and with their entity', () => {
    replaceSceneFacts(db, sceneA, [grey(mara)])
    replaceSceneFacts(db, sceneB, [age(mara), age(tash)])
    deleteNode(db, sceneA)
    expect(said(mara)).toEqual([[sceneB, 'age', 'nineteen', false]])
    deleteEntity(db, mara)
    expect(listFactsForEntity(db, mara)).toEqual([])
    expect(said(tash)).toEqual([[sceneB, 'age', 'nineteen', false]])
  })
})

describe('setFactHidden', () => {
  it('hides and restores a fact, and refuses an unknown id', () => {
    replaceSceneFacts(db, sceneA, [grey(mara)])
    const fact = listFactsForEntity(db, mara)[0]
    if (fact === undefined) throw new Error('no fact stored')
    expect(setFactHidden(db, fact.id, true)).toEqual({ ...fact, hidden: true })
    expect(factsForEntities(db, [mara])).toEqual([])
    expect(setFactHidden(db, fact.id, false)).toEqual(fact)
    expect(factsForEntities(db, [mara])).toEqual([fact])
    try {
      setFactHidden(db, 'missing', true)
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe('NOT_FOUND')
      return
    }
    throw new Error('expected NOT_FOUND')
  })
})
