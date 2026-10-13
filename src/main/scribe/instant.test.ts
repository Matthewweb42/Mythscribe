import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InstantCard } from '@shared/scribe'
import { saveDocument } from '../document/documentStore'
import { activeDraftId } from '../draft/draftStore'
import { seedClaims } from '../memory/reading/claimFixture'
import { setKnewBefore } from '../memory/reading/knewBeforeStore'
import { setSceneSettled } from '../memory/reading/sceneReadStore'
import { savePage } from '../memory/recordStore'
import { contested, instantCard } from './instant'
import {
  closeScribeBook,
  doc,
  readWhole,
  SCENE_ONE,
  SCRIBE_NOW,
  scribeBook,
  type ScribeBook
} from './scribeFixture'

/**
 * Instant cards (F-16.24; plan P3 §1.6): a live literal value is a card; a stale claim or
 * incompatible values hand over; a later scene's value does not contest; "does A know" is only
 * ever yes; "who knows" carries the holders and `checkedUpTo`; an unread finished sentence that
 * names the record with a slot cue is read first.
 */

let book: ScribeBook

beforeEach(() => {
  book = scribeBook()
  for (const id of [book.one, book.two, book.three]) readWhole(book.db, id)
})
afterEach(() => closeScribeBook(book))

const grey = (state: 'live' | 'stale' = 'live'): string[] =>
  seedClaims(
    book.db,
    book.one,
    [
      {
        recordId: book.mara,
        slot: 'eyes',
        value: 'grey',
        quote: 'her grey eyes',
        para: 0,
        state
      }
    ],
    SCRIBE_NOW
  )

const eyes = (nowId: string): ReturnType<typeof instantCard> =>
  instantCard(book.db, { kind: 'slot', recordId: book.mara, slot: 'eyes' }, nowId)

