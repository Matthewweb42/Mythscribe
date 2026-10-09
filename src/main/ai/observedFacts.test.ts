import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExtractedFact } from '@shared/observedFacts'
import { SUMMARY_KNOWN_NAMES_MAX } from '@shared/summary'
import { createEntity, deleteEntity, listEntities, updateEntity } from '../entity/entityStore'
import { listFactsForEntity, setFactHidden } from '../entity/factStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { getObservedDismissed } from '../project/settingsStore'
import { createTag, listTags } from '../tag/tagStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { applyObservedFacts, knownNames } from './observedFacts'

let tmp: string
let session: ProjectSession
let db: TreeDb
let scene: string

const TEXT =
  'Mara Vell reached the ferry landing at dusk. A rose grew by the post. Rose was late, and ' +
  'the Toll had doubled since spring.'

const fact = (over: Partial<ExtractedFact> = {}): ExtractedFact => ({
  entity: 'Mara Vell',
  kind: 'character',
  attribute: 'age',
  value: 'nineteen',
  quote: 'She was nineteen.',
  ...over
})

/** The stored facts of the entity of this name, as attribute/value pairs. */
function stated(name: string): [string, string][] {
  const entity = listEntities(db).find((candidate) => candidate.name === name)
  return entity === undefined
    ? []
    : listFactsForEntity(db, entity.id).map((row) => [row.attribute, row.value])
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-observed-'))
  session = createProject(projectFolderFor(tmp, 'Observed'), 'Observed', 'novel')
  db = session.connection.orm
  scene = listNodes(db).find((row) => row.kind === 'document' && row.sectionType === null)?.id ?? ''
  if (!scene) throw new Error('skeleton not seeded')
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('knownNames (F-5.16)', () => {
  it('lists nothing for a project with no entity and no story tag', () => {
    expect(knownNames(db, TEXT)).toEqual({ character: [], setting: [], world: [] })
  })

  it('lists the entities the scene names, by kind, as the author spells them, whatever the case in the text', () => {
    createEntity(db, { kind: 'character', name: 'MARA  Vell' })
    createEntity(db, { kind: 'setting', name: 'Ferry Landing' })
    createEntity(db, { kind: 'world', name: 'The Toll' })
    createEntity(db, { kind: 'character', name: 'Tomas' })
    // "Mar" is not a word of the scene: a name must stand on word boundaries.
    createEntity(db, { kind: 'character', name: 'Mar' })
    expect(knownNames(db, TEXT)).toEqual({
      character: ['MARA  Vell'],
      setting: ['Ferry Landing'],
      world: ['The Toll']
    })
  })

  it('lists a story tag no entity carries as the scene spells it; a character tag must read as a proper noun', () => {
    createTag(db, { name: 'rose', category: 'character', color: '#112233' })
    createTag(db, { name: 'ferry-landing', category: 'setting', color: '#112233' })
    createTag(db, { name: 'toll', category: 'worldBuilding', color: '#112233' })
    createTag(db, { name: 'dusk', category: 'tone', color: '#112233' })
    createTag(db, { name: 'tomas', category: 'character', color: '#112233' })
    expect(knownNames(db, TEXT)).toEqual({
      // The flower comes first in the text and is passed over for the person.
      character: ['Rose'],
      setting: ['ferry landing'],
      world: ['Toll']
    })
    expect(knownNames(db, 'A rose grew by the post.').character).toEqual([])
  })

  it('lists an entity once: its own tag does not name it a second time', () => {
    createEntity(db, { kind: 'character', name: 'Rose' })
    expect(listTags(db).map((tag) => tag.name)).toContain('rose')
    expect(knownNames(db, TEXT).character).toEqual(['Rose'])
  })

  it('caps the whole list, spent in kind order', () => {
    const text = Array.from({ length: SUMMARY_KNOWN_NAMES_MAX + 2 }, (_, i) => `Person${i}`).join(
      ' met '
    )
    for (let i = 0; i < SUMMARY_KNOWN_NAMES_MAX; i += 1) {
      createEntity(db, { kind: 'character', name: `Person${i}` })
    }
    createEntity(db, { kind: 'setting', name: `Person${SUMMARY_KNOWN_NAMES_MAX}` })
    const known = knownNames(db, text)
    expect(known.character).toHaveLength(SUMMARY_KNOWN_NAMES_MAX)
    expect(known.setting).toEqual([])
  })
})

describe('applyObservedFacts (F-5.16, F-9.13)', () => {
  it('creates a missing entity as AI-made on the blank template, with its tag, and stores the fact', () => {
    const change = applyObservedFacts(db, scene, [fact()], TEXT)
    const mara = listEntities(db).find((entity) => entity.name === 'Mara Vell')
    expect(mara).toMatchObject({ kind: 'character', template: 'blank', origin: 'ai', fields: {} })
    expect(change.created).toHaveLength(1)
    expect(change.created[0]?.entity).toEqual(mara)
    expect(change.created[0]?.tagChange).toMatchObject({
      created: true,
      tag: { name: 'mara-vell', category: 'character' }
    })
    expect(mara?.tagId).toBe(change.created[0]?.tagChange?.tag.id)
    expect(change.entityIds).toEqual([mara?.id])
    expect(change.skipped).toBe(0)
    expect(listFactsForEntity(db, mara?.id ?? '')).toMatchObject([
      {
        nodeId: scene,
        attribute: 'age',
        value: 'nineteen',
        quote: 'She was nineteen.',
        hidden: false
      }
    ])
  })

  it("attaches to the existing entity by name key and creates nothing; the entity stays the author's", () => {
    const mara = createEntity(db, { kind: 'character', name: 'Mara Vell' }).entity
    const change = applyObservedFacts(db, scene, [fact({ entity: '  mara   VELL ' })], TEXT)
    expect(change.created).toEqual([])
    expect(change.entityIds).toEqual([mara.id])
    expect(listEntities(db)).toHaveLength(1)
    expect(listEntities(db)[0]?.origin).toBe('author')
  })

  it('attaches a name that exists under another kind rather than creating a twin, when that kind carries the attribute', () => {
    const ash = createEntity(db, { kind: 'setting', name: 'Ash' }).entity
    const change = applyObservedFacts(
      db,
      scene,
      [
        fact({ entity: 'Ash', kind: 'world', attribute: 'description', value: 'A burnt town' }),
        // A setting has no age: the fact has nowhere to go.
        fact({ entity: 'Ash', kind: 'character', attribute: 'age', value: 'old' })
      ],
      TEXT
    )
    expect(change.created).toEqual([])
    expect(change.skipped).toBe(1)
    expect(listEntities(db)).toHaveLength(1)
    expect(stated('Ash')).toEqual([['description', 'A burnt town']])
    expect(change.entityIds).toEqual([ash.id])
  })

  it('resolves a differently punctuated name through the tag its entity carries', () => {
    const vell = createEntity(db, { kind: 'character', name: 'Dr. Vell' }).entity
    const change = applyObservedFacts(db, scene, [fact({ entity: 'Dr Vell' })], TEXT)
    expect(change.created).toEqual([])
    expect(change.entityIds).toEqual([vell.id])
  })

  it('creates one entity for a name stated twice, and links the tag the bank already has', () => {
    createTag(db, { name: 'tomas', category: 'character', color: '#112233' })
    const change = applyObservedFacts(
      db,
      scene,
      [fact({ entity: 'Tomas' }), fact({ entity: 'tomas', attribute: 'gender', value: 'man' })],
      TEXT
    )
    expect(change.created).toHaveLength(1)
    expect(change.created[0]?.tagChange).toMatchObject({ created: false, tag: { name: 'tomas' } })
    expect(stated('Tomas').sort()).toEqual([
      ['age', 'nineteen'],
      ['gender', 'man']
    ])
  })

  it('does not re-create an entity the author deleted, and does once the author makes it again', () => {
    applyObservedFacts(db, scene, [fact()], TEXT)
    const made = listEntities(db)[0]
    deleteEntity(db, made?.id ?? '')
    expect(getObservedDismissed(db).names).toEqual([{ kind: 'character', nameKey: 'mara vell' }])
    const change = applyObservedFacts(db, scene, [fact(), fact({ entity: 'Tomas' })], TEXT)
    expect(change.skipped).toBe(1)
    expect(listEntities(db).map((entity) => entity.name)).toEqual(['Tomas'])
    const again = createEntity(db, { kind: 'character', name: 'Mara Vell' }).entity
    expect(applyObservedFacts(db, scene, [fact()], TEXT).entityIds).toContain(again.id)
    expect(stated('Mara Vell')).toEqual([['age', 'nineteen']])
  })

  it('keeps what a re-read still finds (sticky), keeps a hidden one hidden, and drops a fact only when its quote leaves the scene', () => {
    const text = `${TEXT} She was nineteen. Her goal: Cross.`
    applyObservedFacts(
      db,
      scene,
      [fact(), fact({ attribute: 'gender', value: 'woman', quote: 'Mara Vell' })],
      text
    )
    const mara = listEntities(db)[0]
    const age = listFactsForEntity(db, mara?.id ?? '').find((row) => row.attribute === 'age')
    setFactHidden(db, age?.id ?? '', true)
    const change = applyObservedFacts(
      db,
      scene,
      [fact(), fact({ attribute: 'goals', value: 'Cross', quote: 'Her goal: Cross.' })],
      text
    )
    expect(change.created).toEqual([])
    expect(change.added.map((row) => row.attribute)).toEqual(['goals'])
    // Not stated again, but its quote is still in the scene: it stays (D13).
    expect(
      listFactsForEntity(db, mara?.id ?? '')
        .map((row) => [row.attribute, row.hidden])
        .sort()
    ).toEqual([
      ['age', true],
      ['gender', false],
      ['goals', false]
    ])
    // The scene cut below the minimum: every visible fact has lost its quote; the tombstone stays.
    expect(applyObservedFacts(db, scene, [], '')).toMatchObject({
      entityIds: [mara?.id],
      added: [],
      created: [],
      skipped: 0
    })
    expect(stated('Mara Vell')).toEqual([['age', 'nineteen']])
  })

  it('leaves an AI-made entity marked until the author edits it; facts alone never flip it', () => {
    applyObservedFacts(db, scene, [fact()], TEXT)
    applyObservedFacts(db, scene, [fact({ value: 'twenty' })], TEXT)
    const mara = listEntities(db)[0]
    expect(mara?.origin).toBe('ai')
    expect(updateEntity(db, mara?.id ?? '', { body: 'Mine now.' }).entity.origin).toBe('author')
  })
})
