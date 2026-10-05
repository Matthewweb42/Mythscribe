import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'
import type { BookUnit, Inline, Run } from './model'

const run = (text: string, marks: Partial<Run> = {}): Run => ({
  kind: 'text',
  text,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  code: false,
  ...marks
})
const p = (...runs: Inline[]): BookUnit['blocks'][number] => ({
  kind: 'paragraph',
  runs,
  align: null
})
const body = (...blocks: BookUnit['blocks']): BookUnit[] => [
  { kind: 'body', title: 'Book', blocks }
]

describe('renderMarkdown (F-12.1)', () => {
  it('prints titles, shifted headings, paragraphs, and scene breaks a blank line apart', () => {
    const md = renderMarkdown(
      [
        { kind: 'matter', title: 'Dedication', blocks: [p(run('For M.'))] },
        ...body(
          { kind: 'title', level: 'part', text: 'Part One' },
          { kind: 'title', level: 'chapter', text: 'Chapter One' },
          { kind: 'heading', level: 1, runs: [run('Morning')], align: 'center' },
          p(run('First.')),
          { kind: 'sceneBreak' },
          p(run('Second.'))
        )
      ],
      '* * *'
    )
    expect(md).toBe(
      ['For M.', '# Part One', '## Chapter One', '### Morning', 'First.', '* * *', 'Second.'].join(
        '\n\n'
      ) + '\n'
    )
  })

  it('wraps marks around whole stretches with whitespace outside the delimiters', () => {
    const md = renderMarkdown(
      body(
        p(
          run('A '),
          run('bold ', { bold: true }),
          run('both', { bold: true, italic: true }),
          run(' tail', { italic: true }),
          run(' gone '),
          run('struck', { strike: true }),
          run(' and '),
          run('under', { underline: true }),
          run(' '),
          run('x`y', { code: true })
        )
      ),
      '#'
    )
    expect(md).toBe('A **bold *both*** *tail* gone ~~struck~~ and under ``x`y``\n')
  })

  it('escapes Markdown in text and at line starts, and keeps hard breaks', () => {
    const md = renderMarkdown(
      body(
        p(run('# not a heading *or* [link] _x_ \\')),
        p(run('1. not a list'), { kind: 'hardBreak' }, run('> not a quote')),
        p(run('- dash'))
      ),
      '###'
    )
    expect(md).toBe(
      [
        '\\# not a heading \\*or\\* \\[link\\] \\_x\\_ \\\\',
        '1\\. not a list  \n\\> not a quote',
        '\\- dash'
      ].join('\n\n') + '\n'
    )
    expect(renderMarkdown(body({ kind: 'sceneBreak' }), '###')).toBe('\\###\n')
  })

  it('prefixes quoted blocks', () => {
    const md = renderMarkdown(body({ kind: 'quote', blocks: [p(run('One')), p(run('Two'))] }), '*')
    expect(md).toBe('> One\n>\n> Two\n')
  })
})
