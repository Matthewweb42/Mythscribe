import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILTIN_COMPILE_FORMATS } from '@shared/compileFormat'
import { readZip, readZipDirectory } from '../backups/zip'
import { epubFiles, isbnUrn, renderEpub } from './epub'
import { sampleBook, SAMPLE_DETAILS, xmlError } from './testBook'

const MODIFIED = new Date('2026-10-07T10:00:00Z')
const COVER = { data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), extension: 'png' as const }

function files(buffer: Buffer): Map<string, string> {
  return new Map(readZip(buffer).map((e) => [e.name, e.data.toString('utf8')]))
}

/**
 * The structural checks epubcheck would make that matter for KDP, Apple, and Kobo: mimetype first
 * and stored, the container points at the package, every manifest item exists, every spine item
 * is in the manifest, exactly one nav, every XHTML and XML file well-formed, and every internal
 * link resolves to a file and an id.
 */
function validate(buffer: Buffer): void {
  const directory = readZipDirectory(buffer)
  expect(directory[0]?.name).toBe('mimetype')
  expect(directory[0]?.method).toBe(0)
  const all = files(buffer)
  expect(all.get('mimetype')).toBe('application/epub+zip')
  expect(all.get('META-INF/container.xml')).toContain('full-path="OEBPS/content.opf"')
  const opf = all.get('OEBPS/content.opf') ?? ''
  expect(xmlError(opf)).toBeNull()
  const manifest = [...opf.matchAll(/<item id="([^"]+)" href="([^"]+)"/g)].map((m) => ({
    id: m[1] ?? '',
    href: m[2] ?? ''
  }))
  for (const item of manifest) expect(all.has(`OEBPS/${item.href}`), item.href).toBe(true)
  for (const [, idref] of opf.matchAll(/<itemref idref="([^"]+)"/g))
    expect(manifest.some((m) => m.id === idref)).toBe(true)
  expect(opf.match(/properties="nav"/g)).toHaveLength(1)
  for (const [name, text] of all) {
    if (!name.endsWith('.xhtml')) continue
    expect(xmlError(text, 'application/xhtml+xml'), name).toBeNull()
    for (const [, href] of text.matchAll(/href="([^"]+)"/g)) {
      if (href === undefined || href.endsWith('.css') || href === '#toc') continue
      const [file = '', fragment] = href.split('#')
      const target = file === '' ? name : path.posix.join(path.posix.dirname(name), file)
      expect(all.has(target), `${name} → ${href}`).toBe(true)
      if (fragment) expect(all.get(target), `${name} → ${href}`).toContain(`id="${fragment}"`)
    }
  }
}

describe('renderEpub (Compile v2)', () => {
  it('writes a structurally valid EPUB 3 for every built-in format', () => {
    for (const format of BUILTIN_COMPILE_FORMATS) {
      validate(renderEpub(sampleBook(format, 'epub'), { modified: MODIFIED, cover: COVER }))
    }
  })

  it('splits files at generated pages, matter, and chapter-level sections', () => {
    const labels = epubFiles(sampleBook('ebook', 'epub')).map((f) => [f.label, f.epubType])
    expect(labels).toEqual([
      ['The Salt Road', 'titlepage'],
      ['Copyright', 'copyright-page'],
      ['Dedication', 'dedication'],
      ['Epigraph', 'epigraph'],
      ['Contents', 'toc'],
      ['Foreword', null],
      ['Prologue', 'chapter'],
      ['Part One: Beginnings', 'part'],
      ['Chapter One: The Storm', 'chapter'],
      ['Chapter Two: The Calm', 'chapter'],
      ['Afterword', null],
      ['About the Author', 'appendix'],
      ['Also By', 'appendix']
    ])
  })

  it('carries the Book details as package metadata, with the ebook ISBN and the cover', () => {
    const all = files(renderEpub(sampleBook('ebook', 'epub'), { modified: MODIFIED, cover: COVER }))
    const opf = all.get('OEBPS/content.opf') ?? ''
    expect(opf).toContain('<dc:identifier id="book-id">urn:isbn:9780000000019</dc:identifier>')
    expect(opf).toContain('<dc:title id="title">The Salt Road</dc:title>')
    expect(opf).toContain('<dc:title id="subtitle">A Novel</dc:title>')
    expect(opf).toContain('<dc:creator id="creator">Ada Marlowe</dc:creator>')
    expect(opf).toContain('<dc:language>en-GB</dc:language>')
    expect(opf).toContain('<dc:publisher>Gull Press</dc:publisher>')
    expect(opf).toContain('<dc:description>A road of salt.</dc:description>')
    expect(opf).toContain('<dc:subject>salt</dc:subject>')
    expect(opf).toContain('<meta refines="#series" property="group-position">2</meta>')
    expect(opf).toContain('properties="cover-image"')
    expect(opf).toContain('<meta property="dcterms:modified">2026-10-07T10:00:00Z</meta>')
    expect(all.get('OEBPS/cover.xhtml')).toContain('src="images/cover.png"')
  })

  it('nests chapters under their part in the navigation and lists landmarks', () => {
    const nav =
      files(renderEpub(sampleBook('ebook', 'epub'), { modified: MODIFIED })).get(
        'OEBPS/nav.xhtml'
      ) ?? ''
    expect(nav).toMatch(
      /Prologue<\/a><\/li>\n<li><a [^>]+>Part One: Beginnings<\/a><ol><li><a [^>]+>Chapter One: The Storm<\/a><\/li><li>/
    )
    expect(nav).toContain('epub:type="landmarks"')
    expect(nav).toContain('epub:type="bodymatter"')
    expect(nav).not.toContain('epub:type="cover"')
  })

  it('escapes the author text and uses em sizes so the reader sets the body size', () => {
    const all = files(renderEpub(sampleBook('ebook', 'epub'), { modified: MODIFIED }))
    const css = all.get('OEBPS/style.css') ?? ''
    expect(css).not.toMatch(/body \{[^}]*font-size/)
    expect(css).toContain(".sec-chapter { font-family: 'EB Garamond'")
    expect(css).toMatch(/\.sec-chapter \{[^}]*font-size: 1\.5em/)
    const dedication = [...all.values()].find((t) => t.includes('epub:type="dedication"')) ?? ''
    expect(dedication).toContain('For R. &amp; the &lt;sea&gt;')
  })

  it('makes an ISBN URN only from 10 or 13 digits', () => {
    expect(isbnUrn('978-0-00-000000-2')).toBe('urn:isbn:9780000000002')
    expect(isbnUrn('0-306-40615-x')).toBe('urn:isbn:030640615X')
    expect(isbnUrn('12345')).toBeNull()
    const noIsbn = renderEpub(sampleBook('ebook', 'epub', { ...SAMPLE_DETAILS, isbns: [] }), {
      identifier: 'urn:uuid:fixed',
      modified: MODIFIED
    })
    expect(files(noIsbn).get('OEBPS/content.opf')).toContain('>urn:uuid:fixed</dc:identifier>')
  })
})
