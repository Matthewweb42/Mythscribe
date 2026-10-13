import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { questionCues } from '@shared/memory/askParse'
import type { Navigation, SearchScope } from '@shared/scribe'
import { parseCitedAnswer, type SentenceVerdict } from '@shared/scribeAnswer'
import {
  applyCite,
  citationLevels,
  citedSentences,
  citeTag,
  coversScope,
  enforceScope,
  scopeAsked,
  scopeHits,
  type CheckedItem
} from './checks'
import { evidenceFrame } from './evidence'
import { closeScribeBook, scribeBook, type ScribeBook } from './scribeFixture'
import type { Step0 } from './step0'

/**
 * Ms Scribe's checks after the code quote check (F-16.25; plan P3 §3.3): the scope rule, what the
 * quote check is sent, and how its verdicts land.
 */

const ALL: SearchScope = {
  from: '1.1',
  to: '1.3',
  allEarlier: true,
  wholeBook: false,
  terms: ['suspect']
}

const step0Of = (
  question: string,
  over: Partial<Pick<Step0, 'scope' | 'menu' | 'hits' | 'terms'>> = {}
): Pick<Step0, 'cues' | 'scope' | 'menu' | 'hits' | 'terms'> => ({
  cues: questionCues(question),
  scope: ALL,
  menu: [
    {
      id: 'E1',
      key: { kind: 'passage', source: 'scene', ownerId: 's1', para: 0 },
      label: 'happened',
      ref: '1.1 ¶0',
      snippet: 'one'
    },
    {
      id: 'E2',
      key: { kind: 'passage', source: 'idea', ownerId: 'r1', para: 0 },
      label: 'idea',
      ref: 'Mara’s Ideas ¶0',
      snippet: 'two'
    }
  ],
  hits: [{ nodeId: 's1', para: 0 }],
  terms: ['suspect', 'distrust'],
  ...over
})

describe('the scope rule (P3 §3.3 step 2, P3-D8)', () => {
  it('asks for every earlier scene on first/last/ever/never, knows and learns questions', () => {
    expect(scopeAsked(questionCues('When does Mara first suspect him?'))).toBe(true)
    expect(scopeAsked(questionCues('Does Orrin know about the map?'))).toBe(true)
    expect(scopeAsked(questionCues('When does Tomas find out?'))).toBe(true)
    expect(scopeAsked(questionCues('What colour is the quay?'))).toBe(false)
  })

  it('covers every scene up to now, or the whole book when the question asks for it', () => {
    expect(coversScope(ALL, false)).toBe(true)
    expect(coversScope(ALL, true)).toBe(false)
    expect(coversScope({ ...ALL, allEarlier: false, wholeBook: true }, true)).toBe(true)
    expect(coversScope({ ...ALL, allEarlier: false }, false)).toBe(false)
    expect(coversScope(null, false)).toBe(false)
  })

  it('without a navigation takes Step 0’s menu and search', () => {
    const step0 = step0Of('When does Mara first suspect him?')
    expect(enforceScope(null, step0)).toEqual({
      keys: step0.menu.map((item) => item.key),
      scope: ALL,
      terms: step0.terms,
      hits: step0.hits,
      widened: false
    })
  })

  it('widens a narrower navigation with Step 0’s every-earlier-scene search, scene hits only', () => {
    const navigation: Navigation = {
      turn: 'answer',
      evidence: [{ kind: 'passage', source: 'scene', ownerId: 's3', para: 2 }],
      scope: { ...ALL, from: '1.3', allEarlier: false, terms: ['suspicion'] },
      terms: ['suspicion'],
      hits: [{ nodeId: 's3', para: 2 }]
    }
    const widened = enforceScope(navigation, step0Of('When does Mara first suspect him?'))
    expect(widened.widened).toBe(true)
    expect(widened.scope).toBe(ALL)
    expect(widened.keys).toEqual([
      { kind: 'passage', source: 'scene', ownerId: 's3', para: 2 },
      { kind: 'passage', source: 'scene', ownerId: 's1', para: 0 }
    ])
    expect(widened.terms).toEqual(['suspicion', 'suspect', 'distrust'])
    expect(widened.hits).toEqual([
      { nodeId: 's3', para: 2 },
      { nodeId: 's1', para: 0 }
    ])
    // A question that needs no scope, a navigation that covered it, or no Step 0 search: as sent.
    expect(enforceScope(navigation, step0Of('What colour is the quay?')).widened).toBe(false)
    expect(
      enforceScope({ ...navigation, scope: ALL }, step0Of('When does Mara first suspect him?'))
        .widened
    ).toBe(false)
    expect(
      enforceScope(navigation, step0Of('When does Mara first suspect him?', { scope: null }))
    ).toMatchObject({ widened: false, scope: navigation.scope, keys: navigation.evidence })
  })
})

