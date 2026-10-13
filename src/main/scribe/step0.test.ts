import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { TiptapNodeT } from '@shared/tiptap'
import { listRecords, savePage } from '../memory/recordStore'
import { seedClaims } from '../memory/reading/claimFixture'
import { TEST_BOOK } from '../memory/testBook/book'
import { buildTestBookProject, type TestBookProject } from '../memory/testBook/project'
import { evidenceFrame } from './evidence'
import {
  closeScribeBook,
  doc as scribeDoc,
  indexBook,
  SCRIBE_NOW,
  scribeBook,
  type ScribeBook
} from './scribeFixture'
import { caretParaOf, gatherStep0, ordinalScope, type Step0 } from './step0'

/**
 * Step 0 over the test book (F-16.24; plan P3 §1.6): E0 is the open scene whole; the records the
 * question names come with digests from the stored claims; the hits are labelled by meaning
 * (happened, later, an Idea, Not canon, an Idea scene), never from an inactive draft; a first /
 * last / ever question reads every earlier scene's hits in reading order.
 */

const NOW = new Date(Date.UTC(2026, 9, 13, 12, 0, 0))
let tmp: string
let book: TestBookProject
let varrow: string

const node = (id: string): string => book.scenes.get(id) ?? ''

/** The index of the test book scene's paragraph holding `quote`. */
function paraOf(sceneId: string, quote: string): number {
  const scene = TEST_BOOK.find((each) => each.id === sceneId)
  const at = scene?.paragraphs.findIndex((text) => text.includes(quote)) ?? -1
  if (at < 0) throw new Error(`${quote} is not in ${sceneId}`)
  return at
}

const page = (...paragraphs: { text: string; notCanon?: boolean }[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map(({ text, notCanon }) => ({
    type: 'paragraph',
    ...(notCanon === true ? { attrs: { notCanon: true } } : {}),
    content: [{ type: 'text', text }]
  }))
})

