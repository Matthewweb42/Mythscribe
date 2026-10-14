import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyCardFields, type CardFields } from '@shared/memory/claims'
import { STORY_NOTES_VALUES_MARK } from '@shared/memory/storyNotes'
import { emptySceneMeta } from '@shared/sceneMeta'
import { STORY_BIBLE_TOKEN_BUDGET } from '@shared/storyBible'
import type { TiptapNodeT } from '@shared/tiptap'
import { buildSceneMood } from '../../ai/context/sceneMood'
import { storyMapItems } from '../../ai/context/storyTime'
import { saveDocument } from '../../document/documentStore'
import { getSceneMeta, setSceneMeta } from '../../document/sceneMetaStore'
import { activeDraftId } from '../../draft/draftStore'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { createNode, getNode, listNodes, type TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { scanNamesFor } from '../nameIndexer'
import { createRecord } from '../recordStore'
import { setSceneDetails } from '../sceneDetailStore'
import { buildStoryNotes, storyNotesFacts, typedSceneMeta } from '../storyNotes'
import { cardLines, cardMoodOf, hereTest, promptCard, promptCards } from './cardContext'
import { upsertCard } from './cardStore'
import { cardAnchorOf, seedClaims } from './claimFixture'

/**
 * The readers re-pointed from stored summaries to v2 cards (F-16.20): the card as they take it
 * (only what stands on the text), the card lines, the mood, and what the Story notes block gains
 * (Here from the card, the book's values, the mood, the effective scene line).
 */

let tmp: string
let session: ProjectSession
let db: TreeDb
let one: string
let two: string
let mara: string
let tomas: string

const NOW = new Date(Date.UTC(2026, 9, 12, 12, 0, 0))

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

function record(name: string, categoryId = 'character'): string {
  const made = createRecord(db, { name, categoryId, force: true }, NOW)
  if (!('record' in made)) throw new Error('blocked')
  return made.record.id
}

/** Scene one's card: Mara's POV and Tomas on the page, both verified, the place in its quote. */
function cardOne(fields: Partial<CardFields> = {}): void {
  upsertCard(
    db,
    {
      nodeId: one,
      draftId: activeDraftId(db),
      readingId: null,
      line: 'Mara waits at the Quay for Tomas.',
      gist: 'Mara waits at the Quay in the cold; Tomas comes late with the lamp.',
      fields: {
        ...emptyCardFields(),
        pov: { value: mara, quote: "Mara's eyes were grey", p: 1, verified: true },
        where: { value: 'the Quay', quote: 'She waited by the Quay', p: 1, verified: false },
        ...fields
      },
      present: [{ recordId: tomas, quote: 'Tomas brought the lamp', p: 2, verified: true }],
      mood: 'tense',
      theme: 'waiting',
      anchor: cardAnchorOf(db, one),
      seen: cardAnchorOf(db, one)
    },
    NOW
  )
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-card-readers-'))
  session = createProject(projectFolderFor(tmp, 'Cards'), 'Cards', 'novel')
  db = session.connection.orm
  one = manuscriptDocuments(db)[0]?.id ?? ''
  const chapter = getNode(db, one)?.parentId ?? ''
  two = createNode(db, 'novel', {
    parentId: chapter,
    kind: 'document',
    hierarchyLevel: 'scene',
    title: 'Two'
  }).id
  saveDocument(
    db,
    one,
    doc(
      'The ridge was cold.',
      "Mara's eyes were grey. She waited by the Quay.",
      'Tomas brought the lamp.'
    )
  )
  saveDocument(db, two, doc('Mara had red hair now.', 'Tomas said Mara was tall.'))
  mara = record('Mara')
  tomas = record('Tomas')
  scanNamesFor(db, one, NOW)
  scanNamesFor(db, two, NOW)
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the card as the re-pointed readers take it (F-16.20)', () => {
  it('gives the line, the gist and only the fields that stand, the POV by name', () => {
    expect(promptCard(db, one)).toBeNull()
    cardOne()
    expect(promptCard(db, one)).toEqual({
      line: 'Mara waits at the Quay for Tomas.',
      gist: 'Mara waits at the Quay in the cold; Tomas comes late with the lamp.',
      where: 'the Quay',
      when: null,
      pov: 'Mara',
      mood: 'tense',
      theme: 'waiting'
    })
    expect([...cardLines(db)]).toEqual([[one, 'Mara waits at the Quay for Tomas.']])
    expect(cardMoodOf(db, one)).toEqual({ mood: 'tense', theme: 'waiting' })
    // An edit to the place's sentence leaves the place out until the next reading.
    saveDocument(
      db,
      one,
      doc(
        'The ridge was cold.',
        "Mara's eyes were grey. She waited by the Quay a while.",
        'Tomas brought the lamp.'
      )
    )
    const held = promptCards(db, [one, two]).get(one)
    expect(held?.where).toBeNull()
    // The POV's own sentence is unchanged: it still stands.
    expect(held?.pov).toBe('Mara')
    expect(promptCards(db, [one, two]).has(two)).toBe(false)
  })

  it('gives a place only as the text words it: a paraphrase is left out', () => {
    cardOne({
      where: { value: 'the harbour front', quote: 'She waited by the Quay', p: 1, verified: false }
    })
    expect(promptCard(db, one)?.where).toBeNull()
    cardOne({
      where: { value: 'the harbour front', quote: 'She waited by the Quay', p: 1, verified: true }
    })
    expect(promptCard(db, one)?.where).toBe('the harbour front')
  })

  it('gives no reader the card of an Idea scene or one left out of compile', () => {
    cardOne()
    setSceneMeta(db, one, { ...getSceneMeta(db, one).meta, status: 'idea' })
    expect(promptCard(db, one)).toBeNull()
    expect(promptCards(db, [one]).size).toBe(0)
    expect([...cardLines(db)]).toEqual([])
    expect(cardMoodOf(db, one)).toBeNull()
    expect(storyMapItems(db, listNodes(db), 'v2').find((item) => item.id === one)?.summary).toBe(
      null
    )
    expect(hereTest(db)(one, mara)).toBe(false)
    setSceneMeta(db, one, { ...getSceneMeta(db, one).meta, status: 'none' })
    expect(promptCard(db, one)?.line).toBe('Mara waits at the Quay for Tomas.')
  })

  it('tells who is Here: the POV and who is on the page, never a record merely named', () => {
    cardOne()
    const isHere = hereTest(db)
    expect(isHere(one, mara)).toBe(true)
    expect(isHere(one, tomas)).toBe(true)
    // Scene two names both, with no card and no typed details: nobody is Here.
    expect(isHere(two, mara)).toBe(false)
    expect(isHere(two, tomas)).toBe(false)
  })

  it('reads the mood from the v2 card in v2 and from the summary in v1', () => {
    expect(buildSceneMood(db, one, 'v2')).toBeNull()
    cardOne()
    expect(buildSceneMood(db, one, 'v2')).toBe(
      'Scene mood: tense\nScene theme: waiting\nKeep the edit in line with them.'
    )
    expect(buildSceneMood(db, one, 'v1')).toBeNull()
  })
})