const item = (over: Partial<CheckedItem> = {}): CheckedItem => ({
  label: 'happened',
  ref: '1.2',
  doc: null,
  quotable: ['Mara waited at the harbour.', 'Mara suspected the map was gone. It was dark.'],
  context: ['Mara waited at the harbour.\nMara suspected the map was gone. It was dark.'],
  open: { kind: 'scene', id: 's2' },
  e0: false,
  ...over
})

describe('what the quote check is sent', () => {
  it('tags a quote as the answer was sent it', () => {
    expect(citeTag(item(), 1)).toBe('happened, 1.2 ¶1')
    expect(citeTag(item({ e0: true, ref: '1.3' }), 0)).toBe('happened, the open scene 1.3 ¶0')
    expect(
      citeTag(item({ label: 'filed', doc: 'Harbour notes', ref: 'Mara’s Pinned ¶2' }), null)
    ).toBe('filed from Harbour notes, Mara’s Pinned ¶2')
  })

  it('sends every sentence with a kept citation, each kept quote in its sentence ±1', () => {
    const parsed = parseCitedAnswer(
      'Mara suspected it. [E1 "Mara suspected the map was gone"] [E2 "not kept here"] ' +
        'She waited. Night fell. [E1 "Mara waited at the harbour"]'
    )
    const verdicts: SentenceVerdict[] = [
      { keep: [true, false], needsCitation: true, unsupported: false },
      { keep: [], needsCitation: false, unsupported: false },
      { keep: [true], needsCitation: false, unsupported: false }
    ]
    const sent = citedSentences(
      parsed,
      verdicts,
      (id) => (id === 'E1' ? item() : undefined),
      (_, quote) => (quote.includes('suspected') ? 1 : 0)
    )
    expect(sent).toEqual([
      {
        index: 0,
        sentence: {
          text: 'Mara suspected it.',
          quotes: [
            {
              evidence: 'E1',
              tag: 'happened, 1.2 ¶1',
              quote: 'Mara suspected the map was gone',
              context: 'Mara waited at the harbour. Mara suspected the map was gone. It was dark.'
            }
          ]
        }
      },
      {
        index: 2,
        sentence: {
          text: 'Night fell.',
          quotes: [
            {
              evidence: 'E1',
              tag: 'happened, 1.2 ¶0',
              quote: 'Mara waited at the harbour',
              context: 'Mara waited at the harbour. Mara suspected the map was gone.'
            }
          ]
        }
      }
    ])
  })
})

