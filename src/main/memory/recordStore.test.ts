import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dismissedKey } from '@shared/memory/dismissed'
import { checkMemoryInvariants } from '@shared/memory/invariants'
import { RECORD_ALIASES_MAX } from '@shared/memory/records'
import { sceneSentences } from '@shared/memory/anchor'
import { emptyCardFields } from '@shared/memory/claims'
import { alias, memoryBackfill, nameMention, settings } from '../db/schema'
import { activeDraftId } from '../draft/draftStore'
import { saveDocument } from '../document/documentStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import type { TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { createAuthorTodo, listAuthorTodos } from './authorTodoStore'
import { dismiss, isDismissed, listDismissed } from './dismissedStore'
import { scanNamesFor } from './nameIndexer'
import {
  addAlias,
  createRecord,
  deleteRecord,
  gateName,
  getRecord,
  invariantAliases,
  listRecords,
  requireRecord,
  sameAs,
  savePage,
  setAliases,
  splitRecord,
  updateRecord
} from './recordStore'
import { getCard, upsertCard } from './reading/cardStore'
import { sceneTexts, seedClaims } from './reading/claimFixture'
import { getClaim, invariantClaims } from './reading/claimStore'
import { MEMORY_ROSTER_KEY } from './reading/roster'
import { getSceneDetails, setSceneDetails } from './sceneDetailStore'

let tmp: string
let session: ProjectSession
let db: TreeDb
let scenes: string[]

const NOW = new Date(Date.UTC(2026, 9, 11, 12, 0, 0))

const make = (name: string, aliases: string[] = [], categoryId = 'character'): string => {
  const made = createRecord(
    db,
    { name, categoryId, aliases: aliases.map((text) => ({ text })), force: true },
    NOW
  )
  if (!('record' in made)) throw new Error(`gate blocked ${name}`)
  return made.record.id
}

const page = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