describe('a record’s slot (P3-D2, P3-D3)', () => {
  it('answers a live literal value with a card, its quote and where it is', () => {
    const [claimId] = grey()
    const outcome = eyes(book.two)
    expect(outcome).toEqual({
      card: {
        kind: 'slot',
        recordId: book.mara,
        name: 'Mara',
        slot: 'eyes',
        label: 'Eyes',
        value: 'grey',
        claimId,
        quote: 'her grey eyes',
        ref: '1.1',
        nodeId: book.one,
        para: 0,
        since: null,
        lastStated: false,
        asOfRef: '1.2',
        readFirst: null
      }
    })
    expect(InstantCard.safeParse('card' in outcome ? outcome.card : null).success).toBe(true)
  })

  it('hands a stale claim over with the slot’s evidence', () => {
    const [claimId] = grey('stale')
    expect(eyes(book.two)).toEqual({
      handover: 'stale',
      keys: [{ kind: 'claim', claimId }]
    })
  })

  it('takes a contained value as agreeing and two different values as contested', () => {
    grey()
    seedClaims(
      book.db,
      book.three,
      [
        { recordId: book.mara, slot: 'eyes', value: 'grey-blue', quote: 'eyes were brown', para: 0 }
      ],
      SCRIBE_NOW
    )
    expect(eyes(book.three)).toMatchObject({ card: { value: 'grey-blue', ref: '1.3' } })
  })

  it('hands incompatible values over as contested, but never for a later scene’s value', () => {
    grey()
    const [brown] = seedClaims(
      book.db,
      book.three,
      [{ recordId: book.mara, slot: 'eyes', value: 'brown', quote: 'eyes were brown', para: 0 }],
      SCRIBE_NOW
    )
    const outcome = eyes(book.three)
    expect(outcome).toMatchObject({ handover: 'contested' })
    expect('keys' in outcome ? outcome.keys : []).toContainEqual({ kind: 'claim', claimId: brown })
    // As of 1.2 the brown eyes of 1.3 have not happened: grey stands alone.
    expect(eyes(book.two)).toMatchObject({ card: { value: 'grey', asOfRef: '1.2' } })
  })

  it('words a lasting value "since" and a transient one "last stated in"', () => {
    seedClaims(
      book.db,
      book.one,
      [
        {
          recordId: book.mara,
          slot: 'location',
          value: 'the quay',
          quote: 'watched the quay',
          para: 0
        }
      ],
      SCRIBE_NOW
    )
    seedClaims(
      book.db,
      book.two,
      [{ recordId: book.mara, slot: 'hair', value: 'short', quote: 'her hair cut short', para: 0 }],
      SCRIBE_NOW
    )
    expect(
      instantCard(book.db, { kind: 'slot', recordId: book.mara, slot: 'location' }, book.three)
    ).toMatchObject({
      card: { value: 'the quay', since: '1.1', lastStated: true, label: 'Last seen at' }
    })
    expect(
      instantCard(book.db, { kind: 'slot', recordId: book.mara, slot: 'hair' }, book.three)
    ).toMatchObject({ card: { value: 'short', since: '1.2', lastStated: false } })
  })

  it('hands over when the book says nothing, with the Pinned lines that hold a cue', () => {
    savePage(book.db, book.mara, 'pinned', doc('Born: 1790', 'Eyes: hazel'), SCRIBE_NOW)
    expect(eyes(book.two)).toEqual({
      handover: 'none',
      keys: [{ kind: 'passage', source: 'pinned', ownerId: book.mara, para: 1 }]
    })
  })

  it('reads an unread finished sentence that names the record with the slot’s cue first', () => {
    grey()
    saveDocument(book.db, book.two, doc('Mara’s eyes were green now.', 'Mara sat down.'))
    expect(eyes(book.two)).toEqual({ readFirst: [book.two] })
    // Asked again after the read ran (or could not): the card, never a loop.
    expect(
      instantCard(book.db, { kind: 'slot', recordId: book.mara, slot: 'eyes' }, book.two, {
        checkUnread: false
      })
    ).toMatchObject({ card: { value: 'grey' } })
  })

  it('answers with the card when the unread sentence names the record with no cue', () => {
    grey()
    saveDocument(book.db, book.two, doc('Mara sat down by the fire.'))
    expect(eyes(book.two)).toMatchObject({ card: { value: 'grey' } })
    // An unread sentence with the cue but naming nobody is no reason to read either.
    saveDocument(book.db, book.two, doc('Her eyes were green now.'))
    expect(eyes(book.two)).toMatchObject({ card: { value: 'grey' } })
  })

  it('looks at an earlier scene the reader left unsettled, too', () => {
    grey()
    saveDocument(book.db, book.one, doc(...SCENE_ONE, 'Mara closed her eyes.'))
    // A settled scene is not looked at (the anchors job unsettles it after a save).
    expect(eyes(book.three)).toMatchObject({ card: { value: 'grey' } })
    setSceneSettled(book.db, book.one, activeDraftId(book.db), false)
    expect(eyes(book.three)).toEqual({ readFirst: [book.one] })
  })
})

