import { randomUUID } from 'node:crypto'
import type { ImageExtension } from '@shared/assets'
import {
  bookCss,
  GENERATED_EPUB_TYPE,
  htmlId,
  itemHtml,
  type HtmlContext
} from '@shared/compileHtml'
import type { BookItem, CompiledBook, GeneratedPage, TocEntry } from '@shared/compileModel'
import { escapeXml } from '@shared/xmlEscape'
import { zipBuffer, type ZipEntryInput } from '../backups/zip'
import { w3cdtf } from './docx'

/**
 * The EPUB 3 writer (Compile v2, CV2), zipped with the backup zip writer; `mimetype` first and
 * stored, as the format demands. The book splits into one XHTML file per generated page, per
 * front or end matter item, and per part, chapter, chapter-level section, or section that starts
 * a page (readers page by file, and a novel in one file is slow to open). The navigation document
 * lists every part and chapter-level heading (chapters nested under their part), or every file
 * when the book has no headings, plus landmarks. The package metadata carries Book details: the
 * ISBN as the identifier (else a UUID), title and subtitle, author, language, publisher, rights,
 * description, keywords, series, and the cover image when the format includes it.
 * Fonts are named with fallbacks, not embedded: reading systems let the reader choose (decided by
 * Claude, unconfirmed).
 */

export interface EpubFile {
  /** `sNNN.xhtml` under `OEBPS/text/`. */
  name: string
  label: string
  epubType: string | null
  items: BookItem[]
}

const GENERATED_LABEL: Record<GeneratedPage['kind'], string> = {
  titlePage: 'Title Page',
  manuscriptTitle: 'Title Page',
  copyright: 'Copyright',
  dedication: 'Dedication',
  epigraph: 'Epigraph',
  toc: 'Contents',
  aboutAuthor: 'About the Author',
  alsoBy: 'Also By'
}

function startsFile(item: BookItem, previous: BookItem | undefined): boolean {
  if (previous === undefined) return true
  switch (item.kind) {
    case 'page':
    case 'matter':
      return true
    case 'section':
      return item.level !== 'scene' || item.break !== 'none'
    default:
      // The body's first item after the front pages.
      return item.division !== previous.division && previous.division === 'front'
  }
}

function fileLabel(item: BookItem, fallback: string): { label: string; epubType: string | null } {
  switch (item.kind) {
    case 'page':
      return {
        label: item.page.kind === 'titlePage' ? item.page.title : GENERATED_LABEL[item.page.kind],
        epubType: GENERATED_EPUB_TYPE[item.page.kind]
      }
    case 'matter':
      return { label: item.title, epubType: null }
    case 'section':
      return {
        label: item.heading?.plain ?? (item.runningHead || fallback),
        epubType: item.level === 'part' ? 'part' : 'chapter'
      }
    default:
      return { label: fallback, epubType: null }
  }
}

/** The book's items split into files, in reading order. */
export function epubFiles(book: CompiledBook): EpubFile[] {
  const files: Omit<EpubFile, 'name'>[] = []
  let previous: BookItem | undefined
  for (const item of book.items) {
    const current = files[files.length - 1]
    if (current === undefined || startsFile(item, previous)) {
      files.push({ ...fileLabel(item, book.metadata.title), items: [item] })
    } else {
      current.items.push(item)
    }
    previous = item
  }
  return files.map((file, index) => ({
    ...file,
    name: `s${String(index + 1).padStart(3, '0')}.xhtml`
  }))
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>'

function xhtmlPage(
  title: string,
  body: string,
  lang: string,
  stylesheet: string,
  bodyType = ''
): string {
  return [
    XML_DECL,
    '<!DOCTYPE html>',
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}" xml:lang="${lang}">`,
    '<head>',
    '<meta charset="UTF-8"/>',
    `<title>${escapeXml(title)}</title>`,
    `<link rel="stylesheet" type="text/css" href="${stylesheet}"/>`,
    '</head>',
    `<body${bodyType ? ` epub:type="${bodyType}"` : ''}>`,
    body,
    '</body>',
    '</html>',
    ''
  ].join('\n')
}

