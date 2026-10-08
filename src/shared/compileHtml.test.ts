import { describe, expect, it } from 'vitest'
import { BookDetails } from './bookDetails'
import { BUILTIN_COMPILE_FORMATS, type CompileFormat, type CompileOutput } from './compileFormat'
import {
  bookBodyHtml,
  bookCss,
  cssString,
  furnitureContent,
  inlineHtml,
  printDocument,
  webDocument
} from './compileHtml'
import { compileBook, type CompiledBook, type CompileNode, type Run } from './compileModel'
import type { TiptapNodeT } from './tiptap'

const text = (value: string, marks: string[] = []): TiptapNodeT => ({
  type: 'text',
  text: value,
  ...(marks.length > 0 ? { marks: marks.map((type) => ({ type })) } : {})
})
const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((p) => ({ type: 'paragraph', content: [text(p)] }))
})
const node = (over: Partial<CompileNode>): CompileNode => ({
  id: 'x',
  kind: 'document',
  level: 'scene',
  depth: 0,
  title: '',
  meta: null,
  tags: [],
  content: null,
  synopsis: '',
  notes: null,
  ...over
})

function builtin(id: string): CompileFormat {
  const format = BUILTIN_COMPILE_FORMATS.find((f) => f.id === `builtin:${id}`)
  if (!format) throw new Error(`no ${id}`)
  return structuredClone(format)
}

function book(format: CompileFormat, output: CompileOutput = 'pdf'): CompiledBook {
  return compileBook({
    source: {
      front: [],
      manuscript: [
        node({ id: 'c1', kind: 'folder', level: 'chapter', title: 'The <Storm>' }),
        node({ id: 's1', depth: 1, content: doc('Rain & wind.', 'More rain.') }),
        node({ id: 's2', depth: 1, content: doc('After.') }),
        node({ id: 'c2', kind: 'folder', level: 'chapter', title: 'Calm' }),
        node({ id: 's3', depth: 1, content: doc('Quiet.') })
      ],
      end: []
    },
    format,
    output,
    details: BookDetails.parse({ title: 'Salt "Road"', author: 'Ada Marlowe' }),
    projectName: 'P',
    scope: { kind: 'manuscript' },
    excluded: []
  })
}

const run = (value: string, marks: Partial<Run> = {}): Run => ({
  kind: 'text',
  text: value,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  code: false,
  smallCaps: false,
  ai: false,
  ...marks
})

describe('compileHtml (Compile v2)', () => {
  it('prints marks and escapes every run', () => {
    expect(
      inlineHtml(
        [
          run('a<b>&', { bold: true, italic: true }),
          { kind: 'hardBreak' },
          run('x', { smallCaps: true, code: true })
        ],
        true
      )
    ).toBe('<strong><em>a&lt;b&gt;&amp;</em></strong><br/><span class="sc"><code>x</code></span>')
  })

  it('writes headers and footers as margin-box content with the page counter and running head', () => {
    const meta = book(builtin('standard-manuscript')).metadata
    expect(furnitureContent('{surname} / {TITLE} / {page}', meta)).toBe(
      '"Marlowe" " / " "SALT \\"ROAD\\"" " / " var(--ms-folio)'
    )
    expect(furnitureContent('{chapter}', meta)).toBe('string(chapter)')
    expect(furnitureContent('', meta)).toBe('none')
    expect(cssString('a\\b\n')).toBe('"a\\\\b "')
  })

  it('lays out a paperback page: trim size, mirrored margins with gutter, facing furniture', () => {
    const css = bookCss(book(builtin('paperback-6x9')), 'print')
    expect(css).toContain('@page { size: 6in 9in; margin: 0.75in 0.6in 0.75in 0.875in; }')
    expect(css).toContain('@page :left { margin-left: 0.6in; margin-right: 0.875in; }')
    expect(css).toContain('@page :right { margin-left: 0.875in; margin-right: 0.6in; }')
    expect(css).toContain('@page :right { @top-center { content: "Salt \\"Road\\""; }')
    expect(css).toContain('@page :left { @top-center { content: "Ada Marlowe"; }')
    expect(css).toContain('@bottom-center { content: var(--ms-folio); }')
    expect(css).toContain('.brk-recto { break-before: right; }')
    expect(css).toContain("font-family: 'EB Garamond', Georgia, 'Times New Roman', serif")
    expect(css).toContain('line-height: 15pt')
  })

  it('marks page runs on the print body: breaks, bare openers, the numbering restart', () => {
    const body = bookBodyHtml(book(builtin('paperback-6x9')), 'print')
    expect(body).toContain(
      '<h2 class="sec sec-chapter brk-recto ms-opener ms-restart" id="s-c1" data-running-head="The &lt;Storm&gt;">'
    )
    expect(body).toContain(
      '<span class="sec-line">Chapter One</span><span class="sec-line">The &lt;Storm&gt;</span>'
    )
    expect(body).toContain('<h2 class="sec sec-chapter brk-page ms-opener" id="s-c2"')
    expect(body).toContain('<p class="sep sep-text">* * *</p>')
    // The opening words after a chapter heading are small caps.
    expect(body).toMatch(/<p class="open-noindent"><span class="sc">Rain &amp; wind\.<\/span><\/p>/)
  })

  it('keeps the front division bare and uses only the furniture the page has', () => {
    const format = builtin('paperback-6x9')
    const body = bookBodyHtml(
      compileBook({
        source: { front: [], manuscript: [node({ id: 's', content: doc('Text.') })], end: [] },
        format,
        output: 'pdf',
        details: BookDetails.parse({ title: 'T', copyrightYear: '2026' }),
        projectName: 'P',
        scope: { kind: 'manuscript' },
        excluded: []
      }),
      'print'
    )
    expect(body).toContain('<section class="gen gen-title ms-front">')
    expect(body).toContain('<section class="gen gen-copyright ms-front brk-page">')
  })

  it('writes a standalone web page and a print document with the fonts and scripts given', () => {
    const b = book(builtin('editor-copy'), 'html')
    const web = webDocument(b)
    expect(web).toMatch(/^<!doctype html>\n<html lang="en">/)
    expect(web).toContain('<title>Salt &quot;Road&quot;</title>')
    expect(web).toContain('max-width: 36em')
    expect(web).not.toContain('@page')
    const print = printDocument(book(builtin('editor-copy')), {
      fontFaceCss: '@font-face { font-family: X; }',
      head: '<script>run()</script>'
    })
    expect(print).toContain('<style>\n@font-face { font-family: X; }\n')
    expect(print).toContain('<script>run()</script>\n</head>')
  })

  it('sizes EPUB headings in em against the body', () => {
    const css = bookCss(book(builtin('ebook'), 'epub'), 'epub')
    expect(css).toMatch(/\.sec-chapter \{[^}]*font-size: 1\.5em;[^}]*padding-top: 4em;/)
    expect(css).not.toContain('@page')
  })
})
