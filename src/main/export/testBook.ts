import { JSDOM } from 'jsdom'
import { BookDetails, type BookDetailsInput } from '@shared/bookDetails'
import {
  BUILTIN_COMPILE_FORMATS,
  type CompileFormat,
  type CompileOutput
} from '@shared/compileFormat'
import { compileBook, type CompiledBook, type CompileNode } from '@shared/compileModel'
import type { TiptapNodeT } from '@shared/tiptap'

/**
 * Test fixtures for the compile writers (CV2): a small novel through the real compile model
 * (prologue, a part with two chapters, scene breaks, marks, front and end matter, notes,
 * synopses) with full Book details, and an XML well-formedness check. Used by tests only.
 */

const text = (value: string, marks: string[] = []): TiptapNodeT => ({
  type: 'text',
  text: value,
  ...(marks.length > 0 ? { marks: marks.map((type) => ({ type })) } : {})
})
const para = (...content: TiptapNodeT[]): TiptapNodeT => ({ type: 'paragraph', content })
const doc = (...content: TiptapNodeT[]): TiptapNodeT => ({ type: 'doc', content })

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

export const SAMPLE_DETAILS: BookDetailsInput = {
  title: 'The Salt Road',
  subtitle: 'A Novel',
  series: 'Tides',
  seriesNumber: '2',
  author: 'Ada Marlowe',
  legalName: 'Ada M. Marlowe',
  contact: '12 Harbour Lane\nada@example.com',
  isbns: [
    { edition: 'Paperback', isbn: '978-0-00-000000-2' },
    { edition: 'Ebook', isbn: '978-0-00-000001-9' }
  ],
  publisher: 'Gull Press',
  copyrightYear: '2026',
  rights: 'All rights reserved.',
  dedication: 'For R. & the <sea>',
  epigraph: 'The sea remembers.',
  epigraphSource: 'Old saying',
  aboutAuthor: 'Ada lives by the sea.',
  alsoBy: ['The Long Shore'],
  language: 'en-GB',
  description: 'A road of salt.',
  keywords: ['sea', 'salt']
}

/** Front: a Foreword; manuscript: Prologue, Part One › The Storm (two scenes), The Calm; end: Afterword. */
export function sampleSource(): {
  front: CompileNode[]
  manuscript: CompileNode[]
  end: CompileNode[]
} {
  return {
    front: [node({ id: 'fw', title: 'Foreword', content: doc(para(text('A word first.'))) })],
    manuscript: [
      node({
        id: 'pro',
        title: 'Prologue',
        content: doc(para(text('“Before it all,” she said & left.')))
      }),
      node({ id: 'p1', kind: 'folder', level: 'part', title: 'Beginnings' }),
      node({
        id: 'ca',
        kind: 'folder',
        level: 'chapter',
        depth: 1,
        title: 'The Storm',
        synopsis: 'Rain comes.',
        notes: doc(para(text('Check the tide tables.')))
      }),
      node({
        id: 's1',
        depth: 2,
        title: 'S1',
        content: doc(
          para(text('Rain fell hard on the salt road that evening, and nobody came.')),
          para(
            text('Bold', ['bold']),
            text(' and '),
            text('italic', ['italic']),
            text(' -- then...')
          ),
          { type: 'sceneBreak' },
          para(text('After the break.'))
        ),
        notes: doc(para(text('Scene note.')))
      }),
      node({ id: 's2', depth: 2, title: 'S2', content: doc(para(text('Then it stopped.'))) }),
      node({ id: 'cb', kind: 'folder', level: 'chapter', depth: 1, title: 'The Calm' }),
      node({
        id: 's3',
        depth: 2,
        title: 'S3',
        content: doc(
          { type: 'heading', attrs: { level: 1 }, content: [text('Morning')] },
          para(text('Quiet now.')),
          { type: 'blockquote', content: [para(text('A quoted line.'))] }
        )
      })
    ],
    end: [node({ id: 'aw', title: 'Afterword', content: doc(para(text('Thanks.'))) })]
  }
}

export function builtinFormat(id: string): CompileFormat {
  const format = BUILTIN_COMPILE_FORMATS.find((f) => f.id === `builtin:${id}`)
  if (format === undefined) throw new Error(`no built-in ${id}`)
  return structuredClone(format)
}

/** The sample novel compiled with a built-in (or given) format for one output. */
export function sampleBook(
  format: CompileFormat | string,
  output: CompileOutput,
  details: BookDetailsInput = SAMPLE_DETAILS
): CompiledBook {
  return compileBook({
    source: sampleSource(),
    format: typeof format === 'string' ? builtinFormat(format) : format,
    output,
    details: BookDetails.parse(details),
    projectName: 'Salt',
    scope: { kind: 'manuscript' },
    excluded: []
  })
}

/** The parser's error for an XML (or XHTML) document, or null when it is well-formed. */
export function xmlError(
  xml: string,
  type: 'application/xml' | 'application/xhtml+xml' = 'application/xml'
): string | null {
  const { window } = new JSDOM('')
  const parsed = new window.DOMParser().parseFromString(xml, type)
  const error = parsed.getElementsByTagName('parsererror')[0]
  return error === undefined ? null : (error.textContent ?? 'parse error')
}
