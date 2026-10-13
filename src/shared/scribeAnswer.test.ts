import { describe, expect, it } from 'vitest'
import { estimateTokens } from './ai'
import { buildAskIndex } from './memory/askParse'
import { buildNameIndex } from './memory/nameScan'
import { normName } from './memory/names'
import {
  isAdviceOrQuestion,
  markerize,
  needsCitation,
  notFoundLine,
  parseCitedAnswer,
  quoteHeld,
  quoteWords,
  scribeHistory,
  stripCitationMarkup,
  type HistoryTurn
} from './scribeAnswer'

const INDEX = buildAskIndex(
  buildNameIndex(
    [
      { id: 'mara', kind: 'character' },
      { id: 'orrin', kind: 'character' }
    ],
    [
      { id: 'a1', recordId: 'mara', text: 'Mara', norm: 'mara', caseRule: 'auto', shared: false },
      { id: 'a2', recordId: 'orrin', text: 'Orrin', norm: 'orrin', caseRule: 'auto', shared: false }
    ]
  ),
  [
    { id: 'mara', kind: 'character', name: 'Mara', aliases: [{ text: 'Mara', norm: 'mara' }] },
    { id: 'orrin', kind: 'character', name: 'Orrin', aliases: [{ text: 'Orrin', norm: 'orrin' }] },
    {
      id: 'map',
      kind: 'secret',
      name: 'the sold map',
      aliases: [{ text: 'the sold map', norm: normName('the sold map') }]
    }
  ]
)

describe('parseCitedAnswer (F-16.25)', () => {
  it('reads each sentence’s citations, escaped quotes, two in one sentence, and drops malformed markers', () => {
    const raw =
      'Orrin overheard it [E3 "Orrin overheard Tomas"]. ' +
      'Mara said \\"no\\" twice. [E7 "she said \\"no\\""] [W2 "twice"] ' +
      'You could cut it [E4 broken]. And then [E9 "unclosed'
    const parsed = parseCitedAnswer(raw)
    expect(parsed.text).toBe(
      'Orrin overheard it. Mara said \\"no\\" twice. You could cut it. And then'
    )
    expect(parsed.malformed).toBe(2)
    expect(parsed.sentences.map((sentence) => [sentence.text, sentence.citations])).toEqual([
      ['Orrin overheard it.', [{ evidence: 'E3', quote: 'Orrin overheard Tomas' }]],
      [
        'Mara said \\"no\\" twice.',
        [
          { evidence: 'E7', quote: 'she said "no"' },
          { evidence: 'W2', quote: 'twice' }
        ]
      ],
      ['You could cut it.', []],
      ['And then', []]
    ])
    for (const sentence of parsed.sentences) {
      expect(parsed.text.slice(sentence.start, sentence.end)).toBe(sentence.text)
    }
  })

  it('takes "[E1: "…"]" and a marker before the full stop', () => {
    const parsed = parseCitedAnswer('It was grey [E1: "grey eyes"].')
    expect(parsed.text).toBe('It was grey.')
    expect(parsed.sentences[0]?.citations).toEqual([{ evidence: 'E1', quote: 'grey eyes' }])
  })
})

describe('stripCitationMarkup', () => {
  it('takes markers out and holds back one still being written', () => {
    expect(stripCitationMarkup('Orrin heard it. [E3 "Orrin overheard"] Then')).toBe(
      'Orrin heard it. Then'
    )
    expect(stripCitationMarkup('Orrin heard it [E3 "Orrin over')).toBe('Orrin heard it')
    expect(stripCitationMarkup('Orrin heard it [E3')).toBe('Orrin heard it')
    expect(stripCitationMarkup('Orrin heard it [')).toBe('Orrin heard it')
    expect(stripCitationMarkup('Orrin heard it [E3 "Orrin"')).toBe('Orrin heard it')
    expect(stripCitationMarkup('Orrin heard it [E3 "Orrin"].')).toBe('Orrin heard it.')
    expect(stripCitationMarkup('No markers here.')).toBe('No markers here.')
  })
})

describe('needsCitation (P3-D13)', () => {
  it('asks for one when a sentence names a record, a secret or a scene', () => {
    expect(needsCitation('Orrin overheard Tomas.', INDEX)).toBe(true)
    expect(needsCitation('The sold map changed hands.', INDEX)).toBe(true)
    expect(needsCitation('It happens in 14.2.', INDEX)).toBe(true)
    expect(needsCitation('Look at chapter 9.', INDEX)).toBe(true)
    expect(needsCitation('Scene 3 has it.', INDEX)).toBe(true)
    expect(needsCitation('The tide was high.', INDEX)).toBe(false)
  })

  it('never for advice or a question back to the author', () => {
    expect(needsCitation('You could give Mara a line here.', INDEX)).toBe(false)
    expect(needsCitation('Consider cutting Orrin’s speech.', INDEX)).toBe(false)
    expect(needsCitation('Do you want Mara to know?', INDEX)).toBe(false)
    expect(needsCitation('Should Orrin hear it in 3.1?', INDEX)).toBe(false)
  })
})

