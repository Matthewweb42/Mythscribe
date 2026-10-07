import { describe, expect, it } from 'vitest'
import { defaultExportFormatting } from '@shared/bookExport'
import { bookCss, renderPrintHtml, unitsHtml } from './html'
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

const units: BookUnit[] = [
  { kind: 'matter', title: 'Dedication', blocks: [p(run('For <M> & co'))] },
  {
    kind: 'body',
    title: 'Book',
    blocks: [
      { kind: 'title', level: 'part', text: 'Part "One"', inPart: false },
      { kind: 'title', level: 'chapter', text: 'Chapter One', inPart: true },
      { kind: 'heading', level: 2, runs: [run('Dawn')], align: 'right' },
      p(
        run('Bold', { bold: true }),
        { kind: 'hardBreak' },
        run('all', { italic: true, underline: true, strike: true, code: true })
      ),
      { kind: 'sceneBreak' },
      { kind: 'quote', blocks: [p(run('Quoted'))] },
      { kind: 'title', level: 'chapter', text: 'Chapter Two', inPart: true }
    ]
  }
]

describe('unitsHtml (F-12.1)', () => {
  it('escapes text, nests marks, and marks page starts', () => {
    const html = unitsHtml(units, { xhtml: false, sceneBreak: '* * *', chapterNewPage: true })
    expect(html.split('\n')).toEqual([
      '<p>For &lt;M&gt; &amp; co</p>',
      '<h1 class="part page-break">Part &quot;One&quot;</h1>',
      '<h2 class="chapter page-break">Chapter One</h2>',
      '<h4 class="align-right">Dawn</h4>',
      '<p><strong>Bold</strong><br><em><u><s><code>all</code></s></u></em></p>',
      '<div class="scene-break">* * *</div>',
      '<blockquote><p>Quoted</p></blockquote>',
      '<h2 class="chapter page-break">Chapter Two</h2>'
    ])
  })

  it('self-closes line breaks for XHTML and leaves chapters unbroken when asked', () => {
    const html = unitsHtml(units, { xhtml: true, sceneBreak: '#', chapterNewPage: false })
    expect(html).toContain('<br/>')
    expect(html).toContain('<h2 class="chapter">Chapter Two</h2>')
    // A unit still starts a page.
    expect(html).toContain('<h1 class="part page-break">')
  })
})

describe('renderPrintHtml (F-12.1)', () => {
  it('is a whole page with the formatting as its style', () => {
    const formatting = {
      ...defaultExportFormatting('***'),
      font: 'sans' as const,
      fontSize: 14,
      pageSize: 'a4' as const,
      lineSpacing: 2 as const
    }
    const html = renderPrintHtml(units, formatting, 'My <Book>')
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<title>My &lt;Book&gt;</title>')
    expect(html).toContain(
      'font-family: Arial, Helvetica, sans-serif; font-size: 14pt; line-height: 2;'
    )
    expect(html).toContain('@page { size: A4; margin: 1in; }')
    expect(html).toContain('p + p { text-indent: 1.5em; }')
    expect(html).toContain('.page-break { break-before: page; }')
  })

  it('leaves size and pages out of the reader style and spaces unindented paragraphs', () => {
    const css = bookCss({ ...defaultExportFormatting('*'), indentParagraphs: false }, false)
    expect(css).toContain("font-family: Georgia, 'Times New Roman', serif; line-height: 1.5;")
    expect(css).not.toContain('@page')
    expect(css).not.toContain('pt;')
    expect(css).toContain('p + p { margin-top: 0.75em; }')
  })
})
