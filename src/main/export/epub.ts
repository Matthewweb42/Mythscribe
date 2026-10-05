import { randomUUID } from 'node:crypto'
import type { ExportFormatting } from '@shared/bookExport'
import { zipBuffer, type ZipEntryInput } from '../backups/zip'
import { w3cdtf } from './docx'
import { bookCss, unitsHtml } from './html'
import type { BookBlock, BookUnit } from './model'
import { escapeXml } from './xml'

/**
 * The EPUB export (F-12.1): EPUB 3, zipped with the backup zip writer. `mimetype` comes first and
 * stored, as the format demands. Each front or end matter unit is one file, and the body is split
 * at every part and chapter title (content before the first title gets a file of its own). The
 * split happens whether or not `chapterNewPage` is on: readers page by file, and a novel in one
 * file is slow to open. The contents (`nav.xhtml`) lists every file, chapters nested under the
 * part above them.
 */

export interface EpubFile {
  /** `sNNN.xhtml` under `OEBPS/text/`. */
  name: string
  label: string
  /** A part's file holds its chapters' entries in the contents. */
  role: 'part' | 'chapter' | 'other'
  blocks: BookBlock[]
}

/** The units split into files, in reading order. */
export function epubFiles(units: readonly BookUnit[]): EpubFile[] {
  const files: Omit<EpubFile, 'name'>[] = []
  for (const unit of units) {
    if (unit.kind === 'matter') {
      files.push({ label: unit.title, role: 'other', blocks: unit.blocks })
      continue
    }
    let current: Omit<EpubFile, 'name'> | null = null
    for (const block of unit.blocks) {
      if (block.kind === 'title' || current === null) {
        current =
          block.kind === 'title'
            ? { label: block.text, role: block.level, blocks: [] }
            : { label: unit.title, role: 'other', blocks: [] }
        files.push(current)
      }
      current.blocks.push(block)
    }
  }
  return files.map((file, index) => ({
    ...file,
    name: `s${String(index + 1).padStart(3, '0')}.xhtml`
  }))
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>'

function xhtmlPage(title: string, body: string, stylesheet: string): string {
  return [
    XML_DECL,
    '<!DOCTYPE html>',
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">',
    '<head>',
    '<meta charset="UTF-8"/>',
    `<title>${escapeXml(title)}</title>`,
    `<link rel="stylesheet" type="text/css" href="${stylesheet}"/>`,
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
    ''
  ].join('\n')
}

interface NavEntry {
  file: EpubFile
  children: EpubFile[]
}

function navXhtml(files: readonly EpubFile[], title: string): string {
  const link = (file: EpubFile): string =>
    `<a href="text/${file.name}">${escapeXml(file.label.trim() || 'Untitled')}</a>`
  // Top-level entries; a chapter right after a part (or its earlier chapters) nests under it.
  const entries: NavEntry[] = []
  let part: NavEntry | null = null
  for (const file of files) {
    if (file.role === 'chapter' && part !== null) {
      part.children.push(file)
      continue
    }
    const entry: NavEntry = { file, children: [] }
    entries.push(entry)
    part = file.role === 'part' ? entry : null
  }
  const items = entries.map(({ file, children }) =>
    children.length === 0
      ? `<li>${link(file)}</li>`
      : `<li>${link(file)}<ol>${children.map((child) => `<li>${link(child)}</li>`).join('')}</ol></li>`
  )
  const nav = [
    '<nav epub:type="toc" id="toc">',
    '<h1>Contents</h1>',
    '<ol>',
    ...items,
    '</ol>',
    '</nav>'
  ]
  return xhtmlPage(title, nav.join('\n'), 'style.css')
}

function contentOpf(
  files: readonly EpubFile[],
  title: string,
  identifier: string,
  modified: Date
): string {
  return [
    XML_DECL,
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="en">',
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
    `<dc:identifier id="book-id">${escapeXml(identifier)}</dc:identifier>`,
    `<dc:title>${escapeXml(title)}</dc:title>`,
    '<dc:language>en</dc:language>',
    `<meta property="dcterms:modified">${w3cdtf(modified)}</meta>`,
    '</metadata>',
    '<manifest>',
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="css" href="style.css" media-type="text/css"/>',
    ...files.map(
      (file, index) =>
        `<item id="s${index + 1}" href="text/${file.name}" media-type="application/xhtml+xml"/>`
    ),
    '</manifest>',
    '<spine>',
    ...files.map((_, index) => `<itemref idref="s${index + 1}"/>`),
    '</spine>',
    '</package>',
    ''
  ].join('\n')
}

const CONTAINER = [
  XML_DECL,
  '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">',
  '<rootfiles>',
  '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>',
  '</rootfiles>',
  '</container>',
  ''
].join('\n')

export interface EpubOptions {
  /** `urn:uuid:` plus a fresh UUID unless given (tests pin it). */
  identifier?: string
  modified?: Date
}

export function renderEpub(
  units: readonly BookUnit[],
  formatting: ExportFormatting,
  title: string,
  options: EpubOptions = {}
): Buffer {
  const modified = options.modified ?? new Date()
  const identifier = options.identifier ?? `urn:uuid:${randomUUID()}`
  const files = epubFiles(units)
  const text = (name: string, value: string, store = false): ZipEntryInput => ({
    name,
    data: Buffer.from(value, 'utf8'),
    store
  })
  const flavour = {
    xhtml: true,
    sceneBreak: formatting.sceneBreak,
    // Every file starts on a new page in a reader anyway.
    chapterNewPage: false
  }
  return zipBuffer(
    [
      text('mimetype', 'application/epub+zip', true),
      text('META-INF/container.xml', CONTAINER),
      text('OEBPS/content.opf', contentOpf(files, title, identifier, modified)),
      text('OEBPS/nav.xhtml', navXhtml(files, title)),
      text('OEBPS/style.css', `${bookCss(formatting, false)}\n`),
      ...files.map((file) =>
        text(
          `OEBPS/text/${file.name}`,
          xhtmlPage(
            file.label,
            unitsHtml([{ kind: 'body', title: file.label, blocks: file.blocks }], flavour),
            '../style.css'
          )
        )
      )
    ],
    modified
  )
}