/** The alias invariant over everything the store wrote (P0's `aliasClash`). */
const clean = (): void => {
  expect(
    checkMemoryInvariants({
      claims: [],
      sceneHashes: new Map(),
      aliases: invariantAliases(db),
      citations: []
    })
  ).toEqual([])
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-records-'))
  session = createProject(projectFolderFor(tmp, 'Records'), 'Records', 'novel')
  db = session.connection.orm
  scenes = manuscriptDocuments(db).map((row) => row.id)
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('createRecord (F-16.4)', () => {
  it('creates a record with its name as the main alias and the kind of its category', () => {
    const id = make('Rynna Falsire', ['Rynna'])
    const record = requireRecord(db, id)
    expect(record).toMatchObject({
      name: 'Rynna Falsire',
      kind: 'character',
      categoryId: 'character'
    })
    expect(record.aliases.map((entry) => [entry.text, entry.norm, entry.isMain])).toEqual([
      ['Rynna Falsire', 'rynna falsire', true],
      ['Rynna', 'rynna', false]
    ])
    expect(requireRecord(db, make('Thornmere', [], 'setting')).kind).toBe('place')
    clean()
  })

  it('answers the twin gate and writes nothing, unless the author forces it', () => {
    const liesel = make('Liesel Harrow', ['Liesel'])
    const blocked = createRecord(db, { name: 'Liesl', categoryId: 'character' }, NOW)
    expect(blocked).toEqual({
      gate: { outcome: 'blocked', rule: 'edit', recordId: liesel, matched: 'Liesel Harrow' }
    })
    expect(listRecords(db)).toHaveLength(1)
    const forced = createRecord(db, { name: 'Liesl', categoryId: 'character', force: true }, NOW)
    expect('record' in forced).toBe(true)
    expect(listRecords(db)).toHaveLength(2)
    clean()
  })

  it('refuses a name another record holds unshared, even forced, and an unknown category', () => {
    make('Rynna Falsire', ['Rynna'])
    expect(() =>
      createRecord(db, { name: 'Rynna', categoryId: 'character', force: true }, NOW)
    ).toThrow(/already a name of Rynna Falsire/)
    expect(() => createRecord(db, { name: 'Hesk', categoryId: 'nope' }, NOW)).toThrow(/no category/)
    clean()
  })

  it('lets no secret or thread block a name: labels are not names (P2b-D2)', () => {
    const thread = createRecord(db, { name: "Ashby's Return", categoryId: 'thread' }, NOW)
    const secret = createRecord(db, { name: 'the sold map', categoryId: 'secret' }, NOW)
    expect('record' in thread && 'record' in secret).toBe(true)
    expect(gateName(db, 'Ashby')).toEqual({ outcome: 'clear' })
    expect(gateName(db, 'Map')).toEqual({ outcome: 'clear' })
    const ashby = make('Ashby')
    expect(gateName(db, 'Ashby')).toMatchObject({ outcome: 'blocked', recordId: ashby })
    // A character named like a topic's label is made at once, no warning.
    expect('record' in createRecord(db, { name: 'Sold Map', categoryId: 'character' }, NOW)).toBe(
      true
    )
    clean()
  })

  it('blocks a dismissed name silently in the gate', () => {
    dismiss(
      db,
      { kind: 'name', key: dismissedKey({ kind: 'name', name: 'Michaelmas' }), label: 'x' },
      NOW
    )
    expect(gateName(db, 'Michaelmas')).toMatchObject({ outcome: 'blocked', rule: 'dismissed' })
  })
})

describe('setAliases and addAlias', () => {
  it('renames, keeps unchanged rows, sets case rules and shared flags, and dismisses removed nicknames', () => {
    const id = make('Mr. Harrow', ['Harrow', 'Papa'])
    const before = requireRecord(db, id)
    const papa = before.aliases.find((entry) => entry.text === 'Papa')
    const after = setAliases(
      db,
      id,
      {
        name: { text: 'Mr. Harrow' },
        aliases: [
          { text: 'Harrow', shared: true },
          { text: 'Will', caseRule: 'exact' }
        ]
      },
      NOW
    )
    expect(after.aliases.map((entry) => [entry.text, entry.caseRule, entry.shared])).toEqual([
      ['Mr. Harrow', 'auto', false],
      ['Harrow', 'auto', true],
      ['Will', 'exact', false]
    ])
    expect(after.aliases[1]?.id).toBe(before.aliases[1]?.id)
    expect(
      isDismissed(
        db,
        'alias',
        dismissedKey({ kind: 'alias', recordId: id, alias: papa?.text ?? '' })
      )
    ).toBe(true)
    // Adding it back takes it off Dismissed.
    setAliases(db, id, { name: { text: 'Mr. Harrow' }, aliases: [{ text: 'Papa' }] }, NOW)
    expect(
      isDismissed(db, 'alias', dismissedKey({ kind: 'alias', recordId: id, alias: 'Papa' }))
    ).toBe(false)
    clean()
  })

  it('refuses a clash with another record’s unshared name, naming the owner, and allows it shared on both', () => {
    const mr = make('Mr. Harrow', [])
    const mrs = make('Mrs. Harrow', [])
    setAliases(db, mr, { name: { text: 'Mr. Harrow' }, aliases: [{ text: 'Harrow' }] }, NOW)
    expect(() =>
      setAliases(db, mrs, { name: { text: 'Mrs. Harrow' }, aliases: [{ text: 'Harrow' }] }, NOW)
    ).toThrow(/already a name of Mr. Harrow/)
    expect(() =>
      setAliases(
        db,
        mrs,
        { name: { text: 'Mrs. Harrow' }, aliases: [{ text: 'Harrow', shared: true }] },
        NOW
      )
    ).toThrow(/already a name of Mr. Harrow/)
    setAliases(
      db,
      mr,
      { name: { text: 'Mr. Harrow' }, aliases: [{ text: 'Harrow', shared: true }] },
      NOW
    )
    setAliases(
      db,
      mrs,
      { name: { text: 'Mrs. Harrow' }, aliases: [{ text: 'Harrow', shared: true }] },
      NOW
    )
    clean()
    expect(() =>
      setAliases(
        db,
        mrs,
        { name: { text: 'Mrs. Harrow' }, aliases: [{ text: 'Ma' }, { text: 'ma' }] },
        NOW
      )
    ).toThrow(/listed twice/)
  })

  it('leaves no Dismissed row for a renamed record’s old name', () => {
    const id = make('Mara Vel')
    setAliases(db, id, { name: { text: 'Mara Vell' }, aliases: [] }, NOW)
    expect(listDismissed(db).items).toEqual([])
    expect(requireRecord(db, id).name).toBe('Mara Vell')
  })

  it('takes a name off Dismissed’s Not a name list when the author makes it a record or a nickname', () => {
    const notAName = (name: string): void => {
      dismiss(
        db,
        {
          kind: 'name',
          key: dismissedKey({ kind: 'name', name }),
          label: `${name}: not a name`
        },
        NOW
      )
    }
    notAName('Hesk')
    expect(createRecord(db, { name: 'Hesk', categoryId: 'character' }, NOW)).toMatchObject({
      gate: { rule: 'dismissed' }
    })
    make('Hesk')
    notAName('Ry')
    const rynna = make('Rynna Falsire')
    addAlias(db, rynna, { text: 'Ry', origin: 'confirmed' }, NOW)
    expect(listDismissed(db).items).toEqual([])
  })

  it('caps the other names a nickname, a merge or a split can leave a record', () => {
    const others = Array.from({ length: RECORD_ALIASES_MAX }, (_, i) => `Name${String(i)}x`)
    const full = make('Full Record', others)
    expect(() => addAlias(db, full, { text: 'One More' }, NOW)).toThrow(/at most/)
    const merged = make('Merged Away')
    expect(() => sameAs(db, full, merged, NOW)).toThrow(/at most/)
    const donor = make('Donor', ['Spare'])
    const spare = requireRecord(db, donor).aliases.find((entry) => entry.text === 'Spare')
    expect(() => splitRecord(db, donor, [spare?.id ?? ''], full, NOW)).toThrow(/at most/)
    expect(requireRecord(db, full).aliases).toHaveLength(RECORD_ALIASES_MAX + 1)
  })

  it('adds a confirmed nickname once, and refuses one another record holds', () => {
    const rynna = make('Rynna Falsire')
    const tomas = make('Tomas Vell', ['Ry'])
    expect(() => addAlias(db, rynna, { text: 'Ry', origin: 'confirmed' }, NOW)).toThrow(
      /Tomas Vell/
    )
    setAliases(db, tomas, { name: { text: 'Tomas Vell' }, aliases: [] }, NOW)
    const added = addAlias(db, rynna, { text: 'Ry', origin: 'confirmed' }, NOW)
    expect(added.aliases.find((entry) => entry.text === 'Ry')?.origin).toBe('confirmed')
    expect(addAlias(db, rynna, { text: 'ry' }, NOW).aliases).toHaveLength(2)
    clean()
  })
})

describe('pages, update and delete', () => {
  it('saves Pinned and Ideas, a blank page as null', () => {
    const id = make('Mara')
    expect(savePage(db, id, 'pinned', page('Eyes: grey'), NOW).pinned).toEqual(page('Eyes: grey'))
    expect(savePage(db, id, 'ideas', page('   '), NOW).ideas).toBeNull()
    expect(updateRecord(db, id, { categoryId: 'faction' }, NOW).kind).toBe('group')
  })

  it('deletes a record with its names, mentions, dismissals, and out of every "also here"', () => {
    const id = make('Mara')
    const scene = scenes[0] ?? ''
    saveDocument(db, scene, page('Mara waited.'))
    scanNamesFor(db, scene, NOW)
    setSceneDetails(
      db,
      scene,
      {
        povRecordId: id,
        place: { recordId: null, text: '' },
        time: { text: '' },
        storyYear: null,
        alsoHere: [id]
      },
      NOW
    )
    dismiss(db, { kind: 'alias', key: `${id}|m`, recordId: id, label: 'x' }, NOW)
    deleteRecord(db, id)
    expect(getRecord(db, id)).toBeNull()
    expect(db.select().from(alias).all()).toEqual([])
    expect(db.select().from(nameMention).all()).toEqual([])
    expect(listDismissed(db).count).toBe(0)
    expect(getSceneDetails(db, scene)).toMatchObject({ povRecordId: null, alsoHere: [], gone: [] })
  })
})

describe('sameAs (F-16.4)', () => {
  it('moves names and pages and re-points mentions, details, to-dos and dismissals, then deletes', () => {
    const keep = make('Rynna Falsire', ['Rynna'])
    const merge = make('Ry Falsire', ['Ry', 'Rynna Falsire the Younger'])
    const other = make('Tomas Vell')
    savePage(db, keep, 'pinned', page('Eyes: grey'), NOW)
    savePage(db, merge, 'pinned', page('Hair: red'), NOW)
    savePage(db, merge, 'ideas', page('A twin?'), NOW)
    const scene = scenes[0] ?? ''
    saveDocument(db, scene, page('Ry Falsire and Tomas Vell met Rynna.'))
    scanNamesFor(db, scene, NOW)
    setSceneDetails(
      db,
      scene,
      {
        povRecordId: merge,
        place: { recordId: merge, text: '' },
        time: { text: '' },
        storyYear: 1811,
        alsoHere: [merge, keep, other]
      },
      NOW
    )
    createAuthorTodo(db, { text: 'Check Ry', nodeId: null, recordId: merge }, NOW)
    dismiss(
      db,
      {
        kind: 'alias',
        key: dismissedKey({ kind: 'alias', recordId: merge, alias: 'Red' }),
        recordId: merge,
        label: 'x'
      },
      NOW
    )
    dismiss(
      db,
      {
        kind: 'notSame',
        key: dismissedKey({ kind: 'notSame', a: merge, b: other }),
        recordId: merge,
        label: 'y'
      },
      NOW
    )
    dismiss(
      db,
      {
        kind: 'split',
        key: dismissedKey({ kind: 'split', a: merge, b: keep }),
        recordId: merge,
        label: 'z'
      },
      NOW
    )

    const { record, droppedImage } = sameAs(db, keep, merge, NOW)
    expect(droppedImage).toBeNull()
    expect(record.name).toBe('Rynna Falsire')
    expect(record.aliases.map((entry) => [entry.text, entry.isMain])).toEqual([
      ['Rynna Falsire', true],
      ['Rynna', false],
      ['Ry Falsire', false],
      ['Ry', false],
      ['Rynna Falsire the Younger', false]
    ])
    expect(record.pinned?.content).toHaveLength(2)
    expect(record.ideas).toEqual(page('A twin?'))
    expect(getRecord(db, merge)).toBeNull()
    const mentions = db.select().from(nameMention).where(eq(nameMention.nodeId, scene)).all()
    expect(mentions.map((row) => row.recordId).sort()).toEqual([keep, keep, other].sort())
    expect(getSceneDetails(db, scene)).toMatchObject({
      povRecordId: keep,
      place: { recordId: keep },
      alsoHere: [keep, other]
    })
    expect(listAuthorTodos(db)[0]?.recordId).toBe(keep)
    const tombstones = listDismissed(db).items
    expect(tombstones.map((row) => [row.kind, row.key, row.recordId]).sort()).toEqual(
      [
        ['alias', dismissedKey({ kind: 'alias', recordId: keep, alias: 'Red' }), keep],
        ['notSame', dismissedKey({ kind: 'notSame', a: keep, b: other }), keep]
      ].sort()
    )
    clean()
  })

  it('refuses a record merged into itself', () => {
    const id = make('Mara')
    expect(() => sameAs(db, id, id, NOW)).toThrow(/itself/)
  })
})

describe('splitRecord (F-16.4)', () => {
  it('moves nicknames to a new record and writes a split dismissal', () => {
    const id = make('Rynna Falsire', ['Rynna', 'Ry', 'Ryn'])
    const record = requireRecord(db, id)
    const moving = record.aliases.filter((entry) => entry.text === 'Ry' || entry.text === 'Ryn')
    const { from, into } = splitRecord(
      db,
      id,
      moving.map((entry) => entry.id),
      null,
      NOW
    )
    expect(from.aliases.map((entry) => entry.text)).toEqual(['Rynna Falsire', 'Rynna'])
    expect(into).toMatchObject({ name: 'Ry', categoryId: 'character' })
    expect(into.aliases.map((entry) => entry.text)).toEqual(['Ry', 'Ryn'])
    expect(isDismissed(db, 'split', dismissedKey({ kind: 'split', a: into.id, b: id }))).toBe(true)
    clean()
  })

  it('moves nicknames to an existing record, dropping one it already has, and refuses the main name', () => {
    const id = make('Rynna Falsire', ['Ry', 'Falsire'])
    const other = make('Jem Falsire', ['Falsire the Elder'])
    setAliases(db, other, { name: { text: 'Jem Falsire' }, aliases: [] }, NOW)
    const record = requireRecord(db, id)
    const main = record.aliases.find((entry) => entry.isMain)
    expect(() => splitRecord(db, id, [main?.id ?? ''], null, NOW)).toThrow(/keeps its own name/)
    const falsire = record.aliases.find((entry) => entry.text === 'Falsire')
    const { into } = splitRecord(db, id, [falsire?.id ?? ''], other, NOW)
    expect(into.aliases.map((entry) => entry.text)).toEqual(['Jem Falsire', 'Falsire'])
    expect(isDismissed(db, 'split', dismissedKey({ kind: 'split', a: id, b: other }))).toBe(true)
    clean()
  })
})

describe('the reading’s evidence through merge, split and delete (F-16.17, plan P2a §1.4)', () => {
  /** The claim invariants over the active draft against the scene as stored. */
  const claimsClean = (): void => {
    const scene = scenes[0] ?? ''
    expect(
      checkMemoryInvariants({
        claims: invariantClaims(db),
        sceneHashes: new Map([
          [scene, new Set(sceneSentences(sceneTexts(db, scene)).map((each) => each.hash))]
        ]),
        aliases: invariantAliases(db),
        citations: []
      })
    ).toEqual([])
  }
  const rosterMarked = (): boolean =>
    db.select().from(settings).where(eq(settings.key, MEMORY_ROSTER_KEY)).get() === undefined
  const seedRoster = (): void => {
    db.insert(settings).values({ key: MEMORY_ROSTER_KEY, value: '{}' }).run()
  }

  beforeEach(() => {
    saveDocument(
      db,
      scenes[0] ?? '',
      page("Ry ran. Ry's eyes were grey. Rynna told Ry. She smiled at him.")
    )
  })

  it('re-points claims, the card, back-fill rows and Not right keys on Same as…', () => {
    const keep = make('Rynna')
    const merge = make('Ry')
    const [subject, spoken] = seedClaims(
      db,
      scenes[0] ?? '',
      [
        { recordId: merge, slot: 'eyes', value: 'grey', quote: "Ry's eyes were grey", para: 0 },
        {
          recordId: keep,
          slot: 'relation',
          value: 'told',
          quote: 'Rynna told Ry',
          para: 0,
          objectId: merge,
          speakerId: merge,
          proof: 'verified'
        }
      ],
      NOW
    )
    upsertCard(
      db,
      {
        nodeId: scenes[0] ?? '',
        draftId: activeDraftId(db),
        readingId: null,
        line: 'Ry runs.',
        gist: 'A gist.',
        fields: {
          ...emptyCardFields(),
          pov: { value: merge, quote: 'Ry ran', p: 0, verified: true }
        },
        present: [
          { recordId: merge, quote: 'Ry ran', p: 0, verified: true },
          { recordId: keep, quote: 'Rynna told Ry', p: 0, verified: true }
        ],
        mood: null,
        theme: null,
        anchor: [],
        seen: []
      },
      NOW
    )
    const third = make('Tamsin')
    const [waits] = seedClaims(
      db,
      scenes[0] ?? '',
      [
        {
          recordId: null,
          state: 'waiting',
          subjectText: null,
          pending: { kind: 'subject', candidates: [merge, third, keep] },
          slot: 'traits',
          value: 'smiling',
          quote: 'She smiled at him',
          para: 0,
          proof: 'verified'
        }
      ],
      NOW
    )
    db.insert(memoryBackfill)
      .values([
        { recordId: merge, norm: 'ry', state: 'due', created: 'x' },
        { recordId: merge, norm: 'rynna', state: 'due', created: 'x' },
        { recordId: keep, norm: 'rynna', state: 'done', created: 'x' }
      ])
      .run()
    const key = dismissedKey({
      kind: 'notRight',
      recordId: merge,
      slot: 'hair',
      value: 'red',
      stating: ['h']
    })
    dismiss(db, { kind: 'notRight', key, recordId: merge, label: 'Ry: hair red is not right' }, NOW)
    seedRoster()

    sameAs(db, keep, merge, NOW)
    expect(getClaim(db, subject ?? '')?.recordId).toBe(keep)
    expect(getClaim(db, spoken ?? '')).toMatchObject({
      recordId: keep,
      objectId: keep,
      speakerId: keep
    })
    const card = getCard(db, scenes[0] ?? '', activeDraftId(db))
    expect(card?.present.map((each) => each.recordId)).toEqual([keep])
    expect(card?.fields.pov?.value).toBe(keep)
    expect(
      db
        .select()
        .from(memoryBackfill)
        .all()
        .map((row) => [row.recordId, row.norm, row.state])
        .sort()
    ).toEqual([
      [keep, 'ry', 'due'],
      [keep, 'rynna', 'done']
    ])
    expect(
      isDismissed(
        db,
        'notRight',
        dismissedKey({
          kind: 'notRight',
          recordId: keep,
          slot: 'hair',
          value: 'red',
          stating: ['h']
        })
      )
    ).toBe(true)
    // A claim waiting among the merged record and others now waits on the kept one, once.
    expect(getClaim(db, waits ?? '')?.pending).toEqual({
      kind: 'subject',
      candidates: [keep, third]
    })
    expect(rosterMarked()).toBe(true)
    claimsClean()
  })

  it('moves on Split the claims a moved name pinned, and leaves pronoun claims', () => {
    const id = make('Rynna', ['Ry'])
    const ry = requireRecord(db, id).aliases.find((entry) => entry.text === 'Ry')?.id ?? ''
    const [named, pronoun, own] = seedClaims(
      db,
      scenes[0] ?? '',
      [
        {
          recordId: id,
          slot: 'eyes',
          value: 'grey',
          quote: "Ry's eyes were grey",
          para: 0,
          subjectText: 'Ry'
        },
        {
          recordId: id,
          slot: 'traits',
          value: 'smiling',
          quote: 'She smiled at him',
          para: 0,
          subjectText: null,
          proof: 'verified'
        },
        {
          recordId: id,
          slot: 'history',
          value: 'told Ry',
          quote: 'Rynna told Ry',
          para: 0,
          subjectText: 'Rynna',
          proof: 'verified'
        }
      ],
      NOW
    )
    upsertCard(
      db,
      {
        nodeId: scenes[0] ?? '',
        draftId: activeDraftId(db),
        readingId: null,
        line: 'Ry runs.',
        gist: 'A gist.',
        fields: { ...emptyCardFields(), pov: { value: id, quote: 'Ry ran', p: 0, verified: true } },
        present: [
          { recordId: id, quote: "Ry's eyes were grey", p: 0, verified: true },
          { recordId: id, quote: 'Rynna told Ry', p: 0, verified: true }
        ],
        mood: null,
        theme: null,
        anchor: [],
        seen: []
      },
      NOW
    )
    seedRoster()
    const { into } = splitRecord(db, id, [ry], null, NOW)
    expect(getClaim(db, named ?? '')?.recordId).toBe(into.id)
    expect(getClaim(db, pronoun ?? '')?.recordId).toBe(id)
    expect(getClaim(db, own ?? '')?.recordId).toBe(id)
    // The card's entries named only by the moved name move; one naming both stays.
    const card = getCard(db, scenes[0] ?? '', activeDraftId(db))
    expect(card?.fields.pov?.value).toBe(into.id)
    expect(card?.present.map((each) => each.recordId)).toEqual([into.id, id])
    expect(rosterMarked()).toBe(true)
    claimsClean()
  })

  it('drops a deleted record’s claims and clears it where it was the object', () => {
    const gone = make('Ry')
    const stays = make('Rynna')
    const [own, about] = seedClaims(
      db,
      scenes[0] ?? '',
      [
        { recordId: gone, slot: 'eyes', value: 'grey', quote: "Ry's eyes were grey", para: 0 },
        {
          recordId: stays,
          slot: 'relation',
          value: 'told',
          quote: 'Rynna told Ry',
          para: 0,
          objectId: gone,
          proof: 'verified'
        }
      ],
      NOW
    )
    seedRoster()
    deleteRecord(db, gone)
    expect(getClaim(db, own ?? '')).toBeNull()
    expect(getClaim(db, about ?? '')?.objectId).toBeNull()
    expect(rosterMarked()).toBe(true)
    claimsClean()
  })
})
