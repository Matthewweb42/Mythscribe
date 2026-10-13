import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyCardFields } from '@shared/memory/claims'
import { AI_FILED_ATTR, NOT_CANON_ATTR } from '@shared/memory/pageMarks'
import type { EvidenceKey } from '@shared/scribe'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { saveNotes } from '../document/notesStore'
import { activeDraftId } from '../draft/draftStore'
import { createAuthorTodo } from '../memory/authorTodoStore'
import { cardAnchorOf, seedClaims } from '../memory/reading/claimFixture'
import { upsertCard } from '../memory/reading/cardStore'
import { savePage } from '../memory/recordStore'
import { setSceneDetails } from '../memory/sceneDetailStore'
import { ensureResearchRoot } from '../project/seed'
import { createResearchNote, setResearchNotCanon } from '../research/researchStore'
import { deleteNode } from '../tree/treeStore'
import { renderEvidence, resolveEvidence } from './evidence'
import { closeScribeBook, doc, SCRIBE_NOW, scribeBook, type ScribeBook } from './scribeFixture'

/**
 * Ms Scribe's evidence (F-16.25; plan P3 §1.6): every key kind resolves against the book as it is
 * now, each labelled by meaning; a card is a map, never citable; a key whose owner is gone is
 * dropped and counted; the budget drops the far items first.
 */

let book: ScribeBook

beforeEach(() => {
  book = scribeBook()
})
afterEach(() => closeScribeBook(book))

const pinned = (...blocks: TiptapNodeT[]): TiptapNodeT => ({ type: 'doc', content: blocks })
const para = (text: string, attrs: Record<string, unknown> = {}): TiptapNodeT => ({
  type: 'paragraph',
  attrs,
  content: [{ type: 'text', text }]
})