function navXhtml(
  book: CompiledBook,
  files: readonly EpubFile[],
  hrefOf: (id: string) => string,
  lang: string,
  cover: boolean
): string {
  const link = (href: string, label: string): string =>
    `<a href="${escapeXml(href)}">${escapeXml(label.trim() || 'Untitled')}</a>`
  const items: string[] = []
  if (book.toc.length > 0) {
    let open: TocEntry | null = null
    const children: string[] = []
    const close = (): void => {
      if (open === null) return
      const nested = children.length > 0 ? `<ol>${children.join('')}</ol>` : ''
      items.push(`<li>${link(hrefOf(open.id), open.label)}${nested}</li>`)
      open = null
      children.length = 0
    }
    for (const entry of book.toc) {
      if (entry.level !== 'part' && entry.inPart && open !== null) {
        children.push(`<li>${link(hrefOf(entry.id), entry.label)}</li>`)
        continue
      }
      close()
      if (entry.level === 'part') open = entry
      else items.push(`<li>${link(hrefOf(entry.id), entry.label)}</li>`)
    }
    close()
  } else {
    for (const file of files) items.push(`<li>${link(`text/${file.name}`, file.label)}</li>`)
  }
  const tocFile = files.find((f) => f.items[0]?.kind === 'page' && f.items[0].page.kind === 'toc')
  const bodyFile = files.find((f) => f.items[0]?.division === 'body')
  const landmarks = [
    cover ? '<li><a epub:type="cover" href="cover.xhtml">Cover</a></li>' : '',
    `<li><a epub:type="toc" href="${tocFile ? `text/${tocFile.name}` : '#toc'}">Contents</a></li>`,
    bodyFile
      ? `<li><a epub:type="bodymatter" href="text/${bodyFile.name}">Start of book</a></li>`
      : ''
  ].filter(Boolean)
  const body = [
    '<nav epub:type="toc" id="toc">',
    '<h1>Contents</h1>',
    `<ol>${items.join('\n')}</ol>`,
    '</nav>',
    '<nav epub:type="landmarks" id="landmarks" hidden="hidden">',
    '<h2>Landmarks</h2>',
    `<ol>${landmarks.join('')}</ol>`,
    '</nav>'
  ].join('\n')
  return xhtmlPage(book.metadata.title, body, lang, 'style.css')
}

const MEDIA_TYPES: Record<ImageExtension, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}

export interface EpubCover {
  data: Buffer
  extension: ImageExtension
}

/** `urn:isbn:` and the ISBN's digits (and X) when it has 10 or 13 of them, else null. */
export function isbnUrn(isbn: string): string | null {
  const digits = isbn.replace(/[^0-9Xx]/g, '').toUpperCase()
  return digits.length === 10 || digits.length === 13 ? `urn:isbn:${digits}` : null
}

