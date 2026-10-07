import { describe, expect, it } from 'vitest'
import {
  BUILTIN_COMPILE_FORMATS,
  COMPILE_FORMAT_NAME_MAX,
  COMPILE_OUTPUTS,
  COMPILE_OUTPUT_EXTENSIONS,
  CompileFormat,
  CompileFormatLibrary,
  CompileProjectState,
  DEFAULT_COMPILE_FORMAT_ID,
  PAGE_SIZE_INFO,
  Replacement,
  copyName,
  defaultCompileProjectState,
  duplicateFormat,
  findCompileFormat,
  formatNameTaken,
  isBuiltinFormatId,
  pageDimensions,
  parseCompileFormat,
  setIncluded,
  sortFormats
} from './compileFormat'

const smf = (): CompileFormat => {
  const format = BUILTIN_COMPILE_FORMATS[0]
  if (!format) throw new Error('no built-ins')
  return structuredClone(format)
}
const mine = (id: string, name: string): CompileFormat => ({ ...smf(), id, name })

describe('built-in compile formats', () => {
  it('ship the seven the author asked for, each valid, built-in, and uniquely named', () => {
    expect(BUILTIN_COMPILE_FORMATS.map((f) => [f.name, f.defaultOutput])).toEqual([
      ['Standard Manuscript', 'docx'],
      ['Paperback 6 × 9', 'pdf'],
      ['Paperback 5 × 8', 'pdf'],
      ['Ebook', 'epub'],
      ['Editor copy', 'docx'],
      ['Outline', 'docx'],
      ['Plain text', 'txt']
    ])
    for (const format of BUILTIN_COMPILE_FORMATS) {
      expect(CompileFormat.parse(format)).toEqual(format)
      expect(isBuiltinFormatId(format.id)).toBe(true)
    }
    expect(new Set(BUILTIN_COMPILE_FORMATS.map((f) => f.id)).size).toBe(7)
    expect(DEFAULT_COMPILE_FORMAT_ID).toBe('builtin:standard-manuscript')
  })

  it('sets Standard Manuscript to Shunn: 12 pt, double, 1" margins, header, # breaks, contact page', () => {
    const format = smf()
    expect(format.typography).toMatchObject({
      size: 12,
      lineSpacing: { mode: 'multiple', value: 2 }
    })
    expect(format.pageSetup.margins).toEqual({ top: 1, bottom: 1, inside: 1, outside: 1 })
    expect(format.headersFooters.recto.header.right).toBe('{surname} / {TITLE} / {page}')
    expect(format.sceneSeparator).toEqual({ kind: 'text', text: '#' })
    expect(format.sections.chapter.pageBreak).toBe('newPage')
    expect(format.matter.titlePage).toBe('manuscript')
  })

  it('sets the paperbacks to mirrored trims with running heads hidden on openers', () => {
    for (const [id, size] of [
      ['builtin:paperback-6x9', 'trim6x9'],
      ['builtin:paperback-5x8', 'trim5x8']
    ] as const) {
      const format = findCompileFormat([], id)
      expect(format?.pageSetup).toMatchObject({ size, mirrored: true })
      expect(format?.headersFooters).toMatchObject({ facing: true, hideOnOpeners: true })
      expect(format?.headersFooters.verso.header.center).toBe('{author}')
    }
  })

  it('maps every output to an extension', () => {
    expect(COMPILE_OUTPUTS.map((o) => COMPILE_OUTPUT_EXTENSIONS[o])).toEqual([
      'pdf',
      'docx',
      'epub',
      'rtf',
      'odt',
      'html',
      'txt',
      'md'
    ])
  })
})

