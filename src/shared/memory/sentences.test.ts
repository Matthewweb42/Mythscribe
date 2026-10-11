import { describe, expect, it } from 'vitest'
import { splitSentences } from './sentences'

const texts = (text: string): string[] => splitSentences(text).map((span) => span.text)

describe('splitSentences (F-16.3)', () => {
  it('splits plain sentences and keeps offsets into the input', () => {
    const text = 'The storm broke at dusk. Mara ran.  Was it over?'
    const spans = splitSentences(text)
    expect(spans.map((span) => span.text)).toEqual([
      'The storm broke at dusk.',
      'Mara ran.',
      'Was it over?'
    ])
    for (const span of spans) expect(text.slice(span.start, span.end)).toBe(span.text)
  })

  it('keeps abbreviations and initials inside the sentence', () => {
    expect(texts('Mr. Harrow and Mrs. Harrow sat with Dr. Pell. They waited.')).toEqual([
      'Mr. Harrow and Mrs. Harrow sat with Dr. Pell.',
      'They waited.'
    ])
    expect(
      texts('Capt. Brand, Col. Hale, Lt. Fane, Rev. Moss and Sgt. Pike rode on.')
    ).toHaveLength(1)
    expect(texts('The letter was signed J. R. Hale. Nobody knew him.')).toEqual([
      'The letter was signed J. R. Hale.',
      'Nobody knew him.'
    ])
    expect(texts('They walked down St. Giles in the rain.')).toHaveLength(1)
  })

  it('keeps a dialogue tag with its speech', () => {
    expect(texts('"Go," she said. "Now."')).toEqual(['"Go," she said.', '"Now."'])
    expect(texts('"Where is he?" asked Lise. Nobody answered.')).toEqual([
      '"Where is he?" asked Lise.',
      'Nobody answered.'
    ])
    expect(texts('"Go!" She ran.')).toEqual(['"Go!"', 'She ran.'])
  })

  it('takes closing quotes with the terminal punctuation and counts ?! once', () => {
    expect(texts('He said, "It is done." Then he left.')).toEqual([
      'He said, "It is done."',
      'Then he left.'
    ])
    expect(texts('You did what?! I never asked you to.')).toEqual([
      'You did what?!',
      'I never asked you to.'
    ])
  })

  it('reads curly quotes as straight ones without moving any offset', () => {
    const text = '“Go,” she said. “Now.”'
    const spans = splitSentences(text)
    expect(spans.map((span) => span.text)).toEqual(['"Go," she said.', '"Now."'])
    expect(spans[1]?.start).toBe(text.indexOf('“Now'))
    expect(spans[1]?.end).toBe(text.length)
  })

  it('ends a sentence at an ellipsis only before a capital', () => {
    expect(texts('She waited... Then she left.')).toEqual(['She waited...', 'Then she left.'])
    expect(texts('I do not know… maybe. Ask him.')).toEqual(['I do not know… maybe.', 'Ask him.'])
    expect(texts('It was… Tuesday, I think.')).toEqual(['It was…', 'Tuesday, I think.'])
  })

  it('keeps em dashes inside a sentence, and ends one at speech broken off', () => {
    expect(texts('She ran—fast—home. He followed.')).toEqual(['She ran—fast—home.', 'He followed.'])
    expect(texts('"But I—" She stopped.')).toEqual(['"But I—"', 'She stopped.'])
    expect(texts('He began—"Wait," she said.')).toHaveLength(1)
  })

  it('ends a sentence at a line break and keeps unterminated trailing text', () => {
    expect(texts('First line\nSecond line. Third')).toEqual(['First line', 'Second line.', 'Third'])
    expect(splitSentences('')).toEqual([])
    expect(splitSentences('   ')).toEqual([])
  })

  it('does not split inside a number or a lowercase run after a full stop', () => {
    expect(texts('It cost 3.5 shillings, e.g. more than bread. Fine.')).toEqual([
      'It cost 3.5 shillings, e.g. more than bread.',
      'Fine.'
    ])
  })
})
