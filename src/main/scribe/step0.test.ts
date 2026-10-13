import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TiptapNodeT } from '@shared/tiptap'
import { listRecords, savePage } from '../memory/recordStore'
import { seedClaims } from '../memory/reading/claimFixture'
import { TEST_BOOK } from '../memory/testBook/book'
import { buildTestBookProject, type TestBookProject } from '../memory/testBook/project'
import { indexBook } from './scribeFixture'
import { gatherStep0, type Step0 } from './step0'

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

  it('reads every earlier scene’s hits in reading order for a first / ever question', () => {
    const step = ask('When does Varrow first appear?', 'h09')
    expect(step.cues.scopeAll).toBe(true)
    expect(step.scope).toEqual({
      from: '1.1',
      to: '14.1',
      allEarlier: true,
      wholeBook: false,
      terms: ['varrow', 'first', 'appear']
    })
    const order = step.menu
      .filter((item) => item.key.kind === 'passage')
      .map((item) => item.ref.split(' ')[0] ?? '')
    const sorted = [...order].sort((a, b) => {
      const [ca, sa] = a.split('.').map(Number)
      const [cb, sb] = b.split('.').map(Number)
      return (ca ?? 0) - (cb ?? 0) || (sa ?? 0) - (sb ?? 0)
    })
    expect(order.length).toBeGreaterThan(1)
    expect(order).toEqual(sorted)
    // Nothing after now, and nothing from an Idea or cut scene: the book's own scenes only.
    expect(order.every((ref) => Number(ref.split('.')[0]) <= 14)).toBe(true)
    expect(step.menu.every((item) => item.label === 'happened')).toBe(true)
    // "In the book": the whole book.
    expect(ask('Does Varrow ever smile in the book?', 'h09').scope).toMatchObject({
      wholeBook: true,
      allEarlier: false
    })
  })
})