describe('how the verdicts land', () => {
  const parsed = parseCitedAnswer(
    'Mara first suspects it in 1.2. [E1 "Mara suspected the map was gone"] ' +
      'She waited. [E1 "Mara waited at the harbour"] ' +
      'It was dark. [E1 "It was dark"]'
  )
  const fresh = (): SentenceVerdict[] =>
    parsed.sentences.map((sentence) => ({
      keep: sentence.citations.map(() => true),
      needsCitation: true,
      unsupported: false
    }))
  const cited = citedSentences(
    parsed,
    fresh(),
    () => item(),
    () => null
  )

  it('marks a no unsupported, and the main claim only from its own verdict or the scope', () => {
    const verdicts = fresh()
    const outcome = applyCite(
      {
        verdicts: new Map([
          [1, 'yes'],
          [2, 'no'],
          [3, 'partly']
        ]),
        scope: 'ok'
      },
      cited,
      3,
      verdicts,
      { sent: true, latest: false, absence: false }
    )
    expect(outcome.main).toBeNull()
    expect(verdicts.map((each) => each.unsupported)).toEqual([false, true, false])
    expect([...outcome.verdicts]).toEqual([
      [0, 'yes'],
      [1, 'no'],
      [2, 'partly']
    ])
    // Quote and sentence checked only for a yes.
    expect([...citationLevels(parsed, verdicts, outcome.verdicts).values()]).toEqual([
      'cite',
      'quote',
      'quote'
    ])
  })

  it('finds the main claim unsupported on its no, or an earlier (later, not-found) scope', () => {
    const no = applyCite({ verdicts: new Map([[1, 'no']]), scope: 'none' }, cited, 3, fresh(), {
      sent: false,
      latest: false,
      absence: false
    })
    expect(no.main).toBe('quotesDoNotSay')
    const earlier = { verdicts: new Map([[1, 'yes' as const]]), scope: 'earlier' as const }
    const scope = { sent: true, latest: false, absence: false }
    expect(applyCite(earlier, cited, 3, fresh(), scope).main).toBe('earlier')
    expect(applyCite(earlier, cited, 3, fresh(), { ...scope, latest: true }).main).toBe('later')
    expect(applyCite(earlier, cited, 3, fresh(), { ...scope, absence: true }).main).toBe(
      'notFoundShown'
    )
    // A scope verdict on a check that sent no scope item counts for nothing.
    expect(applyCite(earlier, cited, 3, fresh(), { ...scope, sent: false }).main).toBeNull()
  })

  it('reads no verdict for a sentence not sent, nor for one the reply skipped', () => {
    const verdicts = fresh()
    const outcome = applyCite(
      {
        verdicts: new Map([
          [2, 'no'],
          [3, 'no']
        ]),
        scope: null
      },
      cited,
      2,
      verdicts,
      { sent: false, latest: false, absence: false }
    )
    expect([...outcome.verdicts]).toEqual([[1, 'no']])
    expect(verdicts.map((each) => each.unsupported)).toEqual([false, true, false])
    expect(outcome.main).toBeNull()
  })
})

describe('scopeHits (the scope item’s passages)', () => {
  let book: ScribeBook
  beforeEach(() => {
    book = scribeBook()
  })
  afterEach(() => closeScribeBook(book))

  it('lists the search’s hits before the cited place in reading order (after it for a last answer), at most five, as the scenes read now', () => {
    const frame = evidenceFrame(book.db, book.three)
    const hits = [
      { nodeId: book.three, para: 1 },
      { nodeId: book.two, para: 1 },
      { nodeId: book.one, para: 1 },
      { nodeId: book.two, para: 0 }
    ]
    const terms = ['map']
    expect(
      scopeHits(frame, hits, { nodeId: book.three, para: 1 }, { latest: false, terms })
    ).toEqual([
      { ref: '1.1 ¶1', text: 'Tomas sold the map to a stranger.' },
      { ref: '1.2 ¶0', text: 'Mara waited at the harbour with her hair cut short.' },
      { ref: '1.2 ¶1', text: 'Mara suspected the map was gone.' }
    ])
    // Within the cited scene, only paragraphs before the cited one; the cited one never.
    expect(
      scopeHits(frame, hits, { nodeId: book.two, para: 1 }, { latest: false, terms }).map(
        (hit) => hit.ref
      )
    ).toEqual(['1.1 ¶1', '1.2 ¶0'])
    expect(
      scopeHits(frame, hits, { nodeId: book.one, para: 1 }, { latest: true, terms }).map(
        (hit) => hit.ref
      )
    ).toEqual(['1.3 ¶1', '1.2 ¶1', '1.2 ¶0'])
    // Nothing cited (an answer that found nothing): every hit, from the start.
    expect(scopeHits(frame, hits, null, { latest: false, terms }).map((hit) => hit.ref)).toEqual([
      '1.1 ¶1',
      '1.2 ¶0',
      '1.2 ¶1',
      '1.3 ¶1'
    ])
    const many = Array.from({ length: 9 }, () => hits).flat()
    expect(scopeHits(frame, many, null, { latest: false, terms }).length).toBeLessThanOrEqual(5)
    // A cited place outside the manuscript lists nothing.
    expect(scopeHits(frame, hits, { nodeId: 'gone', para: 0 }, { latest: false, terms })).toEqual(
      []
    )
  })
})
