import { describe, expect, it } from 'vitest'
import { renderText } from './text'
import { sampleBook } from './testBook'

describe('renderText (Compile v2)', () => {
  it('prints the Plain text format: headings, blank-line paragraphs, * * * between scenes', () => {
    const text = renderText(sampleBook('plain-text', 'txt'))
    expect(text).toBe(
      [
        'A word first.',
        '',
        'Prologue',
        '',
        '“Before it all,” she said & left.',
        '',
        'Beginnings',
        '',
        'The Storm',
        '',
        'Rain fell hard on the salt road that evening, and nobody came.',
        '',
        'Bold and italic -- then...',
        '',
        '* * *',
        '',
        'After the break.',
        '',
        '* * *',
        '',
        'Then it stopped.',
        '',
        'The Calm',
        '',
        'Morning',
        '',
        'Quiet now.',
        '',
        '    A quoted line.',
        '',
        '',
        'Thanks.',
        ''
      ].join('\n')
    )
  })

  it('prints the manuscript first page and inline notes', () => {
    const manuscript = renderText(sampleBook('standard-manuscript', 'txt'))
    expect(
      manuscript.startsWith(
        'Ada M. Marlowe\n12 Harbour Lane\nada@example.com\nabout 100 words\n\nThe Salt Road\nby Ada Marlowe'
      )
    ).toBe(true)
    expect(manuscript).toContain('Chapter One\nThe Storm')
  })
})