describe('does A know X, who knows X (F-16.22 data, P3-D2)', () => {
  function lines(): void {
    seedClaims(
      book.db,
      book.one,
      [
        {
          recordId: book.orrin,
          slot: 'knows',
          value: 'overheard',
          how: 'overheard',
          fromId: book.tomas,
          objectId: book.map,
          quote: 'Orrin overheard Tomas',
          para: 2,
          proof: 'verified'
        }
      ],
      SCRIBE_NOW
    )
    seedClaims(
      book.db,
      book.two,
      [
        {
          recordId: book.mara,
          slot: 'knows',
          value: 'suspects',
          how: 'suspects',
          objectId: book.map,
          quote: 'Mara suspected the map was gone',
          para: 1,
          proof: 'verified'
        }
      ],
      SCRIBE_NOW
    )
    seedClaims(
      book.db,
      book.three,
      [
        {
          recordId: book.mara,
          slot: 'knows',
          value: 'told',
          how: 'told',
          objectId: book.map,
          quote: 'Mara learned the map was sold',
          para: 1,
          proof: 'verified'
        }
      ],
      SCRIBE_NOW
    )
  }

  it('answers yes with the line and its quote; a suspicion or a later learning is not yes', () => {
    lines()
    expect(
      instantCard(book.db, { kind: 'knows', knowerId: book.orrin, secretId: book.map }, book.two)
    ).toMatchObject({
      card: {
        kind: 'knows',
        knowerName: 'Orrin',
        secretLabel: 'the sold map',
        how: 'overheard',
        source: 'claim',
        fromName: 'Tomas',
        quote: 'Orrin overheard Tomas',
        ref: '1.1',
        asOfRef: '1.2'
      }
    })
    const no = { handover: 'no', keys: [{ kind: 'knows', secretId: book.map }] }
    // Mara suspects in 1.2 and learns in 1.3: as of 1.2, no card either way.
    expect(
      instantCard(book.db, { kind: 'knows', knowerId: book.mara, secretId: book.map }, book.two)
    ).toEqual(no)
    expect(
      instantCard(book.db, { kind: 'knows', knowerId: book.tomas, secretId: book.map }, book.two)
    ).toEqual(no)
    expect(
      instantCard(book.db, { kind: 'knows', knowerId: book.mara, secretId: book.map }, book.three)
    ).toMatchObject({ card: { how: 'told', ref: '1.3' } })
  })

  it('takes the author’s Knew before the book as yes, with no quote', () => {
    setKnewBefore(book.db, book.map, book.tomas, true, SCRIBE_NOW)
    expect(
      instantCard(book.db, { kind: 'knows', knowerId: book.tomas, secretId: book.map }, book.one)
    ).toMatchObject({ card: { source: 'author', how: 'knewBefore', quote: null, claimId: null } })
  })

  it('lists who knows it as of now, readers-since and checked-up-to, never who does not', () => {
    lines()
    const outcome = instantCard(book.db, { kind: 'whoKnows', secretId: book.map }, book.two)
    expect(outcome).toMatchObject({
      card: {
        kind: 'whoKnows',
        label: 'the sold map',
        readersSince: { nodeId: book.one, ref: '1.1' },
        checkedUpTo: { nodeId: book.two, ref: '1.2' },
        asOfRef: '1.2'
      }
    })
    const card = 'card' in outcome ? outcome.card : null
    expect(card?.kind === 'whoKnows' ? card.holders.map((cell) => cell.knowerId) : []).toEqual([
      book.orrin
    ])
    expect(JSON.stringify(outcome)).not.toMatch(/doesn.t know|does not know|No scene shows/)
  })

  it('reads an unread sentence that holds the secret’s words first', () => {
    lines()
    saveDocument(book.db, book.two, doc('Orrin talked of the map at supper.'))
    expect(
      instantCard(book.db, { kind: 'knows', knowerId: book.orrin, secretId: book.map }, book.two)
    ).toEqual({ readFirst: [book.two] })
    expect(instantCard(book.db, { kind: 'whoKnows', secretId: book.map }, book.two)).toEqual({
      readFirst: [book.two]
    })
  })

  it('hands over a question about a place as knower, or no secret', () => {
    expect(
      instantCard(book.db, { kind: 'knows', knowerId: book.quay, secretId: book.map }, book.two)
    ).toMatchObject({ handover: 'none' })
    expect(instantCard(book.db, { kind: 'whoKnows', secretId: book.mara }, book.two)).toMatchObject(
      { handover: 'none', keys: [] }
    )
  })
})

describe('contested (P3-D3)', () => {
  const value = (
    text: string,
    stale = false
  ): {
    claimId: string
    value: string
    ref: string
    nodeId: string
    para: number
    stale: boolean
  } => ({
    claimId: text,
    value: text,
    ref: '1.1',
    nodeId: 'n',
    para: 0,
    stale
  })
  const line = (main: string, ...also: string[]): Parameters<typeof contested>[0] => ({
    slot: 'eyes',
    label: 'Eyes',
    objectId: null,
    value: value(main),
    also: also.map((each) => value(each)),
    since: null
  })

  it('is stale for any stale claim, contested for a fixed value neither contains', () => {
    expect(contested(line('grey'), [{ state: 'live' }])).toBeNull()
    expect(contested(line('grey'), [{ state: 'stale' }])).toBe('stale')
    expect(contested(line('grey-blue', 'grey'), [])).toBeNull()
    expect(contested(line('grey', 'brown'), [])).toBe('contested')
    expect(contested({ ...line('short', 'long'), slot: 'hair' }, [])).toBeNull()
  })
})