describe('the Story notes block reads the reading (F-16.20)', () => {
  beforeEach(() => {
    seedClaims(
      db,
      one,
      [
        { recordId: mara, slot: 'eyes', value: 'grey', quote: "Mara's eyes were grey", para: 1 },
        {
          recordId: mara,
          slot: 'location',
          value: 'the Quay',
          quote: 'She waited by the Quay',
          para: 1,
          proof: 'verified'
        }
      ],
      NOW
    )
    seedClaims(
      db,
      two,
      [
        { recordId: mara, slot: 'hair', value: 'red', quote: 'Mara had red hair now', para: 0 },
        {
          recordId: mara,
          slot: 'detail:height',
          value: 'tall',
          quote: 'Tomas said Mara was tall',
          para: 1,
          voice: 'dialogue',
          speakerId: tomas
        }
      ],
      NOW
    )
  })

  it('puts Here from the card (the POV and who is on the page) with the book’s values and the mood', () => {
    cardOne()
    const facts = storyNotesFacts(db, one)
    expect(facts?.pov?.id).toBe(mara)
    expect(facts?.alsoHere.map((each) => each.id)).toEqual([tomas])
    expect(facts?.values).toEqual({ [mara]: ['Eyes: grey', 'Last seen at: the Quay'] })
    expect(facts?.mood).toEqual({ mood: 'tense', theme: 'waiting' })
    const block = buildStoryNotes(db, { nodeId: one, maxTokens: STORY_BIBLE_TOKEN_BUDGET }) ?? ''
    expect(block).toContain(`Mara ${STORY_NOTES_VALUES_MARK}: Eyes: grey; Last seen at: the Quay.`)
    expect(block).toContain('Mood (as read from the prose): tense; theme: waiting')
    const noMood =
      buildStoryNotes(db, { nodeId: one, maxTokens: STORY_BIBLE_TOKEN_BUDGET, mood: false }) ?? ''
    expect(noMood).not.toContain('Mood')
    const continuity = buildStoryNotes(db, {
      nodeId: one,
      maxTokens: STORY_BIBLE_TOKEN_BUDGET,
      continuity: true
    })
    expect(continuity ?? '').not.toContain(STORY_NOTES_VALUES_MARK)
  })

  it('leaves out a fixed slot the book gives two different values for', () => {
    saveDocument(
      db,
      two,
      doc('Mara had red hair now.', 'Tomas said Mara was tall.', 'Her eyes were brown.')
    )
    seedClaims(
      db,
      two,
      [{ recordId: mara, slot: 'eyes', value: 'brown', quote: 'Her eyes were brown', para: 2 }],
      NOW
    )
    setSceneDetails(
      db,
      two,
      {
        povRecordId: mara,
        place: { recordId: null, text: '' },
        time: { text: '' },
        storyYear: null,
        alsoHere: [],
        flashback: null
      },
      NOW
    )
    // Grey in one, brown in two: neither is sent as the book's fact.
    expect(storyNotesFacts(db, two)?.values).toEqual({ [mara]: ['Hair: red'] })
  })

  it('as of a later scene: lasting values, never this scene’s speech as fact, no earlier transient line', () => {
    setSceneDetails(
      db,
      two,
      {
        povRecordId: mara,
        place: { recordId: null, text: '' },
        time: { text: '' },
        storyYear: null,
        alsoHere: [],
        flashback: null
      },
      NOW
    )
    const facts = storyNotesFacts(db, two)
    expect(facts?.values).toEqual({ [mara]: ['Eyes: grey', 'Hair: red'] })
    expect(facts?.mood).toBeNull()
  })

  it('gives the text’s place over a typed one that differs in the scene line (decision 4)', () => {
    setSceneDetails(
      db,
      one,
      {
        povRecordId: mara,
        place: { recordId: null, text: 'the harbour' },
        time: { text: 'dusk' },
        storyYear: 1814,
        alsoHere: [],
        flashback: null
      },
      NOW
    )
    expect(typedSceneMeta(db, one, { brief: emptySceneMeta().brief })).toMatchObject({
      location: 'the harbour',
      pov: 'Mara',
      timeline: 'dusk, year 1814'
    })
    cardOne()
    expect(typedSceneMeta(db, one, { brief: emptySceneMeta().brief })).toMatchObject({
      location: 'the Quay',
      pov: 'Mara',
      timeline: 'dusk, year 1814'
    })
  })
})
