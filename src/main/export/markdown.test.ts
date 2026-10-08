import { describe, expect, it } from 'vitest'
import type { BookItem, CompiledBook, ContentBlock, Inline } from '@shared/compileModel'
import { plainRun as run } from './inlines'
import { renderMarkdown } from './markdown'
import { sampleBook } from './testBook'

const p = (...runs: Inline[]): ContentBlock => ({
  kind: 'paragraph',
  runs,
  align: null,
  opening: 'none'
})

/** The sample book with only these body blocks. */
function body(...blocks: ContentBlock[]): CompiledBook {
  const item: BookItem = { kind: 'text', division: 'body', id: 't', blocks }
  return { ...sampleBook('plain-text', 'md'), items: [item] }
}

describe('renderMarkdown (Compile v2)', () => {
  it('prints headings by level, shifted document headings, paragraphs, and scene breaks', () => {
    const md = renderMarkdown(sampleBook('plain-text', 'md'))
    expect(md).toBe(
      [
        'A word first.',
        '## Prologue',
        '“Before it all,” she said & left.',
        '# Beginnings',
        '## The Storm',
        'Rain fell hard on the salt road that evening, and nobody came.',
        '**Bold** and *italic* -- then...',
        '* * *',
        'After the break.',
        '* * *',
        'Then it stopped.',
        '## The Calm',
        '#### Morning',
        'Quiet now.',
        '> A quoted line.',
        'Thanks.'
      ].join('\n\n') + '\n'
    )
  })

  it('joins two-line headings, prints generated pages, and quotes notes', () => {
    const md = renderMarkdown(sampleBook('editor-copy', 'md'))
    expect(md).toContain(
      '# The Salt Road\n\n*A Novel*\n\nTides, Book 2\n\nby Ada Marlowe\n\nGull Press'
    )
    const chapters = renderMarkdown(sampleBook('ebook', 'md'))
    expect(chapters).toContain('## Chapter One: The Storm')
    expect(chapters).toContain(
      '## Contents\n\n- Prologue\n- Part One: Beginnings\n  - Chapter One: The Storm'
    )
    expect(md).toContain('> **Note**\n>\n> Check the tide tables.')
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
      )
    )
    expect(md).toBe('A **bold *both*** *tail* gone ~~struck~~ and under ``x`y``\n')
  })

  it('escapes Markdown in text and at line starts, and keeps hard breaks', () => {
    const md = renderMarkdown(
      body(
        p(run('# not a heading *or* [link] _x_ \\')),
        p(run('1. not a list'), { kind: 'hardBreak' }, run('> not a quote')),
        p(run('- dash'))
      )
    )
    expect(md).toBe(
      [
        '\\# not a heading \\*or\\* \\[link\\] \\_x\\_ \\\\',
        '1\\. not a list  \n\\> not a quote',
        '\\- dash'
      ].join('\n\n') + '\n'
    )
    expect(
      renderMarkdown(body({ kind: 'separator', separator: { kind: 'text', text: '###' } }))
    ).toBe('\\###\n')
    expect(renderMarkdown(body({ kind: 'separator', separator: { kind: 'pageBreak' } }))).toBe(
      '---\n'
    )
  })

  it('prefixes quoted blocks', () => {
    const md = renderMarkdown(body({ kind: 'quote', blocks: [p(run('One')), p(run('Two'))] }))
    expect(md).toBe('> One\n>\n> Two\n')
  })
})
