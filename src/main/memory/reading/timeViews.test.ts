import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyCardFields, type CardFields } from '@shared/memory/claims'
import { SheetMemory, ThreadsMemory, TimelineMemory, type AgeView } from '@shared/memory/views'
import { sinceNodeId } from '@shared/memory/years'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../../document/documentStore'
import { setSceneMeta } from '../../document/sceneMetaStore'
import { activeDraftId } from '../../draft/draftStore'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { createNode, getNode, type TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { scanNamesFor } from '../nameIndexer'
import { createRecord, savePage } from '../recordStore'
import { setSceneDetails } from '../sceneDetailStore'
import { TEST_BOOK_LABELS } from '../testBook/labels'
import { buildTestBookProject, type TestBookProject } from '../testBook/project'
import { upsertCard } from './cardStore'
import { cardAnchorOf, revealIn, seedClaims } from './claimFixture'
import { writeSceneRead } from './sceneReadStore'
import { createTopic } from './topicStore'
import { storedAge, storedYears, threadsMemory, timelineMemory } from './timeViews'
import { sheetMemory } from './views'

/**
 * Threads, story years and ages over a stored book (F-16.23; plan P2b §5.1, §5.3, decision 5):
 * the Timeline (a typed year carried, a flashback skipped, a breaking hint, a year the text states
 * for its own scene only, the next typed year restarting the carry; ages computed from a birth
 * year or stated with the hints since listed, never added up), the Threads as of a scene, a
 * sheet's Threads, Age and *The thread*, and the test book's years and ages labels through the
 * real stores.
 */

let tmp: string
let session: ProjectSession
let db: TreeDb
let one: string
let two: string
let flash: string
let three: string
let four: string
let five: string
let idea: string
let mara: string
let orrin: string
let quay: string

const NOW = new Date(Date.UTC(2026, 9, 13, 12, 0, 0))

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

function record(name: string, categoryId = 'character'): string {
  const made = createRecord(db, { name, categoryId, force: true }, NOW)
  if (!('record' in made)) throw new Error('blocked')
  return made.record.id
}

function scene(title: string, chapter: string, ...paragraphs: string[]): string {
  const id = createNode(db, 'novel', {
    parentId: chapter,
    kind: 'document',
    hierarchyLevel: 'scene',
    title
  }).id
  saveDocument(db, id, doc(...paragraphs))
  return id
}

function details(
  nodeId: string,
  storyYear: number | null,
  time = '',
  flashback: boolean | null = null
): void {
  setSceneDetails(
    db,
    nodeId,
    {
      povRecordId: mara,
      place: { recordId: null, text: '' },
      time: { text: time },
      storyYear,
      alsoHere: [],
      flashback
    },
    NOW
  )
}

/** A card standing on the scene's text, with the given fields and who is on the page. */
function card(
  nodeId: string,
  fields: Partial<CardFields>,
  present: { recordId: string; quote: string; p: number }[] = []
): void {
  upsertCard(
    db,
    {
      nodeId,
      draftId: activeDraftId(db),
      readingId: null,
      line: 'A scene.',
      gist: 'A scene.',
      fields: { ...emptyCardFields(), ...fields },
      present: present.map((entry) => ({ ...entry, verified: true })),
      mood: null,
      theme: null,
      anchor: cardAnchorOf(db, nodeId),
      seen: cardAnchorOf(db, nodeId)
    },
    NOW
  )
}

const field = (value: string, quote: string, p: number, verified = true): CardFields['year'] => ({
  value,
  quote,
  p,
  verified
})

function checked(nodeId: string): void {
  writeSceneRead(
    db,
    {
      nodeId,
      draftId: activeDraftId(db),
      entries: [],
      full: true,
      readingId: null,
      topics: true,
      settled: true
    },
    NOW
  )
}

/** "the missing heir": revealed and opened in 1.1, resolved in 1.4 (three winters later). */
function heir(): string {
  const { recordId } = createTopic(
    db,
    {
      kind: 'thread',
      label: 'the missing heir',
      quote: revealIn(db, one, {
        para: 1,
        quote: 'Mara swore to find the heir',
        label: 'the missing heir'
      })
    },
    NOW
  )
  seedClaims(
    db,
    one,
    [
      {
        recordId,
        slot: 'thread',
        value: 'swears to find the heir',
        how: 'opens',
        quote: 'Mara swore to find the heir',
        para: 1,
        proof: 'verified'
      }
    ],
    NOW
  )
  seedClaims(
    db,
    three,
    [
      {
        recordId,
        slot: 'thread',
        value: 'finds the heir',
        how: 'resolves',
        quote: 'Mara found the heir',
        para: 0,
        proof: 'verified'
      }
    ],
    NOW
  )
  return recordId
}

/** Mara born in 1792 (1.1), nineteen in 1.2. */
function maraAges(): { born: string; stated: string } {
  const [born = ''] = seedClaims(
    db,
    one,
    [{ recordId: mara, slot: 'born', value: '1792', quote: 'Mara was born in 1792', para: 0 }],
    NOW
  )
  const [stated = ''] = seedClaims(
    db,
    two,
    [
      {
        recordId: mara,
        slot: 'age',
        value: 'nineteen',
        quote: 'Mara was nineteen',
        para: 0,
        proof: 'verified'
      }
    ],
    NOW
  )
  return { born, stated }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-time-views-'))
  session = createProject(projectFolderFor(tmp, 'Time'), 'Time', 'novel', {
    storyMemoryOverride: 'v2'
  })
  db = session.connection.orm
  one = manuscriptDocuments(db)[0]?.id ?? ''
  const chapter = getNode(db, one)?.parentId ?? ''
  saveDocument(
    db,
    one,
    doc('Mara was born in 1792.', 'Mara swore to find the heir.', 'Orrin laughed at her.')
  )
  two = scene('Two', chapter, 'Mara was nineteen.')
  flash = scene('Winter', chapter, 'Mara remembered the winter of 1798.')
  three = scene('Three', chapter, 'Three winters later, Mara found the heir.')
  four = scene('Four', chapter, 'In 1815 the town burned.')
  idea = scene('Maybe', chapter, 'Perhaps Mara never leaves.')
  five = scene('Five', chapter, 'Mara slept.')
  setSceneMeta(db, idea, { location: '', pov: '', timeline: '', status: 'idea' })
  mara = record('Mara')
  orrin = record('Orrin')
  quay = record('the Quay', 'setting')
  for (const id of [one, two, flash, three, four, five]) scanNamesFor(db, id, NOW)
  details(one, 1811, 'December, evening')
  for (const id of [two, flash, three, four, five]) details(id, null)
  card(one, {}, [{ recordId: orrin, quote: 'Orrin laughed at her', p: 2 }])
  card(flash, {
    flashback: field('yes', 'Mara remembered the winter of 1798', 0),
    year: field('1798', 'the winter of 1798', 0)
  })
  card(three, { elapsed: field('Three winters later', 'Three winters later', 0, false) })
  card(four, { year: field('1815', 'In 1815 the town burned', 0) })
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const yearText = (row: TimelineMemory['rows'][number]): string => {
  const { year } = row
  if (year.kind === 'unknown') return `unknown since ${year.hint?.text ?? '-'}`
  return year.kind === 'carried'
    ? `${year.value} from ${year.from.ref}`
    : `${year.value} ${year.kind}`
}

const ageText = (age: AgeView | null | undefined): string => {
  if (age === null || age === undefined) return '-'
  if (age.kind === 'computed') return `about ${age.age} (${age.year.from.ref})`
  if (age.kind === 'notBorn') return 'not born'
  if (age.kind === 'bornOnly') return `born ${age.born.year}; year unknown`
  const since = age.since.map((entry) => (entry.kind === 'hint' ? entry.hint.ref : entry.ref))
  return `${age.value} stated ${age.ref}; since ${since.join(',')}`
}

describe('the Timeline (F-16.23, decision 5)', () => {
  it('carries a typed year, skips a flashback, ends at a breaking hint and keeps a stated year to its scene', () => {
    maraAges()
    const timeline = TimelineMemory.parse(timelineMemory(db, null))
    // The Idea scene is no row.
    expect(timeline.rows.map((row) => [row.ref, row.title])).toEqual([
      ['1.1', 'Scene 1'],
      ['1.2', 'Two'],
      ['1.3', 'Winter'],
      ['1.4', 'Three'],
      ['1.5', 'Four'],
      ['1.6', 'Five']
    ])
    expect(timeline.rows.map(yearText)).toEqual([
      '1811 typed',
      '1811 from 1.1',
      '1798 quoted',
      'unknown since Three winters later',
      '1815 quoted',
      'unknown since Three winters later'
    ])
    expect(timeline.rows.map((row) => row.flashback)).toEqual([
      false,
      false,
      true,
      false,
      false,
      false
    ])
    expect(timeline.rows[3]?.elapsed).toMatchObject({
      text: 'Three winters later',
      ref: '1.4',
      breaks: true
    })
    expect(timeline.rows[0]?.time).toBe('December, evening')
  })

  it('gives the ages of who is Here: computed from the birth year, else stated with the hints since', () => {
    maraAges()
    // Orrin's birth year is the author's own Pinned line (P2b-D15).
    savePage(db, orrin, 'pinned', doc('Born: 1790'), NOW)
    const timeline = timelineMemory(db, null)
    const ages = (ref: string): string[] =>
      (timeline.rows.find((row) => row.ref === ref)?.ages ?? []).map(
        (entry) => `${entry.recordId === mara ? 'Mara' : 'Orrin'} ${ageText(entry.age)}`
      )
    expect(ages('1.1')).toEqual(['Mara about 19 (1.1)', 'Orrin about 21 (1.1)'])
    expect(ages('1.2')).toEqual(['Mara about 19 (1.1)'])
    // The flashback's own year: she was six.
    expect(ages('1.3')).toEqual(['Mara about 6 (1.3)'])
    // No year since "Three winters later": the last stated age, the hint listed, never added.
    expect(ages('1.4')).toEqual(['Mara nineteen stated 1.2; since 1.4'])
    expect(ages('1.5')).toEqual(['Mara about 23 (1.5)'])
    // 1.5's own 1815 is listed too, never added up.
    expect(ages('1.6')).toEqual(['Mara nineteen stated 1.2; since 1.4,1.5'])

    // The next typed year restarts the carry.
    details(five, 1820)
    expect(ageText(timelineMemory(db, null).rows[5]?.ages[0]?.age)).toBe('about 28 (1.6)')
  })

  it('shows one record’s age in every row with "Ages of", and none for a record with no age', () => {
    maraAges()
    const rows = timelineMemory(db, mara).rows
    expect(rows.map((row) => row.ages.map((entry) => entry.recordId))).toEqual([
      [mara],
      [mara],
      [mara],
      [mara],
      [mara],
      [mara]
    ])
    expect(timelineMemory(db, quay).rows.every((row) => row.ages.length === 0)).toBe(true)
  })

  it('reads the same years and ages for P3 and the sheets (storedYears, storedAge)', () => {
    const { stated } = maraAges()
    expect(storedYears(db).map((row) => row.year.kind)).toEqual([
      'typed',
      'carried',
      'quoted',
      'unknown',
      'quoted',
      'unknown'
    ])
    expect(storedAge(db, mara, two)).toMatchObject({ kind: 'computed', age: 19 })
    expect(storedAge(db, mara, three)).toMatchObject({
      kind: 'stated',
      claimId: stated,
      since: [{ kind: 'hint', hint: { text: 'Three winters later', nodeId: three } }]
    })
    // As of the Idea scene: the readable scene before it (1.5, 1815).
    expect(storedAge(db, mara, idea)).toMatchObject({ kind: 'computed', age: 23 })
    // 1.5's quoted 1815 is listed beside the hint since 1.2, never added up.
    expect(storedAge(db, mara, null)).toMatchObject({
      kind: 'stated',
      since: [
        { kind: 'hint', hint: { ref: '1.4' } },
        { kind: 'year', value: 1815, ref: '1.5' }
      ]
    })
  })
})

describe('the Timeline’s words and sources (review of P2b slice 5)', () => {
  it('shows a hint in the book’s words, ends the carry on its quote, and gives each row its sources', () => {
    // The reader's value is vague; the quote crosses years: the carry ends, and the quote shows.
    card(three, {
      elapsed: field('some time', 'Three winters later, Mara found the heir', 0, false)
    })
    const rows = timelineMemory(db, null).rows
    const hint = {
      text: 'Three winters later, Mara found the heir',
      quote: 'Three winters later, Mara found the heir',
      para: 0,
      nodeId: three,
      ref: '1.4',
      breaks: true
    }
    expect(rows[3]?.elapsed).toEqual(hint)
    expect(rows[3]?.year).toEqual({ kind: 'unknown', hint })
    expect(rows[5]?.year).toEqual({ kind: 'unknown', hint })
    expect(rows.map((row) => row.sources.map((source) => source.field))).toEqual([
      [],
      [],
      ['year', 'flashback'],
      ['elapsed'],
      ['year'],
      []
    ])
    expect(rows[3]?.sources[0]?.entry).toMatchObject({ value: 'some time', p: 0 })
    // A typed year stands over the quoted one: the card's year is no source of the row's.
    details(four, 1816)
    expect(timelineMemory(db, null).rows[4]?.sources).toEqual([])
  })

  it('gives a character’s sheet the birth year alone where the scene’s year is not known', () => {
    seedClaims(
      db,
      one,
      [{ recordId: mara, slot: 'born', value: '1792', quote: 'Mara was born in 1792', para: 0 }],
      NOW
    )
    checked(one)
    expect(SheetMemory.parse(sheetMemory(db, mara, three)).age).toMatchObject({
      age: {
        kind: 'bornOnly',
        born: { year: 1792, source: 'text', ref: '1.1' },
        hint: { text: 'Three winters later', ref: '1.4' }
      },
      checkedUpTo: { nodeId: one, ref: '1.1' }
    })
    // The Timeline says nothing more than the row's year does.
    expect(timelineMemory(db, mara).rows[3]?.ages).toEqual([])
  })
})

describe('the Flashback switch (F-16.11, F-16.23; the author’s decision 2026-10-14)', () => {
  /** A scene after "Five" with nothing typed and no card: what a flashback before it leaves it. */
  function six(): string {
    const chapter = getNode(db, one)?.parentId ?? ''
    const id = scene('Six', chapter, 'Mara rode on.')
    scanNamesFor(db, id, NOW)
    return id
  }

  it('on, with no card (Use AI off): a typed year there is its own, never carried, and ages there are flashback ages', () => {
    maraAges()
    const after = six()
    // Before: 1.6's typed 1800 carries into 1.7, and so does the age computed from it (Ages of
    // Mara: 1.7 types no POV).
    details(five, 1800)
    let rows = timelineMemory(db, mara).rows
    expect(rows.slice(5).map(yearText)).toEqual(['1800 typed', '1800 from 1.6'])
    expect(rows.slice(5).map((row) => ageText(row.ages[0]?.age))).toEqual([
      'about 8 (1.6)',
      'about 8 (1.6)'
    ])
    // The switch on 1.6 (no card anywhere on it): its year stays its own.
    details(five, 1800, '', true)
    rows = timelineMemory(db, mara).rows
    expect(rows.slice(5).map(yearText)).toEqual(['1800 typed', 'unknown since Three winters later'])
    expect(rows.map((row) => row.flashback)).toEqual([
      false,
      false,
      true,
      false,
      false,
      true,
      false
    ])
    // The flashback's own age; after it, the last age stated outside a flashback, as before.
    expect(rows.slice(5).map((row) => ageText(row.ages[0]?.age))).toEqual([
      'about 8 (1.6)',
      'nineteen stated 1.2; since 1.4,1.5'
    ])
    // A typed switch gives the row no card source to doubt.
    expect(rows[5]?.sources).toEqual([])
    // The same years and ages for the sheets and P3.
    expect(storedYears(db).find((row) => row.nodeId === after)?.year.kind).toBe('unknown')
    expect(ageText(storedAge(db, mara, after))).toBe('nineteen stated 1.2; since 1.4,1.5')
  })

  it('off, the card’s flashback is ignored; unset again, the card counts', () => {
    maraAges()
    details(flash, null, '', false)
    let row = timelineMemory(db, null).rows[2]
    expect(row?.flashback).toBe(false)
    // Its own quoted year stays its scene's; the card's flashback is no source any more.
    expect(row === undefined ? '' : yearText(row)).toBe('1798 quoted')
    expect(row?.sources.map((source) => source.field)).toEqual(['year'])
    // Not a flashback, its quoted 1798 is a year change the stated age lists since.
    expect(ageText(storedAge(db, mara, three))).toBe('nineteen stated 1.2; since 1.3,1.4')
    // Follow the book: the card's checked flashback counts again.
    details(flash, null, '', null)
    row = timelineMemory(db, null).rows[2]
    expect(row?.flashback).toBe(true)
    expect(row?.sources.map((source) => source.field)).toEqual(['year', 'flashback'])
    // On over a card that agrees: a flashback, but the switch's, so no card source for it.
    details(flash, null, '', true)
    row = timelineMemory(db, null).rows[2]
    expect(row?.flashback).toBe(true)
    expect(row?.sources.map((source) => source.field)).toEqual(['year'])
  })
})

describe('the Threads (F-16.23, P2b-D22)', () => {
  it('reads each thread as of a scene: open, then resolved; the author’s with no step, scoped', () => {
    const thread = heir()
    const ashby = record('Ashby’s return', 'thread')
    // An AI-made thread whose only reveal is in an Idea scene is in no view.
    createTopic(
      db,
      {
        kind: 'thread',
        label: 'the leaving',
        quote: revealIn(db, idea, { para: 0, quote: 'Perhaps Mara never leaves', label: 'x' })
      },
      NOW
    )
    let memory = ThreadsMemory.parse(threadsMemory(db, one))
    expect(memory.asOfRef).toBe('1.1')
    expect(memory.threads.map((each) => [each.label, each.status])).toEqual([
      ['the missing heir', 'open'],
      ['Ashby’s return', 'notYet']
    ])
    expect(memory.threads[0]).toMatchObject({
      recordId: thread,
      origin: 'ai',
      opened: { ref: '1.1' },
      last: { ref: '1.1' },
      resolved: null,
      later: 1,
      defining: { quote: 'Mara swore to find the heir' }
    })
    expect(memory.threads[1]).toMatchObject({ recordId: ashby, origin: 'author', steps: [] })
    expect(memory.checkedUpTo).toBeNull()

    checked(one)
    checked(two)
    memory = ThreadsMemory.parse(threadsMemory(db, null))
    expect(memory.asOfRef).toBeNull()
    expect(memory.checkedUpTo).toEqual({ nodeId: two, ref: '1.2' })
    const [found] = memory.threads
    expect([found?.status, found?.resolved?.ref, found?.later]).toEqual(['resolved', '1.4', 0])
    expect(found?.steps.map((step) => [step.step, step.ref, step.value, step.counted])).toEqual([
      ['opens', '1.1', 'swears to find the heir', true],
      ['resolves', '1.4', 'finds the heir', true]
    ])
  })
})

describe('a sheet’s Threads, Age and The thread (F-16.23)', () => {
  it('lists the steps whose paragraph names the character, and its age as of the scene', () => {
    const thread = heir()
    maraAges()
    const sheet = SheetMemory.parse(sheetMemory(db, mara, two))
    expect(
      sheet.threads?.threads.map((each) => [each.label, each.status, each.steps.length])
    ).toEqual([['the missing heir', 'open', 1]])
    expect(sheet.age).toMatchObject({
      age: {
        kind: 'computed',
        age: 19,
        born: { year: 1792, source: 'text', ref: '1.1' },
        year: { kind: 'carried', value: 1811, from: { ref: '1.1' } }
      },
      checkedUpTo: null
    })
    const end = SheetMemory.parse(sheetMemory(db, mara, three))
    expect(end.threads?.threads[0]?.steps.map((step) => step.step)).toEqual(['opens', 'resolves'])
    expect(end.age?.age).toMatchObject({ kind: 'stated', value: 'nineteen', ref: '1.2' })

    // Orrin is named in 1.1, but in no step's paragraph; the book gives him no age.
    const other = SheetMemory.parse(sheetMemory(db, orrin, null))
    expect([other.threads, other.age]).toEqual([
      { threads: [], checkedUpTo: null },
      { age: null, checkedUpTo: null }
    ])
    // A place has Threads but no age.
    expect(SheetMemory.parse(sheetMemory(db, quay, null)).age).toBeNull()

    const own = SheetMemory.parse(sheetMemory(db, thread, one))
    expect([own.threads, own.age, own.knows]).toEqual([null, null, null])
    expect(own.topic).toMatchObject({
      kind: 'thread',
      thread: { recordId: thread, status: 'open' },
      checkedUpTo: null
    })
  })

  it('lists a first-person step on the POV’s sheet though it never names her', () => {
    const thread = heir()
    const chapter = getNode(db, one)?.parentId ?? ''
    const six = scene('Six', chapter, 'I found the heir at last, and Orrin wept.')
    scanNamesFor(db, six, NOW)
    details(six, null)
    seedClaims(
      db,
      six,
      [
        {
          recordId: thread,
          slot: 'thread',
          value: 'finds the heir again',
          how: 'advances',
          quote: 'I found the heir at last',
          para: 0,
          proof: 'verified'
        }
      ],
      NOW
    )
    const steps = (recordId: string): string[] =>
      (SheetMemory.parse(sheetMemory(db, recordId, null)).threads?.threads ?? []).flatMap((each) =>
        each.steps.map((step) => `${step.step} ${step.ref}`)
      )
    // Mara is the typed POV of 1.7 (Six); its "I" is hers.
    expect(steps(mara)).toEqual(['opens 1.1', 'resolves 1.4', 'advances 1.7'])
    // Orrin is named in that paragraph: it is his too.
    expect(steps(orrin)).toEqual(['advances 1.7'])
    // With another POV typed, the "I" is not Mara's.
    setSceneDetails(
      db,
      six,
      {
        povRecordId: orrin,
        place: { recordId: null, text: '' },
        time: { text: '' },
        storyYear: null,
        alsoHere: [],
        flashback: null
      },
      NOW
    )
    expect(steps(mara)).toEqual(['opens 1.1', 'resolves 1.4'])
  })

  it('gives an author’s thread with no step its scoped view, and a secret no time', () => {
    const ashby = record('Ashby’s return', 'thread')
    checked(one)
    const sheet = SheetMemory.parse(sheetMemory(db, ashby, null))
    expect(sheet.topic).toMatchObject({
      kind: 'thread',
      thread: { status: 'notYet', steps: [], later: 0 },
      checkedUpTo: { nodeId: one, ref: '1.1' }
    })
    const secret = createTopic(
      db,
      {
        kind: 'secret',
        label: 'the sold map',
        quote: revealIn(db, one, { para: 1, quote: 'Mara swore to find the heir', label: 'x' })
      },
      NOW
    ).recordId
    const secretSheet = SheetMemory.parse(sheetMemory(db, secret, null))
    expect([secretSheet.threads, secretSheet.age, secretSheet.topic?.kind]).toEqual([
      null,
      null,
      'secret'
    ])
  })
})

describe('the test book’s years and ages through the stores (decision 5)', () => {
  let book: TestBookProject
  let bookDir: string

  beforeEach(() => {
    bookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-time-book-'))
    book = buildTestBookProject(bookDir, NOW)
    const node = (sceneId: string): string => book.scenes.get(sceneId) ?? ''
    // The cards' elapsed hints, standing on the text, as a reading leaves them.
    for (const label of TEST_BOOK_LABELS.years) {
      if (label.elapsed === undefined) continue
      upsertCard(
        book.db,
        {
          nodeId: node(label.scene),
          draftId: activeDraftId(book.db),
          readingId: null,
          line: 'A scene.',
          gist: 'A scene.',
          fields: {
            ...emptyCardFields(),
            elapsed: {
              value: label.elapsed.quote,
              quote: label.elapsed.quote,
              p: label.elapsed.p,
              verified: false
            }
          },
          present: [],
          mood: null,
          theme: null,
          anchor: cardAnchorOf(book.db, node(label.scene)),
          seen: cardAnchorOf(book.db, node(label.scene))
        },
        NOW
      )
    }
    // The stated ages, as the reader stores them.
    for (const claim of TEST_BOOK_LABELS.claims.filter((each) => each.slot === 'age')) {
      seedClaims(
        book.db,
        node(claim.scene),
        [
          {
            recordId: book.records.get(claim.record) ?? null,
            slot: 'age',
            value: claim.value,
            quote: claim.quote,
            para: claim.p,
            proof: 'verified'
          }
        ],
        NOW
      )
    }
  })
  afterEach(() => {
    book.session.close()
    fs.rmSync(bookDir, { recursive: true, force: true })
  })

  it('matches the years and ages labels', () => {
    // h10 is h09's scene in the inactive draft: the node is h09's.
    const sceneOf = new Map(
      [...book.scenes]
        .filter(([sceneId]) => sceneId !== 'h10')
        .map(([sceneId, nodeId]) => [nodeId, sceneId])
    )
    // The planned card (h17, P4) has no words and no year label: a plan, not a read scene.
    const rows = timelineMemory(book.db, null).rows.filter(
      (row) => sceneOf.get(row.nodeId) !== 'h17'
    )
    expect(
      rows.map((row) => {
        const { year } = row
        const scene = sceneOf.get(row.nodeId)
        return year.kind === 'unknown'
          ? [scene, 'unknown', null, year.hint === null ? null : sceneOf.get(year.hint.nodeId)]
          : [
              scene,
              year.kind,
              year.value,
              year.kind === 'carried' ? sceneOf.get(year.from.nodeId) : null
            ]
      })
    ).toEqual(
      TEST_BOOK_LABELS.years.map((label) => [
        label.scene,
        label.source,
        label.year,
        label.source === 'carried'
          ? (label.from ?? null)
          : label.source === 'unknown'
            ? (label.hint ?? null)
            : null
      ])
    )
    for (const label of TEST_BOOK_LABELS.ages) {
      const at = `${label.record} as of ${label.scene}`
      const age = storedAge(
        book.db,
        book.records.get(label.record) ?? '',
        book.scenes.get(label.scene) ?? null
      )
      const expected = label.expect
      if (expected.kind === 'computed') {
        expect(age, at).toMatchObject({ kind: 'computed', age: expected.age })
        continue
      }
      const claim = TEST_BOOK_LABELS.claims.find((each) => each.id === expected.claim)
      expect(age, at).toMatchObject({ kind: 'stated', value: claim?.value })
      expect(
        age?.kind === 'stated'
          ? [...new Set(age.since.map((entry) => sceneOf.get(sinceNodeId(entry))))]
          : null,
        at
      ).toEqual(expected.since)
      // The Timeline's row for that scene, read through `memory:timeline`'s "Ages of".
      const row = timelineMemory(book.db, book.records.get(label.record) ?? null).rows.find(
        (each) => sceneOf.get(each.nodeId) === label.scene
      )
      expect(row?.ages[0]?.age, at).toEqual(age)
    }
  })
})
