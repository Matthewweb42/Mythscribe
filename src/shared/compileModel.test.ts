import { describe, expect, it } from 'vitest'
import { defaultBookDetails, type BookDetails } from './bookDetails'
import {
  BUILTIN_COMPILE_FORMATS,
  type CompileFormat,
  type CompileOutput,
  type CompileScope,
  type Replacement,
  type SectionLayout
} from './compileFormat'
import {
  applyOpenings,
  approximateWords,
  compileBook,
  compileReplacements,
  contentBlocks,
  fillFurniture,
  formatNumber,
  furnitureSegments,
  furnitureValues,
  numberToRoman,
  numberToWords,
  sectionHeading,
  selectEntries,
  type BookItem,
  type CompileNode,
  type CompileSource,
  type ContentBlock,
  type ContentOptions,
  type Run
} from './compileModel'
import type { TiptapNodeT } from './tiptap'

// ---------------------------------------------------------------------------------------------
// Fixtures

const text = (value: string, marks: string[] = []): TiptapNodeT => ({
  type: 'text',
  text: value,
  ...(marks.length > 0 ? { marks: marks.map((type) => ({ type })) } : {})
})
const doc = (...content: TiptapNodeT[]): TiptapNodeT => ({ type: 'doc', content })
const para = (...content: TiptapNodeT[]): TiptapNodeT => ({ type: 'paragraph', content })
const words = (value: string): TiptapNodeT => doc(para(text(value)))

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
const p = (
  value: string,
  opening: 'none' | 'noIndent' | 'dropCap' | 'smallCapsLine' = 'none'
): ContentBlock => ({
  kind: 'paragraph',
  runs: [run(value)],
  align: null,
  opening
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

const builtin = (id: string): CompileFormat => {
  const format = BUILTIN_COMPILE_FORMATS.find((f) => f.id === `builtin:${id}`)
  if (!format) throw new Error(`no ${id}`)
  return structuredClone(format)
}

const OPTIONS: ContentOptions = {
  keepTags: false,
  keepAiMarks: false,
  separator: { kind: 'text', text: '#' },
  replace: (t) => t
}

/** Part 1 › Chapter A (two scenes), Chapter B (one scene); a prologue on the root first. */
function novel(): CompileNode[] {
  return [
    node({ id: 'pro', title: 'Prologue', content: words('Before it all.') }),
    node({ id: 'p1', kind: 'folder', level: 'part', title: 'Beginnings' }),
    node({ id: 'ca', kind: 'folder', level: 'chapter', depth: 1, title: 'The Storm' }),
    node({ id: 's1', depth: 2, title: 'S1', content: words('Rain fell hard.') }),
    node({ id: 's2', depth: 2, title: 'S2', content: words('Then it stopped.') }),
    node({ id: 'cb', kind: 'folder', level: 'chapter', depth: 1, title: 'The Calm' }),
    node({ id: 's3', depth: 2, title: 'S3', content: words('Quiet now.') })
  ]
}

interface Run2 {
  format?: CompileFormat
  output?: CompileOutput
  details?: Partial<BookDetails>
  scope?: CompileScope
  excluded?: string[]
  source?: Partial<CompileSource>
}

function compile(args: Run2 = {}): ReturnType<typeof compileBook> {
  return compileBook({
    source: { front: [], manuscript: novel(), end: [], ...args.source },
    format: args.format ?? builtin('plain-text'),
    output: args.output ?? 'docx',
    details: { ...defaultBookDetails(), ...args.details },
    projectName: 'My Novel',
    scope: args.scope ?? { kind: 'manuscript' },
    excluded: args.excluded ?? []
  })
}

/** A compact reading of the items: `section:<level>:<lines>`, `sep`, `text:<id>`, `page:<kind>`, … */
function outline(items: readonly BookItem[]): string[] {
  return items.map((item) => {
    switch (item.kind) {
      case 'section':
        return `section:${item.level}:${item.heading?.lines.join('|') ?? '-'}`
      case 'separator':
        return 'sep'
      case 'text':
        return `text:${item.id}`
      case 'page':
        return `page:${item.page.kind}`
      case 'matter':
        return `matter:${item.title}`
      case 'synopsis':
        return `synopsis:${item.id}`
      case 'note':
        return `note:${item.id}:${item.mode}`
    }
  })
}

function textItem(items: readonly BookItem[], id: string): ContentBlock[] {
  const item = items.find((i) => i.kind === 'text' && i.id === id)
  if (item?.kind !== 'text') throw new Error(`no text ${id}`)
  return item.blocks
}

// ---------------------------------------------------------------------------------------------

describe('contentBlocks', () => {
  it('reads paragraphs with the five printed marks, dropping AI, tag-range, and unknown marks', () => {
    const blocks = contentBlocks(
      doc({
        type: 'paragraph',
        attrs: { textAlign: 'center', origin: 'import' },
        content: [
          text('Plain '),
          text('bold', ['bold', 'aiOrigin']),
          text(' and '),
          text('all', ['italic', 'underline', 'strike', 'code', 'mystery', 'tagRange'])
        ]
      }),
      OPTIONS
    )
    expect(blocks).toEqual([
      {
        kind: 'paragraph',
        align: 'center',
        opening: 'none',
        runs: [
          run('Plain '),
          run('bold', { bold: true }),
          run(' and '),
          run('all', { italic: true, underline: true, strike: true, code: true })
        ]
      }
    ])
  })

  it('keeps AI marks and #tags only when asked', () => {
    const source = doc(
      para(text('Met ', ['aiOrigin']), { type: 'inlineTag', attrs: { name: 'mara' } })
    )
    expect(contentBlocks(source, OPTIONS)).toEqual([
      { kind: 'paragraph', align: null, opening: 'none', runs: [run('Met '), run('mara')] }
    ])
    expect(contentBlocks(source, { ...OPTIONS, keepTags: true, keepAiMarks: true })).toEqual([
      {
        kind: 'paragraph',
        align: null,
        opening: 'none',
        runs: [run('Met ', { ai: true }), run('#mara')]
      }
    ])
  })

  it('keeps hard breaks, drops empty paragraphs, and reads headings, quotes, breaks, unknown nodes', () => {
    const blocks = contentBlocks(
      doc(
        para(),
        para(text('A'), { type: 'hardBreak' }, text('B')),
        { type: 'heading', attrs: { level: 3, textAlign: 'bogus' }, content: [text('Late')] },
        { type: 'heading', attrs: { level: 9 }, content: [text('Odd')] },
        { type: 'blockquote', content: [para(text('Quoted'))] },
        { type: 'sceneBreak' },
        { type: 'mysteryBlock', content: [para(text('Inside'))] },
        text('stray')
      ),
      OPTIONS
    )
    expect(blocks).toEqual([
      {
        kind: 'paragraph',
        align: null,
        opening: 'none',
        runs: [run('A'), { kind: 'hardBreak' }, run('B')]
      },
      { kind: 'heading', level: 3, align: null, runs: [run('Late')] },
      { kind: 'heading', level: 1, align: null, runs: [run('Odd')] },
      { kind: 'quote', blocks: [p('Quoted')] },
      { kind: 'separator', separator: { kind: 'text', text: '#' } },
      p('Inside'),
      p('stray')
    ])
  })

  it('applies replacements to every run and drops a run they empty', () => {
    const replace = compileReplacements([
      { enabled: true, find: '--', replace: '—', regex: false, caseSensitive: true },
      { enabled: true, find: 'XX', replace: '', regex: false, caseSensitive: true }
    ])
    expect(
      contentBlocks(doc(para(text('Wait--no'), text('XX', ['italic']))), { ...OPTIONS, replace })
    ).toEqual([{ kind: 'paragraph', align: null, opening: 'none', runs: [run('Wait—no')] }])
  })
})

describe('compileReplacements', () => {
  const rule = (over: Partial<Replacement>): Replacement => ({
    enabled: true,
    find: 'a',
    replace: 'b',
    regex: false,
    caseSensitive: true,
    ...over
  })

  it('replaces plain text literally, every occurrence, with case control', () => {
    expect(compileReplacements([rule({ find: '...', replace: '…' })])('Wait... what...')).toBe(
      'Wait… what…'
    )
    expect(compileReplacements([rule({ find: 'Mara', replace: '$1' })])('Mara')).toBe('$1')
    expect(compileReplacements([rule({ find: 'mara', replace: 'Kel' })])('Mara mara')).toBe(
      'Mara Kel'
    )
    expect(
      compileReplacements([rule({ find: 'mara', replace: 'Kel', caseSensitive: false })])(
        'Mara mara'
      )
    ).toBe('Kel Kel')
  })

  it('runs regex rules with groups, in order, and skips disabled and broken rules', () => {
    const replace = compileReplacements([
      rule({ find: '\\[\\[(\\w+)\\]\\]', replace: '$1', regex: true }),
      rule({ find: 'Name', replace: 'Mara' }),
      rule({ find: 'x', replace: 'y', enabled: false }),
      // Only a hand-edited file can hold this; the schema refuses it.
      rule({ find: '(', replace: '', regex: true })
    ])
    expect(replace('Hello [[Name]] x')).toBe('Hello Mara x')
    expect(compileReplacements([])('same')).toBe('same')
  })
})

describe('applyOpenings', () => {
  const scene = { style: 'noIndent', firstWords: 3 } as const

  it('opens the first paragraph and the one after each separator', () => {
    const sep: ContentBlock = { kind: 'separator', separator: { kind: 'blankLine' } }
    const result = applyOpenings(
      [
        { kind: 'heading', level: 1, runs: [run('H')], align: null },
        p('One'),
        p('Two'),
        sep,
        p('Three')
      ],
      { style: 'dropCap', firstWords: 3 },
      scene
    )
    expect(result.blocks).toEqual([
      { kind: 'heading', level: 1, runs: [run('H')], align: null },
      p('One', 'dropCap'),
      p('Two'),
      sep,
      p('Three', 'noIndent')
    ])
    expect(result.pending).toBeNull()
  })

  it('carries the opening over when no paragraph came, and leaves "indent" plain', () => {
    expect(applyOpenings([], { style: 'smallCapsLine', firstWords: 1 }, scene).pending).toEqual({
      style: 'smallCapsLine',
      firstWords: 1
    })
    expect(applyOpenings([p('One')], { style: 'indent', firstWords: 3 }, scene).blocks).toEqual([
      p('One')
    ])
  })

  it('sets small caps on the first words, splitting a run and crossing runs', () => {
    const block: ContentBlock = {
      kind: 'paragraph',
      align: null,
      opening: 'none',
      runs: [run('The '), run('rain fell', { italic: true }), run(' hard today.')]
    }
    const { blocks } = applyOpenings([block], { style: 'smallCapsWords', firstWords: 3 }, scene)
    expect(blocks).toEqual([
      {
        kind: 'paragraph',
        align: null,
        opening: 'noIndent',
        runs: [
          run('The ', { smallCaps: true }),
          run('rain fell', { italic: true, smallCaps: true }),
          run(' ', { smallCaps: true }),
          run('hard today.')
        ]
      }
    ])
    const short = applyOpenings([p('Hi')], { style: 'smallCapsWords', firstWords: 3 }, scene)
    expect(short.blocks).toEqual([
      {
        kind: 'paragraph',
        align: null,
        opening: 'noIndent',
        runs: [run('Hi', { smallCaps: true })]
      }
    ])
  })
})

describe('numbering', () => {
  it('spells numbers in title-case words', () => {
    expect([1, 7, 12, 20, 21, 45, 100, 105, 999, 1000, 2024].map(numberToWords)).toEqual([
      'One',
      'Seven',
      'Twelve',
      'Twenty',
      'Twenty-One',
      'Forty-Five',
      'One Hundred',
      'One Hundred Five',
      'Nine Hundred Ninety-Nine',
      'One Thousand',
      'Two Thousand Twenty-Four'
    ])
    expect(numberToWords(1_000_000)).toBe('1000000')
  })

  it('writes Roman numerals 1–3999 and digits beyond', () => {
    expect([1, 4, 9, 14, 40, 90, 400, 1994, 3999].map(numberToRoman)).toEqual([
      'I',
      'IV',
      'IX',
      'XIV',
      'XL',
      'XC',
      'CD',
      'MCMXCIV',
      'MMMCMXCIX'
    ])
    expect(numberToRoman(0)).toBe('0')
    expect(numberToRoman(4000)).toBe('4000')
  })

  it('formats per style', () => {
    expect(['none', 'words', 'digits', 'roman'].map((s) => formatNumber(3, s as 'none'))).toEqual([
      '',
      'Three',
      '3',
      'III'
    ])
  })
})

describe('sectionHeading', () => {
  const base: SectionLayout = builtin('plain-text').sections.chapter

  it('covers every numbering style the author asked for', () => {
    const at = (
      over: Partial<SectionLayout>,
      n: number | null = 1,
      title = 'The Storm'
    ): string[] | null => sectionHeading({ ...base, ...over }, n, title)?.lines ?? null
    // Words, digits, Roman.
    expect(at({ numbering: 'words', prefix: 'Chapter ', showTitle: false })).toEqual([
      'Chapter One'
    ])
    expect(at({ numbering: 'digits', prefix: 'Chapter ', showTitle: false })).toEqual(['Chapter 1'])
    expect(at({ numbering: 'roman', showTitle: false }, 2)).toEqual(['II'])
    // Number + title on one line or two.
    expect(at({ numbering: 'digits', suffix: '.' })).toEqual(['1. The Storm'])
    expect(at({ numbering: 'words', prefix: 'Chapter ', suffix: ':' })).toEqual([
      'Chapter One: The Storm'
    ])
    expect(at({ numbering: 'words', prefix: 'Chapter ', titleOnNewLine: true })).toEqual([
      'Chapter One',
      'The Storm'
    ])
    // Titles only.
    expect(at({ numbering: 'none' })).toEqual(['The Storm'])
    // Nothing to print.
    expect(at({ numbering: 'none', showTitle: false })).toBeNull()
    expect(at({ numbering: 'none' }, 1, '   ')).toBeNull()
    expect(at({ numbering: 'words', showTitle: false }, null)).toBeNull()
  })

  it('upper-cases lines for the upper case, keeps `plain` as typed, and replaces in titles', () => {
    const heading = sectionHeading(
      { ...base, numbering: 'words', prefix: 'Chapter ', case: 'upper', titleOnNewLine: true },
      3,
      'Mara--alone',
      compileReplacements([
        { enabled: true, find: '--', replace: '—', regex: false, caseSensitive: true }
      ])
    )
    expect(heading).toEqual({
      label: 'Chapter Three',
      title: 'Mara—alone',
      lines: ['CHAPTER THREE', 'MARA—ALONE'],
      plain: 'Chapter Three Mara—alone'
    })
  })
})

describe('headers and footers', () => {
  it('splits a slot into text and tokens, leaving unknown braces as text', () => {
    expect(furnitureSegments('{surname} / {TITLE} / {page} {nope}')).toEqual([
      { kind: 'token', token: 'surname' },
      { kind: 'text', text: ' / ' },
      { kind: 'token', token: 'TITLE' },
      { kind: 'text', text: ' / ' },
      { kind: 'token', token: 'page' },
      { kind: 'text', text: ' {nope}' }
    ])
    expect(furnitureSegments('')).toEqual([])
  })

  it('fills every token from the book and the page', () => {
    const book = compile({ details: { author: 'Ann Marie Lee', title: 'River' } })
    const values = furnitureValues(book.metadata, '7', 'The Storm')
    expect(fillFurniture('{surname} / {TITLE} / {page}', values)).toBe('Lee / RIVER / 7')
    expect(fillFurniture('{author} — {title} — {chapter} ({wordcount})', values)).toBe(
      'Ann Marie Lee — River — The Storm (about 100 words)'
    )
  })

  it('rounds the Shunn word count', () => {
    expect(approximateWords(0)).toBe('about 0 words')
    expect(approximateWords(12)).toBe('about 100 words')
    expect(approximateWords(4_449)).toBe('about 4,400 words')
    expect(approximateWords(84_612)).toBe('about 85,000 words')
  })
})

describe('selectEntries', () => {
  const tree = novel()

  it('drops an excluded node with its subtree', () => {
    expect(selectEntries(tree, new Set(['ca', 'pro'])).map((n) => n.id)).toEqual(['p1', 'cb', 's3'])
    expect(selectEntries(tree, new Set(['s2', 'unknown'])).map((n) => n.id)).toEqual([
      'pro',
      'p1',
      'ca',
      's1',
      'cb',
      's3'
    ])
  })

  it('keeps chosen nodes with their ancestors and descendants, exclusions still applied', () => {
    expect(selectEntries(tree, new Set(), new Set(['cb'])).map((n) => n.id)).toEqual([
      'p1',
      'cb',
      's3'
    ])
    expect(selectEntries(tree, new Set(['s1']), new Set(['ca', 'pro'])).map((n) => n.id)).toEqual([
      'pro',
      'p1',
      'ca',
      's2'
    ])
    expect(selectEntries(tree, new Set(), new Set(['missing']))).toEqual([])
  })
})

describe('compileBook: body structure', () => {
  it('numbers chapters only, leaves the prologue unnumbered, and nests by part', () => {
    const format = builtin('standard-manuscript')
    const book = compile({ format })
    expect(outline(book.items)).toEqual([
      'page:manuscriptTitle',
      'section:chapterScene:Prologue',
      'text:pro',
      'section:part:BEGINNINGS',
      'section:chapter:Chapter One|The Storm',
      'text:s1',
      'sep',
      'text:s2',
      'section:chapter:Chapter Two|The Calm',
      'text:s3'
    ])
    const sections = book.items.filter((i) => i.kind === 'section')
    expect(sections.map((s) => [s.id, s.inPart, s.break, s.runningHead])).toEqual([
      ['pro', false, 'newPage', 'Prologue'],
      // A part leaves the running head to the chapters.
      ['p1', false, 'newPage', 'Prologue'],
      ['ca', true, 'newPage', 'The Storm'],
      ['cb', true, 'newPage', 'The Calm']
    ])
    expect(book.toc.map((t) => [t.id, t.level, t.label, t.inPart])).toEqual([
      ['pro', 'chapterScene', 'Prologue', false],
      ['p1', 'part', 'Beginnings', false],
      ['ca', 'chapter', 'Chapter One The Storm', true],
      ['cb', 'chapter', 'Chapter Two The Calm', true]
    ])
  })

  it('counts a chapter-level scene with the chapters when its numbering is on; parts count apart', () => {
    const format = builtin('plain-text')
    format.sections.chapterScene = { ...format.sections.chapterScene, numbering: 'digits' }
    format.sections.chapter = { ...format.sections.chapter, numbering: 'digits', suffix: '.' }
    format.sections.part = {
      ...format.sections.part,
      numbering: 'roman',
      prefix: 'Part ',
      showTitle: false
    }
    const lines = outline(compile({ format }).items).filter((l) => l.startsWith('section'))
    // Turned on for the level, the prologue takes number 1 (no suffix on its level).
    expect(lines).toEqual([
      'section:chapterScene:1 Prologue',
      'section:part:Part I',
      'section:chapter:2. The Storm',
      'section:chapter:3. The Calm'
    ])
  })

  it('prints scene headings and numbers scenes across the book when the scene layout asks', () => {
    const format = builtin('plain-text')
    format.sections.scene = {
      ...format.sections.scene,
      numbering: 'digits',
      prefix: 'Scene ',
      showTitle: false
    }
    expect(outline(compile({ format }).items)).toEqual([
      'section:chapterScene:Prologue',
      'text:pro',
      'section:part:Beginnings',
      'section:chapter:The Storm',
      'section:scene:Scene 1',
      'text:s1',
      'sep',
      'section:scene:Scene 2',
      'text:s2',
      'section:chapter:The Calm',
      'section:scene:Scene 3',
      'text:s3'
    ])
  })

  it('replaces the separator by the page break of a scene that starts a page', () => {
    const format = builtin('plain-text')
    format.sections.scene = { ...format.sections.scene, pageBreak: 'newPage' }
    const items = compile({ format }).items
    expect(outline(items).slice(4, 8)).toEqual([
      'section:scene:-',
      'text:s1',
      'section:scene:-',
      'text:s2'
    ])
  })

  it('puts no separator before an empty scene or after a heading, and one between documents of a scene folder', () => {
    const manuscript = [
      node({ id: 'c', kind: 'folder', level: 'chapter', title: 'C' }),
      node({ id: 'e', depth: 1, content: words('   ') }),
      node({ id: 'a', depth: 1, content: words('Alpha.') }),
      node({ id: 'empty', depth: 1, content: null }),
      node({ id: 'f', kind: 'folder', depth: 1 }),
      node({ id: 'f1', level: null, depth: 2, content: words('One.') }),
      node({ id: 'f2', level: null, depth: 2, content: words('Two.') }),
      node({ id: 'g', kind: 'folder', level: null, depth: 1, title: 'Generic' })
    ]
    expect(outline(compile({ source: { manuscript } }).items)).toEqual([
      'section:chapter:C',
      'text:a',
      'sep',
      'text:f1',
      'sep',
      'text:f2'
    ])
  })

  it('opens the first paragraph by the section layout and after a separator by the scene layout', () => {
    const format = builtin('paperback-6x9')
    const book = compile({ format })
    // Paperback chapters open with small-caps words; the scene after a separator unindented.
    expect(textItem(book.items, 's1')[0]).toMatchObject({
      opening: 'noIndent',
      runs: [run('Rain fell hard.', { smallCaps: true })]
    })
    expect(textItem(book.items, 's2')).toEqual([p('Then it stopped.', 'noIndent')])
    const ebook = compile({ format: builtin('ebook') })
    expect(textItem(ebook.items, 's1')).toEqual([p('Rain fell hard.', 'dropCap')])
    // Standard Manuscript indents every paragraph.
    const smf = compile({ format: builtin('standard-manuscript') })
    expect(textItem(smf.items, 's2')).toEqual([p('Then it stopped.')])
  })

  it('applies the in-document scene break as the separator, followed by the scene opening', () => {
    const manuscript = [
      node({
        id: 's',
        level: null,
        content: doc(para(text('One.')), { type: 'sceneBreak' }, para(text('Two.')))
      })
    ]
    const book = compile({ format: builtin('ebook'), source: { manuscript }, output: 'epub' })
    expect(textItem(book.items, 's')).toEqual([
      p('One.'),
      { kind: 'separator', separator: { kind: 'text', text: '⁂' } },
      p('Two.', 'noIndent')
    ])
  })
})

describe('compileBook: generated pages and matter', () => {
  const details: Partial<BookDetails> = {
    title: 'River',
    subtitle: 'A Novel',
    series: 'Waters',
    seriesNumber: 'Two',
    author: 'Ann Lee',
    legalName: 'Ann M. Lee',
    contact: '1 Main St\n\nann@example.com',
    isbns: [
      { edition: 'Paperback', isbn: '978-1-00' },
      { edition: 'Ebook', isbn: '978-2-00' }
    ],
    publisher: 'Small Press',
    copyrightYear: '2026',
    rights: 'All rights reserved.',
    edition: 'First edition',
    dedication: 'For M.\nAnd for T.',
    epigraph: 'All rivers run to the sea.',
    epigraphSource: 'Ecclesiastes',
    aboutAuthor: 'Ann lives by a river.',
    alsoBy: ['Lake', '  ', 'Sea'],
    cover: 'cover-1234abcd.jpg',
    keywords: ['river', ' '],
    description: 'A blurb.'
  }
  const front = [
    node({ id: 'fm', level: null, title: 'Foreword', content: words('A word first.') }),
    node({ id: 'fe', level: null, title: 'Empty', content: null })
  ]
  const end = [
    node({ id: 'af', kind: 'folder', level: null, title: 'Afterword' }),
    node({ id: 'af1', level: null, depth: 1, content: words('Thanks to all.') })
  ]

  it('builds the paperback front and back in order with recto starts', () => {
    const book = compile({
      format: builtin('paperback-6x9'),
      output: 'pdf',
      details,
      source: { front, end }
    })
    expect(outline(book.items)).toEqual([
      'page:titlePage',
      'page:copyright',
      'page:dedication',
      'page:epigraph',
      'matter:Foreword',
      'section:chapterScene:Prologue',
      'text:pro',
      'section:part:Part One|Beginnings',
      'section:chapter:Chapter One|The Storm',
      'text:s1',
      'sep',
      'text:s2',
      'section:chapter:Chapter Two|The Calm',
      'text:s3',
      'matter:Afterword',
      'page:aboutAuthor',
      'page:alsoBy'
    ])
    const pages = book.items.filter((i) => i.kind === 'page')
    expect(pages.map((i) => [i.page.kind, i.break, i.division])).toEqual([
      ['titlePage', 'newRecto', 'front'],
      ['copyright', 'newPage', 'front'],
      ['dedication', 'newRecto', 'front'],
      ['epigraph', 'newRecto', 'front'],
      ['aboutAuthor', 'newPage', 'back'],
      ['alsoBy', 'newPage', 'back']
    ])
    expect(pages.map((i) => i.page)).toEqual([
      {
        kind: 'titlePage',
        title: 'River',
        subtitle: 'A Novel',
        author: 'Ann Lee',
        series: 'Waters, Book Two',
        publisher: 'Small Press'
      },
      {
        kind: 'copyright',
        lines: [
          'Copyright © 2026 Ann Lee',
          'All rights reserved.',
          'First edition',
          'ISBN 978-1-00',
          'Small Press'
        ]
      },
      { kind: 'dedication', paragraphs: ['For M.', 'And for T.'] },
      { kind: 'epigraph', paragraphs: ['All rivers run to the sea.'], source: 'Ecclesiastes' },
      { kind: 'aboutAuthor', title: 'About the Author', paragraphs: ['Ann lives by a river.'] },
      { kind: 'alsoBy', title: 'Also by Ann Lee', titles: ['Lake', 'Sea'] }
    ])
    const matter = book.items.filter((i) => i.kind === 'matter')
    expect(matter.map((m) => [m.id, m.division, m.break, m.blocks])).toEqual([
      ['fm', 'front', 'newPage', [p('A word first.')]],
      ['af', 'back', 'newPage', [p('Thanks to all.')]]
    ])
    // Body 3 + 3 + 3 + 2, matter 3 + 3.
    expect(book.words).toBe(17)
    expect(book.metadata).toMatchObject({ isbn: '978-1-00', cover: null, bodyWords: 11 })
  })

  it('adds the linked contents page to the ebook, with its cover and ebook ISBN', () => {
    const book = compile({ format: builtin('ebook'), output: 'epub', details })
    const toc = book.items.find((i) => i.kind === 'page' && i.page.kind === 'toc')
    expect(toc).toMatchObject({
      division: 'front',
      break: 'newPage',
      page: { kind: 'toc', title: 'Contents', entries: book.toc }
    })
    expect(book.toc).toHaveLength(4)
    expect(book.metadata).toMatchObject({
      title: 'River',
      isbn: '978-2-00',
      cover: 'cover-1234abcd.jpg',
      keywords: ['river'],
      language: 'en',
      description: 'A blurb.'
    })
  })

  it('opens Standard Manuscript with the Shunn block and leaves matter out', () => {
    const book = compile({
      format: builtin('standard-manuscript'),
      details,
      source: { front, end }
    })
    expect(book.items[0]).toEqual({
      kind: 'page',
      division: 'front',
      break: 'newPage',
      page: {
        kind: 'manuscriptTitle',
        contact: ['Ann M. Lee', '1 Main St', 'ann@example.com'],
        wordCount: 'about 100 words',
        title: 'River',
        byline: 'by Ann Lee'
      }
    })
    expect(
      outline(book.items).filter((l) => l.startsWith('matter') || l.startsWith('page'))
    ).toEqual(['page:manuscriptTitle'])
  })

  it('leaves out generated pages with nothing to print and uses the project name as title', () => {
    const book = compile({ format: builtin('paperback-5x8') })
    expect(outline(book.items).filter((l) => l.startsWith('page'))).toEqual(['page:titlePage'])
    expect(book.items[0]).toMatchObject({ page: { title: 'My Novel', author: '', series: '' } })
    expect(book.metadata).toMatchObject({ title: 'My Novel', surname: '', isbn: '' })
  })

  it('honours the include ticks in matter too', () => {
    const book = compile({
      format: builtin('paperback-6x9'),
      source: { front, end },
      excluded: ['fm', 'af1', 's1']
    })
    expect(outline(book.items)).not.toContain('matter:Foreword')
    expect(outline(book.items)).not.toContain('matter:Afterword')
    expect(outline(book.items)).not.toContain('text:s1')
  })
})

describe('compileBook: contents options and scopes', () => {
  const withMeta = (): CompileNode[] =>
    novel().map((n) =>
      n.id === 's1'
        ? { ...n, synopsis: 'Mara arrives.', notes: words('Check tides.') }
        : n.id === 'ca'
          ? { ...n, synopsis: 'The storm chapter.' }
          : n
    )

  it('prints synopses instead of text for the outline', () => {
    const book = compile({ format: builtin('outline'), source: { manuscript: withMeta() } })
    expect(outline(book.items)).toEqual([
      'page:titlePage',
      'section:chapterScene:Prologue',
      'section:part:Beginnings',
      'section:chapter:The Storm',
      'synopsis:ca',
      'section:scene:S1',
      'synopsis:s1',
      'section:scene:S2',
      'section:chapter:The Calm',
      'section:scene:S3'
    ])
    expect(book.items.find((i) => i.kind === 'synopsis' && i.id === 's1')).toMatchObject({
      text: 'Mara arrives.'
    })
  })

  it('attaches notes as comments for the editor copy, inline when asked, never by default', () => {
    const editor = compile({ format: builtin('editor-copy'), source: { manuscript: withMeta() } })
    const at = outline(editor.items).indexOf('text:s1')
    expect(outline(editor.items)[at + 1]).toBe('note:s1:comments')
    const inline = builtin('plain-text')
    inline.contents = { ...inline.contents, notes: 'inline' }
    expect(
      outline(compile({ format: inline, source: { manuscript: withMeta() } }).items)
    ).toContain('note:s1:inline')
    expect(outline(compile({ source: { manuscript: withMeta() } }).items).join()).not.toContain(
      'note'
    )
  })

  it('keeps #tags and AI marks for editing outputs only', () => {
    const manuscript = [
      node({
        id: 's',
        level: null,
        content: doc(
          para(text('Saw ', ['aiOrigin']), { type: 'inlineTag', attrs: { name: 'mara' } })
        )
      })
    ]
    const format = builtin('editor-copy')
    format.contents = { ...format.contents, keepTags: true, keepAiMarks: true }
    expect(textItem(compile({ format, source: { manuscript } }).items, 's')).toEqual([
      {
        kind: 'paragraph',
        align: null,
        opening: 'none',
        runs: [run('Saw ', { ai: true }), run('#mara')]
      }
    ])
    for (const output of ['pdf', 'epub'] as const) {
      expect(textItem(compile({ format, output, source: { manuscript } }).items, 's')).toEqual([
        { kind: 'paragraph', align: null, opening: 'none', runs: [run('Saw '), run('mara')] }
      ])
    }
  })

  it('compiles selected chapters with their part, and one document alone from any section', () => {
    expect(outline(compile({ scope: { kind: 'chapters', ids: ['cb', 'pro'] } }).items)).toEqual([
      'section:chapterScene:Prologue',
      'text:pro',
      'section:part:Beginnings',
      'section:chapter:The Calm',
      'text:s3'
    ])
    const front = [node({ id: 'd', level: null, title: 'Dedication', content: words('For M.') })]
    const alone = compile({
      format: builtin('paperback-6x9'),
      scope: { kind: 'document', id: 'd' },
      source: { front }
    })
    expect(alone.items).toEqual([
      { kind: 'text', division: 'body', id: 'd', blocks: [p('For M.')] }
    ])
    expect(alone.words).toBe(2)
    expect(alone.metadata.bodyWords).toBe(2)
    // A scene alone prints no heading; an unknown id or a folder compiles to nothing.
    expect(outline(compile({ scope: { kind: 'document', id: 'pro' } }).items)).toEqual(['text:pro'])
    expect(compile({ scope: { kind: 'document', id: 'nope' } }).items).toEqual([])
    expect(compile({ scope: { kind: 'document', id: 'ca' } }).items).toEqual([])
  })

  it('compiles every built-in format for every output without throwing', () => {
    for (const format of BUILTIN_COMPILE_FORMATS) {
      for (const output of ['pdf', 'docx', 'epub', 'rtf', 'odt', 'html', 'txt', 'md'] as const) {
        const book = compile({ format, output, details: { author: 'A B' } })
        expect(book.items.length).toBeGreaterThan(0)
        expect(book.output).toBe(output)
      }
    }
  })
})
