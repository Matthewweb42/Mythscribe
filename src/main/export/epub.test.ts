import { describe, expect, it } from 'vitest'
import { defaultExportFormatting } from '@shared/bookExport'
import { readZip, readZipDirectory } from '../backups/zip'
import { epubFiles, renderEpub } from './epub'
import type { BookUnit, Run } from './model'

const run = (text: string): Run => ({
  kind: 'text',
  text,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  code: false
})
const p = (text: string): BookUnit['blocks'][number] => ({
  kind: 'paragraph',
  runs: [run(text)],
  align: null
})

const units: BookUnit[] = [
  { kind: 'matter', title: 'Dedication', blocks: [p('For M.')] },
  {
    kind: 'body',
    title: 'Book',
    blocks: [
      p('Prologue text'),
      { kind: 'title', level: 'part', text: 'Part One' },
      { kind: 'title', level: 'chapter', text: 'Chapter One' },
      p('First'),
      { kind: 'title', level: 'chapter', text: 'Chapter Two' },
      { kind: 'sceneBreak' },
      { kind: 'title', level: 'part', text: 'Part Two' }
    ]
  },
  { kind: 'matter', title: 'Afterword', blocks: [p('Thanks & more')] }
]

describe('epubFiles (F-12.1)', () => {
  it('gives every matter unit and every title a file, and text before the first title one too', () => {
    expect(epubFiles(units).map((f) => [f.name, f.label, f.role, f.blocks.length])).toEqual([
      ['s001.xhtml', 'Dedication', 'other', 1],
      ['s002.xhtml', 'Book', 'other', 1],
      ['s003.xhtml', 'Part One', 'part', 1],
      ['s004.xhtml', 'Chapter One', 'chapter', 2],
      ['s005.xhtml', 'Chapter Two', 'chapter', 2],
      ['s006.xhtml', 'Part Two', 'part', 1],
      ['s007.xhtml', 'Afterword', 'other', 1]
    ])
  })
})

describe('renderEpub (F-12.1)', () => {
  const buffer = renderEpub(units, defaultExportFormatting('* * *'), 'My & Book', {
    identifier: 'urn:uuid:test',
    modified: new Date('2026-10-05T10:00:00.123Z')
  })
  const files = new Map(readZip(buffer).map((e) => [e.name, e.data.toString('utf8')]))

  it('puts mimetype first and stored', () => {
    const [first] = readZipDirectory(buffer)
    expect(first?.name).toBe('mimetype')
    expect(first?.method).toBe(0)
    expect(files.get('mimetype')).toBe('application/epub+zip')
    // The bytes right after the first local header spell the mimetype, as readers check.
    expect(buffer.toString('latin1', 30, 38)).toBe('mimetype')
    expect(buffer.toString('latin1', 38, 58)).toBe('application/epub+zip')
    expect(files.get('META-INF/container.xml')).toContain('full-path="OEBPS/content.opf"')
  })

  it('lists every file in the manifest and spine, in order', () => {
    const opf = files.get('OEBPS/content.opf') ?? ''
    expect(opf).toContain('<dc:identifier id="book-id">urn:uuid:test</dc:identifier>')
    expect(opf).toContain('<dc:title>My &amp; Book</dc:title>')
    expect(opf).toContain('<meta property="dcterms:modified">2026-10-05T10:00:00Z</meta>')
    const hrefs = [...opf.matchAll(/href="(text\/s\d+\.xhtml)"/g)].map((m) => m[1])
    expect(hrefs).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => `text/s00${n}.xhtml`))
    const spine = [...opf.matchAll(/<itemref idref="(s\d+)"\/>/g)].map((m) => m[1])
    expect(spine).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7'])
    for (const href of hrefs) expect(files.has(`OEBPS/${href}`)).toBe(true)
    expect(opf).toContain('properties="nav"')
  })

  it('nests chapters under their part in the contents', () => {
    const nav = files.get('OEBPS/nav.xhtml') ?? ''
    expect(nav).toContain('<nav epub:type="toc" id="toc">')
    expect(nav).toContain(
      '<li><a href="text/s003.xhtml">Part One</a><ol><li><a href="text/s004.xhtml">Chapter One</a></li><li><a href="text/s005.xhtml">Chapter Two</a></li></ol></li>'
    )
    expect(nav).toContain(
      '<li><a href="text/s006.xhtml">Part Two</a></li>\n<li><a href="text/s007.xhtml">Afterword</a></li>'
    )
  })

  it('writes each file as XHTML with the shared style', () => {
    const chapter = files.get('OEBPS/text/s005.xhtml') ?? ''
    expect(chapter.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(chapter).toContain('<link rel="stylesheet" type="text/css" href="../style.css"/>')
    expect(chapter).toContain(
      '<h2 class="chapter">Chapter Two</h2>\n<div class="scene-break">* * *</div>'
    )
    expect(files.get('OEBPS/text/s007.xhtml')).toContain('<p>Thanks &amp; more</p>')
    expect(files.get('OEBPS/style.css')).not.toContain('@page')
  })
})