describe('quoteHeld (the code quote check)', () => {
  const quotable = ['Orrin overheard Tomas from the yard.', 'Tomas sold the map to a stranger.']

  it('keeps 3 to 25 copied words that lie within one stretch', () => {
    expect(quoteHeld(quotable, 'Orrin overheard Tomas')).toBe(true)
    expect(quoteHeld(quotable, 'sold the map to a stranger')).toBe(true)
  })

  it('refuses one or two words, more than 25, a quote across two stretches, and composed lines', () => {
    expect(quoteHeld(quotable, 'Orrin')).toBe(false)
    expect(quoteHeld(quotable, 'the yard')).toBe(false)
    expect(quoteHeld([`${'word '.repeat(30)}`], 'word '.repeat(26).trim())).toBe(false)
    expect(quoteHeld(quotable, 'from the yard. Tomas sold')).toBe(false)
    expect(quoteHeld(quotable, '¶1 Tomas sold the map')).toBe(false)
    expect(quoteWords('two-and-twenty that spring')).toBe(3)
  })
})

describe('isAdviceOrQuestion (P3-D13)', () => {
  it('reads advice and questions back to the author, never a claim', () => {
    expect(isAdviceOrQuestion('You could open on the storm.')).toBe(true)
    expect(isAdviceOrQuestion('Do you mean the yard?')).toBe(true)
    expect(isAdviceOrQuestion('Orrin overheard Tomas.')).toBe(false)
  })
})

describe('markerize', () => {
  it('numbers kept citations once each, marks unchecked and unsupported spans', () => {
    const parsed = parseCitedAnswer(
      'Orrin heard it. [E3 "Orrin overheard"] Mara saw it [E4 "Mara watched"] [E3 "Orrin overheard"]. ' +
        'Mara left. The tide turned. Orrin sold it. [E5 "sold"]'
    )
    const out = markerize(parsed, [
      { keep: [true], needsCitation: true, unsupported: false },
      { keep: [false, true], needsCitation: true, unsupported: false },
      { keep: [], needsCitation: true, unsupported: false },
      { keep: [], needsCitation: false, unsupported: false },
      { keep: [true], needsCitation: true, unsupported: true }
    ])
    expect(out.text).toBe(
      'Orrin heard it.[1] Mara saw it.[1] Mara left. The tide turned. Orrin sold it.'
    )
    expect(out.citations).toEqual([{ n: 1, evidence: 'E3', quote: 'Orrin overheard' }])
    const spans = (list: readonly (readonly [number, number])[]): string[] =>
      list.map(([start, end]) => out.text.slice(start, end))
    expect(spans(out.notChecked)).toEqual(['Mara left.'])
    expect(spans(out.unsupported)).toEqual(['Orrin sold it.'])
  })
})

describe('notFoundLine (P3-D14)', () => {
  it('names the open scene, the cited scenes and the search', () => {
    expect(
      notFoundLine(
        {
          from: '1.1',
          to: '14.2',
          allEarlier: true,
          wholeBook: false,
          terms: ['distrust', 'suspicion']
        },
        { open: '14.2', cited: ['7.4', '9.3', '7.4'] }
      )
    ).toBe(
      'Not found in the manuscript (I looked in the open scene 14.2, scenes 7.4 and 9.3, and searched every scene up to 14.2 for distrust, suspicion)'
    )
    expect(notFoundLine(null, { open: '1.1', cited: ['1.1'] })).toBe(
      'Not found in the manuscript (I looked in the open scene 1.1)'
    )
    expect(
      notFoundLine(
        { from: '1.1', to: '20.3', allEarlier: false, wholeBook: true, terms: ['map'] },
        { open: null, cited: ['3.2'] }
      )
    ).toBe(
      'Not found in the manuscript (I looked in scene 3.2, and searched the whole book for map)'
    )
    expect(
      notFoundLine(
        { from: '3.1', to: '3.4', allEarlier: false, wholeBook: false, terms: [] },
        { open: null, cited: [] }
      )
    ).toBe('Not found in the manuscript (I searched 3.1–3.4)')
    expect(notFoundLine(null, { open: null, cited: [] })).toBe('Not found in the manuscript.')
  })
})

describe('scribeHistory (P3-D12)', () => {
  it('keeps the newest two whole, cuts older ones to a line, strips citations, fits the budget', () => {
    const long = `${'word '.repeat(40)}\nsecond line`
    const turns: HistoryTurn[] = [
      { role: 'user', content: long },
      { role: 'assistant', content: 'Orrin heard it.[1] [E3 "Orrin overheard"]\nMore.' },
      { role: 'user', content: 'And Mara?' },
      { role: 'assistant', content: `Mara saw it. [E4 "Mara watched"] ${'x '.repeat(2000)}` }
    ]
    const out = scribeHistory(turns)
    expect(out[0]?.content).toBe(`${'word '.repeat(25).trim()}…`)
    expect(out[1]?.content).toBe('Orrin heard it.')
    expect(out[2]?.content).toBe('And Mara?')
    expect(out[3]?.content.startsWith('Mara saw it. x x')).toBe(true)
    expect(estimateTokens(out[3]?.content ?? '')).toBeLessThanOrEqual(401)
    const total = out.reduce((sum, turn) => sum + estimateTokens(turn.content), 0)
    expect(total).toBeLessThanOrEqual(1_500)
    // Over the budget the oldest go first.
    const newest = estimateTokens(out[3]?.content ?? '')
    expect(scribeHistory(turns, newest).map((turn) => turn.content.slice(0, 8))).toEqual([
      'Mara saw'
    ])
    expect(scribeHistory([])).toEqual([])
  })
})
