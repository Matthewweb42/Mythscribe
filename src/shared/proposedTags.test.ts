import { describe, expect, it } from 'vitest'
import {
  DismissedNames,
  PROPOSED_TAG_MAX,
  countCapitalisedWords,
  defaultDismissedNames,
  proposeTags,
  type DocumentWordCounts
} from './proposedTags'

/** One document of the manuscript, as `proposeTags` takes it. */
const document = (nodeId: string, text: string): DocumentWordCounts => ({
  nodeId,
  counts: countCapitalisedWords(text)
})

/** The three mid-sentence occurrences a name needs, in one sentence that never opens with it. */
const thrice = (name: string): string => `The ${name} saw ${name}, then ${name}.`

describe('countCapitalisedWords (F-4.12b)', () => {
  it('tells a mid-sentence name from a sentence opening and from the lower-case word', () => {
    const counts = countCapitalisedWords('Rose waited. The rose was for Rose.\nRose left.')
    // The run's start, the line break, and the full stop all open a sentence; "for Rose" does not.
    expect(counts.get('rose')).toEqual({ display: 'Rose', mid: 1, start: 2, lower: 1 })
    expect(counts.get('waited')).toEqual({ display: 'waited', mid: 0, start: 0, lower: 1 })
  })

  it('counts a possessive and a contraction as the name itself', () => {
    const counts = countCapitalisedWords("She took Tash's hand, and Tash'd gone.")
    expect(counts.get('tash')).toEqual({ display: 'Tash', mid: 2, start: 0, lower: 0 })
  })

  it('keeps an apostrophe inside a name and counts the whole word', () => {
    const counts = countCapitalisedWords('She met O’Rourke, then O’Rourke again.')
    expect(counts.get('o’rourke')).toMatchObject({ display: 'O’Rourke', mid: 2 })
  })

  it('reads through the quotes, brackets, and dashes a sentence may open with', () => {
    const counts = countCapitalisedWords('“Tash,” she said. (Tash waited.) She saw Tash.')
    expect(counts.get('tash')).toEqual({ display: 'Tash', mid: 1, start: 2, lower: 0 })
  })

  it('ignores full capitals and single letters, which say nothing either way', () => {
    const counts = countCapitalisedWords('The sign read TASH. I saw a light.')
    expect(counts.get('tash')).toBeUndefined()
    expect(counts.get('i')).toBeUndefined()
    expect(counts.get('a')).toBeUndefined()
  })

  it('shows the first capitalised spelling even when the lower-case word came first', () => {
    const counts = countCapitalisedWords('the marsh, then the Marsh, then the marsh')
    expect(counts.get('marsh')).toEqual({ display: 'Marsh', mid: 1, start: 0, lower: 2 })
  })
})

describe('proposeTags (F-4.12b)', () => {
  it('proposes a name used three times mid-sentence, with its count and its documents', () => {
    const proposals = proposeTags(
      [
        document('sc-1', 'The road was long. Tash rode ahead of Tash’s guard.'),
        document('sc-2', thrice('Tash'))
      ],
      [],
      []
    )
    expect(proposals).toEqual([
      { name: 'tash', display: 'Tash', count: 5, nodeIds: ['sc-1', 'sc-2'] }
    ])
  })

  it('counts a sentence opening but never proposes on openings alone', () => {
    const openings = 'Tash rode on. Tash waited. Tash slept.'
    expect(proposeTags([document('sc-1', openings)], [], [])).toEqual([])
    // One mid-sentence use short of the threshold is still not a name the author is using.
    expect(proposeTags([document('sc-1', `${openings} It was Tash.`)], [], [])).toEqual([])
  })

  it('drops a word the manuscript also writes in lower case', () => {
    const text = `${thrice('Rose')} She held a rose.`
    expect(proposeTags([document('sc-1', text)], [], [])).toEqual([])
  })

  it('proposes an ordinary word the text keeps capitalising mid-sentence (2026-10-08)', () => {
    const text =
      'She stood her trial with the rest. They spoke of the Trial at supper, and of the Trial ' +
      'again at dawn. Nobody survived the Trial twice, said Marta, and the Trial was coming.'
    expect(proposeTags([document('sc-1', text)], [], []).map((p) => p.name)).toEqual(['trial'])
    // Three capitalised uses beside a lower-case one are not enough for an ordinary word.
    const fewer = 'A fair trial. They feared the Trial, the Trial, and then the Trial.'
    expect(proposeTags([document('sc-1', fewer)], [], [])).toEqual([])
  })

  it('drops the honorifics, the days, and the months', () => {
    const text = [thrice('Captain'), thrice('Tuesday'), thrice('August')].join('\n')
    expect(proposeTags([document('sc-1', text)], [], [])).toEqual([])
  })

  it('drops a word any existing tag is already named by, whatever its category', () => {
    const text = [thrice('Tash'), thrice('Marsh')].join('\n')
    expect(proposeTags([document('sc-1', text)], ['rose-marsh'], []).map((p) => p.name)).toEqual([
      'tash'
    ])
  })

  it('drops a dismissed name, matched the way a tag name is normalised', () => {
    expect(proposeTags([document('sc-1', thrice('Tash'))], [], ['Tash'])).toEqual([])
    expect(proposeTags([document('sc-1', thrice('O’Rourke'))], [], ['o-rourke'])).toEqual([])
  })

  it('sorts by count, then by name, and shows no more than the cap', () => {
    // Letters only: a digit is no part of a word, so `Nam0os` and `Nam1os` would be one name.
    const names = Array.from(
      { length: PROPOSED_TAG_MAX + 3 },
      (_value, i) => `Nam${String.fromCharCode(97 + i)}os`
    )
    const text = [...names.map(thrice), thrice('Bren'), 'Bren rode with Bren.'].join('\n')
    const proposals = proposeTags([document('sc-1', text)], [], [])
    expect(proposals).toHaveLength(PROPOSED_TAG_MAX)
    expect(proposals[0]).toMatchObject({ name: 'bren', count: 5 })
    expect(proposals.slice(1).map((p) => p.name)).toEqual(
      names.slice(0, PROPOSED_TAG_MAX - 1).map((name) => name.toLowerCase())
    )
  })

  it('names only the documents the word occurs in', () => {
    const proposals = proposeTags(
      [document('sc-1', thrice('Tash')), document('sc-2', 'Somewhere else entirely.')],
      [],
      []
    )
    expect(proposals[0]?.nodeIds).toEqual(['sc-1'])
  })
})

describe('DismissedNames (F-4.12b)', () => {
  it('reads a row without names as the empty list, and refuses a row of the wrong shape', () => {
    expect(DismissedNames.parse({})).toEqual(defaultDismissedNames())
    expect(DismissedNames.safeParse({ names: 'tash' }).success).toBe(false)
  })
})