describe('page setup', () => {
  it('reads trim sizes from the table and custom sizes from the setup', () => {
    const setup = smf().pageSetup
    expect(pageDimensions(setup)).toEqual({ width: 8.5, height: 11 })
    expect(pageDimensions({ ...setup, size: 'trim5_25x8' })).toEqual({ width: 5.25, height: 8 })
    expect(pageDimensions({ ...setup, size: 'custom', width: 4.25, height: 7 })).toEqual({
      width: 4.25,
      height: 7
    })
    expect(Object.keys(PAGE_SIZE_INFO)).toEqual(
      expect.arrayContaining(['trim5x8', 'trim5_25x8', 'trim5_5x8_5', 'trim6x9', 'a5'])
    )
  })
})

describe('Replacement', () => {
  it('refuses a regex rule that does not compile, but not the same text as plain', () => {
    const rule = { enabled: true, find: '(', replace: '', regex: true, caseSensitive: true }
    expect(Replacement.safeParse(rule).success).toBe(false)
    expect(Replacement.safeParse({ ...rule, regex: false }).success).toBe(true)
  })
})

describe('the format library', () => {
  it('reads leniently: a format that no longer parses is dropped, a non-list reads as empty', () => {
    const good = mine('my:1', 'Mine')
    expect(CompileFormatLibrary.parse([good, { id: 'bad' }, 3])).toEqual([good])
    expect(CompileFormatLibrary.parse(undefined)).toEqual([])
    expect(CompileFormatLibrary.parse('nope')).toEqual([])
    expect(parseCompileFormat({ ...good, version: 2 })).toBeNull()
  })

  it('finds built-ins and library formats by id', () => {
    const lib = [mine('my:1', 'Mine')]
    expect(findCompileFormat(lib, 'my:1')?.name).toBe('Mine')
    expect(findCompileFormat(lib, 'builtin:ebook')?.name).toBe('Ebook')
    expect(findCompileFormat(lib, 'missing')).toBeNull()
  })

  it('sorts by name and checks names ignoring case and spaces', () => {
    const lib = [mine('my:1', 'zeta'), mine('my:2', 'Alpha')]
    expect(sortFormats(lib).map((f) => f.name)).toEqual(['Alpha', 'zeta'])
    expect(formatNameTaken(lib, ' ALPHA ')).toBe(true)
    expect(formatNameTaken(lib, 'alpha', 'my:2')).toBe(false)
    expect(formatNameTaken(lib, 'Beta')).toBe(false)
  })

  it('names copies "X copy", then "X copy 2", within the length cap', () => {
    expect(copyName([], 'Ebook')).toBe('Ebook copy')
    const lib = [mine('my:1', 'Ebook copy'), mine('my:2', 'Ebook copy 2')]
    expect(copyName(lib, 'Ebook')).toBe('Ebook copy 3')
    const long = 'x'.repeat(COMPILE_FORMAT_NAME_MAX)
    expect(copyName([], long).length).toBeLessThanOrEqual(COMPILE_FORMAT_NAME_MAX)
  })

  it('duplicates deeply under a new id and name', () => {
    const source = smf()
    const copy = duplicateFormat(source, 'my:9', 'Mine')
    expect(copy).toMatchObject({ id: 'my:9', name: 'Mine', sections: source.sections })
    copy.sections.chapter.prefix = 'Kapitel '
    expect(source.sections.chapter.prefix).toBe('Chapter ')
  })
})

describe('CompileProjectState', () => {
  it('defaults to Standard Manuscript, the whole manuscript, everything included', () => {
    expect(CompileProjectState.parse(defaultCompileProjectState())).toEqual({
      formatId: 'builtin:standard-manuscript',
      output: null,
      scope: { kind: 'manuscript' },
      excluded: []
    })
  })

  it('ticks and unticks one node without duplicates', () => {
    const state = defaultCompileProjectState()
    const off = setIncluded(setIncluded(state, 'a', false), 'a', false)
    expect(off.excluded).toEqual(['a'])
    expect(setIncluded(off, 'a', true).excluded).toEqual([])
    expect(state.excluded).toEqual([])
  })
})