describe('resolveEvidence', () => {
  it('resolves every key kind with its label, place and current text', () => {
    const db = book.db
    const [claimId] = seedClaims(
      db,
      book.one,
      [{ recordId: book.mara, slot: 'eyes', value: 'grey', quote: 'her grey eyes', para: 0 }],
      SCRIBE_NOW
    )
    seedClaims(
      db,
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
    saveNotes(db, book.two, doc('Mara should find the map here.'))
    const research = createResearchNote(db, 'novel', {
      parentId: ensureResearchRoot(db),
      title: 'Harbour notes'
    })
    saveDocument(
      db,
      research.id,
      doc('Quays flood at spring tides.', { text: 'Maybe a storm.', notCanon: true })
    )
    savePage(
      db,
      book.mara,
      'pinned',
      pinned(
        para('Born: 1790'),
        para('Hates the sea.', {
          [AI_FILED_ATTR]: { doc: research.id, para: 0, quote: 'Quays flood' }
        }),
        para('Was a sailor once.', { [NOT_CANON_ATTR]: true })
      ),
      SCRIBE_NOW
    )
    savePage(db, book.mara, 'ideas', doc('Maybe Mara has a twin in the north.'), SCRIBE_NOW)
    setSceneDetails(
      db,
      book.one,
      {
        povRecordId: book.mara,
        place: { recordId: null, text: '' },
        time: { text: '' },
        storyYear: 1811,
        alsoHere: []
      },
      SCRIBE_NOW
    )
    const anchor = cardAnchorOf(db, book.three)
    upsertCard(
      db,
      {
        nodeId: book.three,
        draftId: activeDraftId(db),
        readingId: null,
        line: 'Mara learns of the sale.',
        gist: 'Lamplight; brown eyes.',
        fields: emptyCardFields(),
        present: [],
        mood: null,
        theme: null,
        anchor,
        seen: anchor
      },
      SCRIBE_NOW
    )
    createAuthorTodo(db, { text: 'Fix the tide times', nodeId: null, recordId: null }, SCRIBE_NOW)

    const keys: EvidenceKey[] = [
      { kind: 'scene', nodeId: book.one, from: 1, to: 2 },
      { kind: 'passage', source: 'scene', ownerId: book.three, para: 0 },
      { kind: 'passage', source: 'sceneNote', ownerId: book.two, para: 0 },
      { kind: 'passage', source: 'pinned', ownerId: book.mara, para: 0 },
      { kind: 'passage', source: 'pinned', ownerId: book.mara, para: 1 },
      { kind: 'passage', source: 'pinned', ownerId: book.mara, para: 2 },
      { kind: 'passage', source: 'idea', ownerId: book.mara, para: 0 },
      { kind: 'passage', source: 'note', ownerId: research.id, para: 0 },
      { kind: 'passage', source: 'note', ownerId: research.id, para: 1 },
      { kind: 'claim', claimId: claimId ?? '' },
      { kind: 'card', nodeId: book.three },
      { kind: 'knows', secretId: book.map },
      { kind: 'timeline', recordId: null },
      { kind: 'timeline', recordId: book.mara },
      { kind: 'ideas', recordId: book.mara },
      { kind: 'outline' },
      { kind: 'todos' }
    ]
    const { items, dropped } = resolveEvidence(db, keys, book.two)
    expect(dropped).toBe(0)
    expect(items.map((item) => [item.id, item.label, item.ref, item.citable])).toEqual([
      ['E1', 'happened', '1.1 ¶1–2', true],
      ['E2', 'later', '1.3 ¶0', true],
      ['E3', 'planned', '1.2 notes ¶0', true],
      ['E4', 'notes', "Mara's Pinned ¶0", true],
      ['E5', 'filed', "Mara's Pinned ¶1", true],
      ['E6', 'notCanon', "Mara's Pinned ¶2", true],
      ['E7', 'idea', "Mara's Ideas ¶0", true],
      ['E8', 'notes', 'Research “Harbour notes” ¶0', true],
      ['E9', 'notCanon', 'Research “Harbour notes” ¶1', true],
      ['E10', 'happened', '1.1 ¶0', true],
      ['E11', 'map', '1.3', false],
      ['E12', 'happened', '1.1', true],
      ['E13', 'computed', '1.2', true],
      ['E14', 'computed', '1.2', true],
      ['E15', 'idea', "Mara's Ideas", true],
      ['E16', 'computed', '', true],
      ['E17', 'todo', '', true]
    ])
    const text = (id: string): string => items.find((item) => item.id === id)?.text ?? ''
    expect(text('E1')).toBe(
      '¶1 Tomas sold the map to a stranger.\n¶2 Orrin overheard Tomas from the yard.'
    )
    expect(items[4]?.doc).toBe('Harbour notes')
    expect(text('E10')).toBe('Mara · eyes: grey\nMara watched the quay with her grey eyes.')
    expect(text('E12')).toBe(
      'Revealed in 1.1: “Tomas sold the map”\nOrrin: overheard from Tomas (1.1): “Orrin overheard Tomas”'
    )
    expect(text('E13')).toBe('1.1: 1811 (typed)')
    expect(text('E14')).toMatch(
      /^Mara's age as of 1\.2: about 21 \(born 1790; year 1811 from 1\.1\)$/
    )
    expect(text('E16')).toContain('1.2 Two')
    expect(text('E17')).toBe('- Fix the tide times')
    expect(items[16]?.open).toBeNull()
    expect(items[3]?.open).toEqual({ kind: 'record', id: book.mara, page: 'pinned', para: 0 })
    // Research made Not canon reads Not canon everywhere.
    setResearchNotCanon(db, research.id, true)
    expect(
      resolveEvidence(
        db,
        [{ kind: 'passage', source: 'note', ownerId: research.id, para: 0 }],
        book.two
      ).items[0]?.label
    ).toBe('notCanon')
  })

  it('reads a scene as it is now: an edit shows, a deleted scene is dropped and counted', () => {
    const keys: EvidenceKey[] = [
      { kind: 'scene', nodeId: book.three, from: 0, to: 9 },
      { kind: 'passage', source: 'scene', ownerId: book.two, para: 0 },
      { kind: 'claim', claimId: 'gone' },
      { kind: 'ideas', recordId: book.mara }
    ]
    saveDocument(book.db, book.three, doc('Mara laughed.'))
    deleteNode(book.db, book.two)
    const { items, dropped } = resolveEvidence(book.db, keys, book.one, { first: 4, prefix: 'W' })
    // The claim and the scene are gone; an empty Ideas page is nothing, not counted.
    expect(dropped).toBe(2)
    expect(items.map((item) => [item.id, item.text, item.label])).toEqual([
      ['W4', '¶0 Mara laughed.', 'later']
    ])
  })

  it('never lists a line of not knowing, and never reads checkedUpTo', () => {
    const { items } = resolveEvidence(book.db, [{ kind: 'knows', secretId: book.map }], book.three)
    const text = items.map((item) => item.text).join('\n')
    expect(text).toBe('Revealed in 1.1: “Tomas sold the map”')
    expect(text).not.toMatch(/doesn.t know|does not know|No scene shows|checked up to/i)
  })
})

describe('renderEvidence', () => {
  it('labels each item as the prompts show it, and drops the far items first', () => {
    const { items } = resolveEvidence(
      book.db,
      [
        { kind: 'scene', nodeId: book.one, from: 0, to: 0 },
        { kind: 'card', nodeId: book.one },
        { kind: 'scene', nodeId: book.three, from: 0, to: 1 }
      ],
      book.two
    )
    const all = renderEvidence(items, 10_000)
    expect(all.text).toBe(
      'E1 [happened, 1.1 ¶0] Scene 1\n¶0 Mara watched the quay with her grey eyes.\n\n' +
        'E2 [later in the book, 1.3 ¶0–1] Three\n¶0 Mara’s eyes were brown in the lamplight.\n¶1 Mara learned the map was sold.'
    )
    expect(all.dropped).toBe(0)
    const tight = renderEvidence(items, 20)
    expect(tight.kept).toEqual(['E1'])
    expect(tight.dropped).toBe(1)
  })

  it('leaves out an item too long for the budget and still sends the ones after it', () => {
    const item = (id: string, words: number): Parameters<typeof renderEvidence>[0][number] => ({
      id,
      key: { kind: 'outline' },
      label: 'happened',
      ref: '1.1',
      title: id,
      text: Array.from({ length: words }, () => 'word').join(' '),
      citable: true,
      open: null,
      doc: null
    })
    const sent = renderEvidence([item('E1', 1_400), item('E2', 40), item('E3', 40)], 1_200)
    expect(sent.kept).toEqual(['E2', 'E3'])
    expect(sent.dropped).toBe(1)
  })
})

describe('a claim’s fact line (design §2.2: only narration in now mode sets state)', () => {
  it('says who says it and in what mode, never a bare value for speech or a dream', () => {
    const ids = seedClaims(
      book.db,
      book.two,
      [
        {
          recordId: book.mara,
          slot: 'alive',
          value: 'dead',
          quote: 'Mara waited at the harbour',
          para: 0,
          mode: 'dream'
        },
        {
          recordId: book.mara,
          slot: 'eyes',
          value: 'green',
          quote: 'Mara suspected the map was gone',
          para: 1,
          voice: 'dialogue',
          speakerId: book.orrin
        },
        {
          recordId: book.mara,
          slot: 'hair',
          value: 'short',
          quote: 'her hair cut short',
          para: 0
        }
      ],
      SCRIBE_NOW
    )
    const { items } = resolveEvidence(
      book.db,
      ids.map((claimId): EvidenceKey => ({ kind: 'claim', claimId })),
      book.three
    )
    expect(items.map((item) => item.text.split('\n')[0])).toEqual([
      'In a dream: Mara · alive: dead',
      'Orrin says: Mara · eyes: green',
      'Mara · hair: short'
    ])
  })
})
