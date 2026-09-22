import { describe, expect, it } from 'vitest'
import { IMPORTED_ORIGIN, PARAGRAPH_ORIGIN_ATTR } from '@shared/provenance'
import {
  blankRunsToBreaks,
  blockFromRuns,
  HARD_BREAK_RUN,
  isBreakGlyph,
  paragraphNode,
  runsText,
  textRun,
  type ImportBlock
} from './blocks'

describe('paragraphNode', () => {
  it('marks every paragraph as imported', () => {
    expect(paragraphNode([textRun('Hello')])).toEqual({
      type: 'paragraph',
      attrs: { [PARAGRAPH_ORIGIN_ATTR]: IMPORTED_ORIGIN },
      content: [{ type: 'text', text: 'Hello' }]
    })
  })

  it('drops empty runs and merges adjacent runs with the same marks', () => {
    const node = paragraphNode([
      textRun('one '),
      textRun(''),
      textRun('two', { italic: true }),
      textRun(' three', { italic: true }),
      textRun(' four')
    ])
    expect(node.content).toEqual([
      { type: 'text', text: 'one ' },
      { type: 'text', text: 'two three', marks: [{ type: 'italic' }] },
      { type: 'text', text: ' four' }
    ])
  })

  it('keeps bold and italic together and keeps hard breaks inside the line', () => {
    const node = paragraphNode([
      textRun('loud', { bold: true, italic: true }),
      HARD_BREAK_RUN,
      textRun('after')
    ])
    expect(node.content).toEqual([
      { type: 'text', text: 'loud', marks: [{ type: 'bold' }, { type: 'italic' }] },
      { type: 'hardBreak' },
      { type: 'text', text: 'after' }
    ])
  })

  it('trims hard breaks at the edges, which carry no line of their own', () => {
    const node = paragraphNode([HARD_BREAK_RUN, textRun('only'), HARD_BREAK_RUN])
    expect(node.content).toEqual([{ type: 'text', text: 'only' }])
  })
})

describe('isBreakGlyph', () => {
  it.each(['***', '* * *', '---', '___', '~~~', '#', '⁂', '• • •', '  - - -  ', '*  *  *'])(
    'reads %j as a scene break',
    (line) => {
      expect(isBreakGlyph(line)).toBe(true)
    }
  )

  it.each(['', '**', '- -', 'The end.', '--- and then', '#1', 'A * B * C'])(
    'reads %j as prose',
    (line) => {
      expect(isBreakGlyph(line)).toBe(false)
    }
  )
})

describe('blockFromRuns', () => {
  it('tells blank lines, glyph lines, and prose apart', () => {
    expect(blockFromRuns([textRun('   ')])).toEqual({ type: 'blank' })
    expect(blockFromRuns([])).toEqual({ type: 'blank' })
    expect(blockFromRuns([textRun('* * *')])).toEqual({ type: 'break' })
    expect(blockFromRuns([textRun('Prose.')]).type).toBe('paragraph')
  })
})

describe('blankRunsToBreaks', () => {
  const para = (text: string): ImportBlock => ({
    type: 'paragraph',
    node: paragraphNode([textRun(text)])
  })
  const blank: ImportBlock = { type: 'blank' }

  it('drops a single blank line and turns a run of two or more into one break', () => {
    expect(blankRunsToBreaks([para('a'), blank, para('b'), blank, blank, para('c')])).toEqual([
      para('a'),
      para('b'),
      { type: 'break' },
      para('c')
    ])
  })

  it('collapses a long run to a single break', () => {
    expect(blankRunsToBreaks([para('a'), blank, blank, blank, blank, para('b')])).toEqual([
      para('a'),
      { type: 'break' },
      para('b')
    ])
  })
})

describe('runsText', () => {
  it('reads a hard break as a newline', () => {
    expect(runsText([textRun('a'), HARD_BREAK_RUN, textRun('b')])).toBe('a\nb')
  })
})