const ask = (question: string, open: string, caretPara: number | null = null): Step0 =>
  gatherStep0(book.db, { nodeId: node(open), question, focus: { caretPara, selection: null } })

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-step0-'))
  book = buildTestBookProject(tmp, NOW)
  varrow = book.records.get('varrow') ?? ''
  seedClaims(
    book.db,
    node('s03'),
    [
      {
        recordId: varrow,
        slot: 'eyes',
        value: 'grey',
        quote: "Mr. Varrow's eyes were a cold, clear grey",
        para: paraOf('s03', 'cold, clear grey')
      }
    ],
    NOW
  )
  savePage(book.db, varrow, 'ideas', page({ text: 'Maybe Varrow has a sister in town.' }), NOW)
  savePage(
    book.db,
    varrow,
    'pinned',
    page({ text: 'Tall.' }, { text: 'Varrow keeps a hawk in the sequel.', notCanon: true }),
    NOW
  )
  indexBook(book.db, {
    scenes: [...new Set(book.scenes.values())],
    records: listRecords(book.db).map((each) => each.id)
  })
})
afterAll(() => {
  book.session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('Step 0 (F-16.24)', () => {
  it('sends the open scene whole as E0, with the caret and the selection’s opening', () => {
    const step = gatherStep0(book.db, {
      nodeId: node('h09'),
      question: 'Varrow’s eyes?',
      focus: { caretPara: 2, selection: `  brown   eyes ${'x'.repeat(300)}` }
    })
    const h09 = TEST_BOOK.find((scene) => scene.id === 'h09')
    expect(step).toMatchObject({ nowId: node('h09'), nowRef: '14.1', basis: 'open' })
    expect(step.e0).toMatchObject({
      nodeId: node('h09'),
      ref: '14.1',
      title: 'Three winters later',
      caretPara: 2
    })
    expect(step.e0?.paragraphs).toEqual(h09?.paragraphs)
    expect(step.e0?.selection?.startsWith('brown eyes x')).toBe(true)
    expect(step.e0?.selection).toHaveLength(200)
    // Nothing open: now is the latest written scene, and there is no E0.
    expect(
      gatherStep0(book.db, {
        nodeId: null,
        question: 'x',
        focus: { caretPara: null, selection: null }
      })
    ).toMatchObject({ basis: 'latest', e0: null })
  })

  it('digests the records the question names from the stored claims, and reads its shape', () => {
    const step = ask('Varrow’s eyes?', 'h09')
    expect(step.shape).toEqual({ kind: 'slot', recordId: varrow, slot: 'eyes' })
    expect(step.records).toHaveLength(1)
    expect(step.records[0]).toMatchObject({ recordId: varrow, name: 'Callum Varrow' })
    expect(step.records[0]?.digest).toBe('Callum Varrow (character): Eyes: grey (3.1)')
    expect(step.menu[0]).toMatchObject({
      id: 'E1',
      key: { kind: 'claim' },
      label: 'happened',
      ref: 'Callum Varrow',
      snippet: 'Callum Varrow · Eyes: grey (3.1)'
    })
    expect(step.records[0]?.lines.map((line) => line.key)).toEqual(step.records[0]?.keys)
  })

  it('labels each hit by its meaning, and never reads the inactive draft', () => {
    const step = ask('Varrow eyes', 'h09')
    const labels = step.menu.map((item) => `${item.label} ${item.ref}`)
    expect(labels).toEqual(
      expect.arrayContaining([
        'happened 14.1 ¶2',
        "idea Callum Varrow's Ideas ¶0",
        "notCanon Callum Varrow's Pinned ¶1"
      ])
    )
    expect(labels.some((label) => label.startsWith('ideaScene What if she ran'))).toBe(true)
    // h10, the earlier draft of 14.1 ("Varrow’s blue eyes did not look at her once"), is never a hit.
    expect(step.menu.some((item) => item.snippet.includes('did not look at her'))).toBe(false)
    expect(step.menu.map((item) => item.id)).toEqual(step.menu.map((_, i) => `E${i + 1}`))
    expect(step.hits).toContainEqual({ nodeId: node('h09'), para: 2 })
    // Asked from 3.1, 14.1 is later in the book.
    expect(ask('Varrow eyes', 's03').menu.map((item) => `${item.label} ${item.ref}`)).toContain(
      'later 14.1 ¶2'
    )
  })

  it('reads every earlier scene’s best paragraph in reading order for a first / ever question', () => {
    // "appear" only asks where Varrow is in the book: the search ranks by his names.
    const step = ask('When does Varrow first appear?', 'h09')
    expect(step.cues.scopeAll).toBe(true)
    expect(step.scope).toEqual({
      from: '1.1',
      to: '14.1',
      allEarlier: true,
      wholeBook: false,
      terms: ['callum', 'varrow']
    })
    const scenes = step.menu.filter(
      (item) => item.key.kind === 'passage' && item.key.source === 'scene'
    )
    const order = scenes.map((item) => item.ref.split(' ')[0] ?? '')
    const sorted = [...order].sort((a, b) => {
      const [ca, sa] = a.split('.').map(Number)
      const [cb, sb] = b.split('.').map(Number)
      return (ca ?? 0) - (cb ?? 0) || (sa ?? 0) - (sb ?? 0)
    })
    expect(order.length).toBeGreaterThan(1)
    expect(order).toEqual(sorted)
    // One paragraph per scene, nothing after now, and the book's own scenes only.
    expect(new Set(order).size).toBe(order.length)
    expect(order.every((ref) => Number(ref.split('.')[0]) <= 14)).toBe(true)
    expect(scenes.every((item) => item.label === 'happened')).toBe(true)
    // The other sources' best stand beside them, labelled: Varrow's Ideas and Not canon line.
    expect(step.menu.map((item) => item.label)).toEqual(
      expect.arrayContaining(['idea', 'notCanon'])
    )
    // "In the book": the whole book.
    expect(ask('Does Varrow ever smile in the book?', 'h09').scope).toMatchObject({
      wholeBook: true,
      allEarlier: false,
      terms: ['smile']
    })
  })

  it('searches the content words, not the names or the cue words, so early mentions never crowd out the answer', () => {
    const step = ask('When does Liesel first accept a dance with Varrow?', 'h09')
    expect(step.terms).toEqual(['accept', 'dance'])
    expect(step.scope).toMatchObject({ allEarlier: true, terms: ['accept', 'dance'] })
    // 5.1, where she accepts him and they dance, is reached (once early, every name mention filled
    // the twenty places and it never was); the navigator reads the scene from there.
    const refs = step.menu.map((item) => item.ref)
    expect(refs.some((ref) => ref.startsWith('5.1 ¶'))).toBe(true)
    expect(step.hits.some((hit) => hit.nodeId === node('s05'))).toBe(true)
    // The earliest paragraph holding both words comes first among the scenes.
    expect(refs).toContain(`3.1 ¶${paraOf('s03', 'obliged to accept')}`)
    // Nothing to search for: no scope, never "searched every scene".
    expect(ask('Did she ever?', 'h09')).toMatchObject({ scope: null, terms: [] })
  })

  it('keeps the Ideas page for an idea question and a general "what do we know" question', () => {
    const first = ask('What was my first idea about Varrow and a sister?', 'h09')
    const passages = first.menu.filter((item) => item.key.kind === 'passage')
    expect(passages[0]?.label).toBe('idea')
    const known = ask('What do we know about Varrow’s sister?', 'h09')
    expect(known.scope).toBeNull()
    expect(known.menu.map((item) => item.label)).toContain('idea')
  })

  it('labels E0 by what the open scene is: an Idea scene is never real', () => {
    expect(ask('Varrow’s eyes?', 'h09').e0?.label).toBe('happened')
    expect(ask('Varrow’s eyes?', 'h11').e0).toMatchObject({
      nodeId: node('h11'),
      label: 'ideaScene'
    })
  })
})

describe('the ordinal search’s scope (P3-D8)', () => {
  it('claims only the stretch whose every match is in the menu when the cap cut some', () => {
    const frame = evidenceFrame(book.db, node('s05'))
    const asked = { wholeBook: false, latest: false }
    expect(ordinalScope(frame, ['dance'], { ...asked, cut: null })).toEqual({
      from: '1.1',
      to: '5.1',
      allEarlier: true,
      wholeBook: false,
      terms: ['dance']
    })
    // Scenes 3.1 and 4.1 matched but were cut: only 1.1 to 2.1 is claimed, and not every scene.
    expect(ordinalScope(frame, ['dance'], { ...asked, cut: { first: 2, last: 3 } })).toEqual({
      from: '1.1',
      to: '2.1',
      allEarlier: false,
      wholeBook: false,
      terms: ['dance']
    })
    // A "last" question keeps the latest: the claim starts after the last cut scene.
    expect(
      ordinalScope(frame, ['dance'], { ...asked, latest: true, cut: { first: 0, last: 1 } })
    ).toMatchObject({ from: '3.1', to: '5.1', allEarlier: false })
    expect(ordinalScope(frame, ['dance'], { ...asked, cut: { first: 0, last: 3 } })).toBeNull()
    expect(ordinalScope(frame, [], { ...asked, cut: null })).toBeNull()
  })
})

describe('a record’s digest (P2b-D7, decision 5)', () => {
  let small: ScribeBook
  beforeEach(() => {
    small = scribeBook()
  })
  afterEach(() => closeScribeBook(small))

  it('words a half-knowing line as such, never as knowing', () => {
    seedClaims(
      small.db,
      small.two,
      [
        {
          recordId: small.mara,
          slot: 'knows',
          value: 'suspects',
          how: 'suspects',
          objectId: small.map,
          quote: 'Mara suspected the map was gone',
          para: 1,
          proof: 'verified'
        }
      ],
      SCRIBE_NOW
    )
    const step = gatherStep0(small.db, {
      nodeId: small.two,
      question: 'What does Mara think about the map?',
      focus: { caretPara: null, selection: null }
    })
    const lines = step.records[0]?.lines.map((line) => line.text) ?? []
    expect(lines).toContain('Suspects the sold map (1.2)')
    expect(lines.some((line) => line.startsWith('Knows'))).toBe(false)
    expect(step.menu.some((item) => item.snippet.includes('Knows'))).toBe(false)
  })

  it('gives a stated age with the age as of now, never a bare "since"', () => {
    savePage(small.db, small.mara, 'pinned', scribeDoc('Born: 1790'), SCRIBE_NOW)
    seedClaims(
      small.db,
      small.one,
      [
        { recordId: small.mara, slot: 'age', value: 'ten', quote: 'Mara watched the quay', para: 0 }
      ],
      SCRIBE_NOW
    )
    const step = gatherStep0(small.db, {
      nodeId: small.three,
      question: 'Tell me about Mara',
      focus: { caretPara: null, selection: null }
    })
    const lines = step.records[0]?.lines.map((line) => line.text) ?? []
    expect(lines.filter((line) => line.startsWith('Age:'))).toHaveLength(1)
    expect(lines.some((line) => line.includes('since 1.1'))).toBe(false)
  })
})

describe('caretParaOf (F-16.25: E0 notes where the caret is)', () => {
  const paragraphs = ['Mara watched the quay.', 'Tomas sold the map.', 'Orrin overheard Tomas.']

  it('finds the paragraph the caret window ends in', () => {
    expect(caretParaOf(paragraphs, 'Mara watched the quay.\n\nTomas sold')).toBe(1)
    expect(caretParaOf(paragraphs, 'Mara watched the quay.')).toBe(0)
    // A window cut inside one long paragraph holds its middle.
    expect(caretParaOf(paragraphs, 'overheard')).toBe(2)
  })

  it('places a caret at the start of an empty block after the paragraph before it', () => {
    expect(caretParaOf(paragraphs, 'Tomas sold the map.\n\n')).toBe(2)
  })

  it('answers null with no window or no match', () => {
    expect(caretParaOf(paragraphs, '')).toBeNull()
    expect(caretParaOf(paragraphs, 'Nothing like it.\n\nNor this')).toBeNull()
    expect(caretParaOf([], 'Mara')).toBeNull()
  })
})