function contentOpf(
  book: CompiledBook,
  files: readonly EpubFile[],
  identifier: string,
  modified: Date,
  cover: EpubCover | null
): string {
  const m = book.metadata
  const lang = escapeXml(m.language || 'en')
  const meta: string[] = [
    `<dc:identifier id="book-id">${escapeXml(identifier)}</dc:identifier>`,
    `<dc:title id="title">${escapeXml(m.title)}</dc:title>`,
    '<meta refines="#title" property="title-type">main</meta>'
  ]
  if (m.subtitle)
    meta.push(
      `<dc:title id="subtitle">${escapeXml(m.subtitle)}</dc:title>`,
      '<meta refines="#subtitle" property="title-type">subtitle</meta>'
    )
  if (m.author)
    meta.push(
      `<dc:creator id="creator">${escapeXml(m.author)}</dc:creator>`,
      '<meta refines="#creator" property="role" scheme="marc:relators">aut</meta>'
    )
  meta.push(`<dc:language>${lang}</dc:language>`)
  if (m.publisher) meta.push(`<dc:publisher>${escapeXml(m.publisher)}</dc:publisher>`)
  if (/^\d{4}$/.test(m.copyrightYear)) meta.push(`<dc:date>${m.copyrightYear}</dc:date>`)
  const rights = [
    m.copyrightYear || m.author
      ? `Copyright © ${[m.copyrightYear, m.author].filter(Boolean).join(' ')}`
      : '',
    m.rights
  ]
    .filter(Boolean)
    .join('. ')
  if (rights) meta.push(`<dc:rights>${escapeXml(rights)}</dc:rights>`)
  if (m.description) meta.push(`<dc:description>${escapeXml(m.description)}</dc:description>`)
  for (const keyword of m.keywords) meta.push(`<dc:subject>${escapeXml(keyword)}</dc:subject>`)
  if (m.series) {
    meta.push(
      `<meta property="belongs-to-collection" id="series">${escapeXml(m.series)}</meta>`,
      '<meta refines="#series" property="collection-type">series</meta>'
    )
    if (/^\d+(\.\d+)?$/.test(m.seriesNumber))
      meta.push(`<meta refines="#series" property="group-position">${m.seriesNumber}</meta>`)
  }
  meta.push(`<meta property="dcterms:modified">${w3cdtf(modified)}</meta>`)
  if (cover !== null) meta.push('<meta name="cover" content="cover-image"/>')

  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="css" href="style.css" media-type="text/css"/>'
  ]
  const spine: string[] = []
  if (cover !== null) {
    manifest.push(
      `<item id="cover-image" href="images/cover.${cover.extension}" media-type="${MEDIA_TYPES[cover.extension]}" properties="cover-image"/>`,
      '<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>'
    )
    spine.push('<itemref idref="cover"/>')
  }
  files.forEach((file, index) => {
    manifest.push(
      `<item id="s${index + 1}" href="text/${file.name}" media-type="application/xhtml+xml"/>`
    )
    spine.push(`<itemref idref="s${index + 1}"/>`)
  })
  return [
    XML_DECL,
    `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${lang}">`,
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
    ...meta,
    '</metadata>',
    '<manifest>',
    ...manifest,
    '</manifest>',
    '<spine>',
    ...spine,
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
  /** The cover image (when the format includes it and the file is readable). */
  cover?: EpubCover | null
  /** The ISBN URN when the book has one, else `urn:uuid:` and a fresh UUID unless given. */
  identifier?: string
  modified?: Date
}

/** The compiled book as an EPUB 3 package. */
export function renderEpub(book: CompiledBook, options: EpubOptions = {}): Buffer {
  const modified = options.modified ?? new Date()
  const identifier = isbnUrn(book.metadata.isbn) ?? options.identifier ?? `urn:uuid:${randomUUID()}`
  const cover = options.cover ?? null
  const lang = escapeXml(book.metadata.language || 'en')
  const files = epubFiles(book)
  const fileOf = new Map<string, string>()
  for (const file of files)
    for (const item of file.items) if (item.kind === 'section') fileOf.set(item.id, file.name)
  const hrefFromText = (id: string): string => `${fileOf.get(id) ?? ''}#${htmlId('s', id)}`
  const ctx: HtmlContext = { flavour: 'epub', href: hrefFromText }
  const text = (name: string, value: string, store = false): ZipEntryInput => ({
    name,
    data: Buffer.from(value, 'utf8'),
    store
  })
  const entries: ZipEntryInput[] = [
    text('mimetype', 'application/epub+zip', true),
    text('META-INF/container.xml', CONTAINER),
    text('OEBPS/content.opf', contentOpf(book, files, identifier, modified, cover)),
    text(
      'OEBPS/nav.xhtml',
      navXhtml(book, files, (id) => `text/${hrefFromText(id)}`, lang, cover !== null)
    ),
    text('OEBPS/style.css', `${bookCss(book, 'epub')}\n`)
  ]
  if (cover !== null) {
    entries.push(
      { name: `OEBPS/images/cover.${cover.extension}`, data: cover.data, store: true },
      text(
        'OEBPS/cover.xhtml',
        xhtmlPage(
          book.metadata.title,
          `<section class="cover" epub:type="cover"><img src="images/cover.${cover.extension}" alt="${escapeXml(book.metadata.title)}"/></section>`,
          lang,
          'style.css'
        )
      )
    )
  }
  for (const file of files) {
    const body = file.items.map((item) => itemHtml(item, ctx)).join('\n')
    entries.push(
      text(
        `OEBPS/text/${file.name}`,
        xhtmlPage(file.label, body, lang, '../style.css', file.epubType ?? '')
      )
    )
  }
  return zipBuffer(entries, modified)
}
