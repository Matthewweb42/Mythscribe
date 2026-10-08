import { fontStack, CODE_FONT } from './bookFonts'
import { pageDimensions, type FurnitureSlots } from './compileFormat'
import {
  furnitureSegments,
  furnitureValues,
  type BookItem,
  type BookMetadata,
  type CompiledBook,
  type ContentBlock,
  type GeneratedPage,
  type Inline,
  type SectionHeading
} from './compileModel'
import { hasSides, pageRuns, type PageRun } from './compilePages'
import { escapeXml } from './xmlEscape'

/**
 * The compiled book as HTML (Compile v2, CV2): one writer for the print PDF (CSS Paged Media laid
 * out by Paged.js in a hidden window), the HTML output, the EPUB's XHTML files, and the compile
 * window's live preview, so a book reads the same in each. Pure strings; every piece of the
 * author's text goes through `escapeXml`, so nothing in a scene can become markup or script.
 *
 * Flavours: `print` adds the page (size, mirrored margins, headers and footers as margin boxes,
 * page breaks, recto starts, the page counter, contents page numbers); `web` is one readable
 * column; `epub` is XHTML with sizes in em so the reader's own text size wins.
 */

export type HtmlFlavour = 'print' | 'web' | 'epub'

export interface HtmlContext {
  flavour: HtmlFlavour
  /** The link to a section (contents entries); `#s-<id>` in one document. */
  href: (sectionId: string) => string
}

/** A node id as an HTML id: anything outside `[A-Za-z0-9_-]` becomes `_`. */
export function htmlId(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

function classAttr(names: readonly (string | null | false)[]): string {
  const kept = names.filter((n): n is string => typeof n === 'string' && n.length > 0)
  return kept.length > 0 ? ` class="${kept.join(' ')}"` : ''
}

// ---------------------------------------------------------------------------------------------
// Content

export function inlineHtml(runs: readonly Inline[], xhtml: boolean): string {
  let out = ''
  for (const run of runs) {
    if (run.kind === 'hardBreak') {
      out += xhtml ? '<br/>' : '<br>'
      continue
    }
    let text = escapeXml(run.text)
    if (run.code) text = `<code>${text}</code>`
    if (run.strike) text = `<s>${text}</s>`
    if (run.underline) text = `<u>${text}</u>`
    if (run.italic) text = `<em>${text}</em>`
    if (run.bold) text = `<strong>${text}</strong>`
    if (run.smallCaps) text = `<span class="sc">${text}</span>`
    if (run.ai) text = `<span class="ai">${text}</span>`
    out += text
  }
  return out
}

const OPENING_CLASS = {
  none: null,
  noIndent: 'open-noindent',
  dropCap: 'open-dropcap',
  smallCapsLine: 'open-sc-line'
} as const

function alignClass(align: string | null): string | null {
  return align !== null && align !== 'left' ? `align-${align}` : null
}

function separatorHtml(
  separator: Extract<ContentBlock, { kind: 'separator' }>['separator'],
  ctx: HtmlContext,
  extra: readonly string[] = []
): string {
  const xhtml = ctx.flavour === 'epub'
  switch (separator.kind) {
    case 'text':
      return `<p${classAttr(['sep', 'sep-text', ...extra])}>${escapeXml(separator.text)}</p>`
    case 'blankLine':
      return `<p${classAttr(['sep', 'sep-blank', ...extra])}>&#160;</p>`
    case 'pageBreak':
      return ctx.flavour === 'print'
        ? `<div${classAttr(['sep', 'sep-page', ...extra])}></div>`
        : `<hr${classAttr(['sep', 'sep-page', ...extra])}${xhtml ? '/' : ''}>`
  }
}

export function blocksHtml(blocks: readonly ContentBlock[], ctx: HtmlContext): string {
  const xhtml = ctx.flavour === 'epub'
  return blocks
    .map((block) => {
      switch (block.kind) {
        case 'paragraph':
          return `<p${classAttr([OPENING_CLASS[block.opening], alignClass(block.align)])}>${inlineHtml(block.runs, xhtml)}</p>`
        case 'heading': {
          const tag = `h${block.level + 3}`
          return `<${tag}${classAttr(['doc-heading', alignClass(block.align)])}>${inlineHtml(block.runs, xhtml)}</${tag}>`
        }
        case 'quote':
          return `<blockquote>${blocksHtml(block.blocks, ctx)}</blockquote>`
        case 'separator':
          return separatorHtml(block.separator, ctx)
      }
    })
    .join('\n')
}

const SECTION_TAG = { part: 'h1', chapter: 'h2', chapterScene: 'h2', scene: 'h3' } as const

function headingLines(heading: SectionHeading): string {
  return heading.lines.map((line) => `<span class="sec-line">${escapeXml(line)}</span>`).join('')
}

function paragraphs(lines: readonly string[], cls: string | null = null): string {
  return lines.map((line) => `<p${classAttr([cls])}>${escapeXml(line)}</p>`).join('\n')
}

function generatedHtml(page: GeneratedPage, ctx: HtmlContext): string {
  switch (page.kind) {
    case 'titlePage':
      return [
        `<h1 class="title-main">${escapeXml(page.title)}</h1>`,
        page.subtitle ? `<p class="title-sub">${escapeXml(page.subtitle)}</p>` : '',
        page.series ? `<p class="title-series">${escapeXml(page.series)}</p>` : '',
        page.author ? `<p class="title-author">${escapeXml(page.author)}</p>` : '',
        page.publisher ? `<p class="title-publisher">${escapeXml(page.publisher)}</p>` : ''
      ]
        .filter(Boolean)
        .join('\n')
    case 'manuscriptTitle':
      return [
        '<div class="ms-head">',
        `<div class="ms-contact">${paragraphs(page.contact)}</div>`,
        `<p class="ms-words">${escapeXml(page.wordCount)}</p>`,
        '</div>',
        `<h1 class="ms-title">${escapeXml(page.title)}</h1>`,
        page.byline ? `<p class="ms-byline">${escapeXml(page.byline)}</p>` : ''
      ]
        .filter(Boolean)
        .join('\n')
    case 'copyright':
      return paragraphs(page.lines)
    case 'dedication':
      return paragraphs(page.paragraphs)
    case 'epigraph':
      return [
        paragraphs(page.paragraphs),
        page.source ? `<p class="epigraph-source">— ${escapeXml(page.source)}</p>` : ''
      ]
        .filter(Boolean)
        .join('\n')
    case 'toc':
      return [
        `<h2 class="gen-heading">${escapeXml(page.title)}</h2>`,
        '<ol class="toc-list">',
        ...page.entries.map(
          (entry) =>
            `<li${classAttr([`toc-${entry.level === 'part' ? 'part' : 'chapter'}`, entry.inPart && 'toc-in-part'])}><a href="${escapeXml(ctx.href(entry.id))}">${escapeXml(entry.label)}</a></li>`
        ),
        '</ol>'
      ].join('\n')
    case 'aboutAuthor':
      return [
        `<h2 class="gen-heading">${escapeXml(page.title)}</h2>`,
        paragraphs(page.paragraphs)
      ].join('\n')
    case 'alsoBy':
      return [
        `<h2 class="gen-heading">${escapeXml(page.title)}</h2>`,
        '<ul class="also-by">',
        ...page.titles.map((title) => `<li>${escapeXml(title)}</li>`),
        '</ul>'
      ].join('\n')
  }
}

const GENERATED_CLASS: Record<GeneratedPage['kind'], string> = {
  titlePage: 'gen-title',
  manuscriptTitle: 'gen-ms',
  copyright: 'gen-copyright',
  dedication: 'gen-dedication',
  epigraph: 'gen-epigraph',
  toc: 'gen-toc',
  aboutAuthor: 'gen-about',
  alsoBy: 'gen-alsoby'
}

/** EPUB 3 structural semantics for a generated page. */
export const GENERATED_EPUB_TYPE: Record<GeneratedPage['kind'], string> = {
  titlePage: 'titlepage',
  manuscriptTitle: 'titlepage',
  copyright: 'copyright-page',
  dedication: 'dedication',
  epigraph: 'epigraph',
  toc: 'toc',
  aboutAuthor: 'appendix',
  alsoBy: 'appendix'
}

/**
 * One item as HTML. `classes` are the page-run classes (`brk-page`, `ms-front`, …) the print
 * flavour puts on an item's outer element.
 */
export function itemHtml(
  item: BookItem,
  ctx: HtmlContext,
  classes: readonly string[] = []
): string {
  const epubType = (type: string): string => (ctx.flavour === 'epub' ? ` epub:type="${type}"` : '')
  switch (item.kind) {
    case 'page': {
      const tag = item.page.kind === 'toc' ? 'nav' : 'section'
      return `<${tag}${classAttr(['gen', GENERATED_CLASS[item.page.kind], ...classes])}${epubType(GENERATED_EPUB_TYPE[item.page.kind])}>\n${generatedHtml(item.page, ctx)}\n</${tag}>`
    }
    case 'matter':
      return `<section${classAttr(['matter', ...classes])} id="${htmlId('m', item.id)}">\n${blocksHtml(item.blocks, ctx)}\n</section>`
    case 'section': {
      const running =
        ctx.flavour === 'print' && item.level !== 'scene'
          ? ` data-running-head="${escapeXml(item.runningHead)}"`
          : ''
      const id = htmlId('s', item.id)
      if (item.heading === null)
        return `<div${classAttr(['sec-mark', `sec-${item.level}`, ...classes])} id="${id}"${running}></div>`
      const tag = SECTION_TAG[item.level]
      return `<${tag}${classAttr(['sec', `sec-${item.level}`, ...classes])} id="${id}"${running}>${headingLines(item.heading)}</${tag}>`
    }
    case 'separator':
      return separatorHtml(item.separator, ctx, classes)
    case 'text':
      return `<div${classAttr(['tx', ...classes])} id="${htmlId('t', item.id)}">\n${blocksHtml(item.blocks, ctx)}\n</div>`
    case 'synopsis':
      return `<p${classAttr(['synopsis', ...classes])}>${escapeXml(item.text)}</p>`
    case 'note':
      // Outputs without comments print a comment-mode note in place too.
      return `<aside${classAttr(['note', ...classes])}>\n<p class="note-label">Note</p>\n${blocksHtml(item.blocks, ctx)}\n</aside>`
  }
}

/** The page-run classes of each item: breaks, bare pages, the numbering restart. */
export function runClasses(
  book: CompiledBook,
  runs: readonly PageRun[] = pageRuns(book)
): string[][] {
  const classes = book.items.map((item): string[] =>
    item.division === 'front' ? ['ms-front'] : []
  )
  for (const run of runs) {
    const at = classes[run.start]
    if (at === undefined) continue
    if (run.how === 'newPage') at.push('brk-page')
    if (run.how === 'newRecto') at.push('brk-recto')
    if (run.bareFirst) at.push('ms-opener')
    if (run.restartNumbering) at.push('ms-restart')
  }
  return classes
}

/** The whole book's body: every item in order, page-run classes on the print flavour. */
export function bookBodyHtml(book: CompiledBook, flavour: Exclude<HtmlFlavour, 'epub'>): string {
  const ctx: HtmlContext = { flavour, href: (id) => `#${htmlId('s', id)}` }
  const classes = runClasses(book)
  return book.items.map((item, index) => itemHtml(item, ctx, classes[index] ?? [])).join('\n')
}

// ---------------------------------------------------------------------------------------------
// Style

/** A CSS string literal. */
export function cssString(text: string): string {
  return `"${text.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\n\r\f]/g, ' ')}"`
}

/**
 * A header or footer slot as a CSS `content` value: text and the book's static tokens as
 * strings, `{page}` as the folio (`PAGED_FURNITURE_HANDLER`), `{chapter}` as the running string.
 * Empty: `none`.
 */
export function furnitureContent(template: string, metadata: BookMetadata): string {
  const values = furnitureValues(metadata, '', '')
  const parts = furnitureSegments(template).map((segment) => {
    if (segment.kind === 'text') return cssString(segment.text)
    if (segment.token === 'page') return 'var(--ms-folio)'
    if (segment.token === 'chapter') return 'string(chapter)'
    return cssString(values[segment.token])
  })
  return parts.length > 0 ? parts.join(' ') : 'none'
}

function marginBoxes(slots: FurnitureSlots, where: 'top' | 'bottom', meta: BookMetadata): string {
  return (['left', 'center', 'right'] as const)
    .map((side) => {
      const content = furnitureContent(slots[side], meta)
      return content === 'none' ? '' : `@${where}-${side} { content: ${content}; }`
    })
    .filter(Boolean)
    .join(' ')
}

const pt = (n: number): string => `${Math.round(n * 100) / 100}pt`
const em = (n: number): string => `${Math.round(n * 1000) / 1000}em`
const inch = (n: number): string => `${Math.round(n * 1000) / 1000}in`

function pageCss(book: CompiledBook): string[] {
  const { format, metadata } = book
  const { pageSetup, headersFooters, typography } = format
  const { width, height } = pageDimensions(pageSetup)
  const { top, bottom, inside, outside } = pageSetup.margins
  const binding = inside + pageSetup.gutter
  const sizeRule = `size: ${inch(width)} ${inch(height)};`
  const rules: string[] = []
  const furniture = (side: 'recto' | 'verso'): string =>
    `${marginBoxes(headersFooters[side].header, 'top', metadata)} ${marginBoxes(headersFooters[side].footer, 'bottom', metadata)}`
  if (pageSetup.mirrored) {
    rules.push(
      `@page { ${sizeRule} margin: ${inch(top)} ${inch(outside)} ${inch(bottom)} ${inch(binding)}; }`
    )
    rules.push(`@page :left { margin-left: ${inch(outside)}; margin-right: ${inch(binding)}; }`)
    rules.push(`@page :right { margin-left: ${inch(binding)}; margin-right: ${inch(outside)}; }`)
  } else {
    rules.push(
      `@page { ${sizeRule} margin: ${inch(top)} ${inch(outside)} ${inch(bottom)} ${inch(binding)}; }`
    )
  }
  if (headersFooters.facing) {
    rules.push(`@page :right { ${furniture('recto')} }`, `@page :left { ${furniture('verso')} }`)
  } else {
    rules.push(`@page { ${furniture('recto')} }`)
  }
  const furnitureSize = pageSetup.mirrored ? typography.size * 0.85 : typography.size
  rules.push(
    `.pagedjs_margin-content { font-family: ${fontStack(typography.font)}; font-size: ${pt(furnitureSize)}; }`,
    '.pagedjs_page.ms-bare .pagedjs_margin-content::after, .pagedjs_blank_page .pagedjs_margin-content::after { content: none !important; }',
    '.brk-page { break-before: page; }',
    `.brk-recto { break-before: ${hasSides(format) ? 'right' : 'page'}; }`,
    '.sep-page { break-after: page; }',
    '[data-running-head] { string-set: chapter attr(data-running-head); }',
    '.sec, .sec-mark, .doc-heading { break-after: avoid; }',
    '.gen-toc a { display: flex; }',
    '.gen-toc a::after { content: attr(data-folio); margin-left: auto; padding-left: 1em; }',
    '.gen-title, .gen-dedication { padding-top: 2in; }',
    '.gen-epigraph { padding-top: 1.5in; }',
    '.ms-title { padding-top: 2.5in; }',
    '.gen-toc .gen-heading, .gen-about .gen-heading, .gen-alsoby .gen-heading { padding-top: 1in; }'
  )
  return rules
}

/**
 * The book's style for a flavour. Print and web sizes are points; EPUB sizes are em relative to
 * the body text, and leaves the body size to the reader.
 */
export function bookCss(book: CompiledBook, flavour: HtmlFlavour): string {
  const { format } = book
  const { typography, sections } = format
  const epub = flavour === 'epub'
  const size = (points: number): string => (epub ? em(points / typography.size) : pt(points))
  const lineHeight =
    typography.lineSpacing.mode === 'multiple'
      ? String(typography.lineSpacing.value)
      : epub
        ? String(Math.round((typography.lineSpacing.points / typography.size) * 100) / 100)
        : pt(typography.lineSpacing.points)
  const lines = Math.max(1, typography.widowControl)
  const rules: string[] = [
    `body { font-family: ${fontStack(typography.font)};${epub ? '' : ` font-size: ${pt(typography.size)};`} line-height: ${lineHeight}; color: #000; margin: 0; }`,
    `p { margin: 0 0 ${size(typography.paragraphSpacing)}; text-indent: ${em(typography.indent)}; text-align: ${typography.justify ? 'justify' : 'left'}; hyphens: ${typography.hyphenate ? 'auto' : 'manual'}; -webkit-hyphens: ${typography.hyphenate ? 'auto' : 'manual'}; widows: ${lines}; orphans: ${lines}; }`,
    '.open-noindent, .open-dropcap, .open-sc-line, .align-center, .align-right, .sep, .synopsis, .note p, .gen p, .matter > p:first-child { text-indent: 0; }',
    '.align-center { text-align: center; } .align-right { text-align: right; } .align-justify { text-align: justify; }',
    `.open-dropcap${flavour === 'print' ? ':not([data-split-from])' : ''}::first-letter { float: left; font-size: 3.2em; line-height: 0.8; margin: 0.05em 0.08em 0 0; }`,
    `.open-sc-line${flavour === 'print' ? ':not([data-split-from])' : ''}::first-line { font-variant: small-caps; letter-spacing: 0.03em; }`,
    '.sc { font-variant: small-caps; letter-spacing: 0.03em; }',
    '.ai { background-color: #e8eefc; }',
    '.sec { margin: 0; text-indent: 0; line-height: 1.25; hyphens: manual; }',
    '.sec-line { display: block; }',
    '.sep { text-align: center; margin: 0.75em 0; }',
    '.sep-blank { margin: 0; }',
    '.synopsis { font-style: italic; margin-bottom: 0.5em; }',
    '.note { margin: 0.75em 0; padding-left: 0.75em; border-left: 2px solid #888; font-size: 0.9em; }',
    '.note-label { font-size: 0.8em; font-weight: bold; letter-spacing: 0.08em; text-transform: uppercase; margin: 0; }',
    'blockquote { margin: 0.75em 2em; }',
    '.doc-heading { font-weight: bold; text-indent: 0; margin: 1em 0 0.5em; line-height: 1.25; }',
    'h4.doc-heading { font-size: 1.15em; } h5.doc-heading { font-size: 1.05em; } h6.doc-heading { font-size: 1em; }',
    `code { font-family: ${fontStack(CODE_FONT)}; font-size: 0.95em; }`,
    'a { color: inherit; text-decoration: none; }',
    '.gen { text-align: center; }',
    '.gen p { text-align: center; margin: 0 0 0.5em; }',
    `.gen-heading { font-family: ${fontStack(typography.headingFont)}; font-size: 1.4em; font-weight: normal; text-align: center; margin: 0 0 1.5em; }`,
    `.title-main { font-family: ${fontStack(typography.headingFont)}; font-size: 2.2em; font-weight: normal; margin: 0 0 0.5em; line-height: 1.2; }`,
    '.title-sub { font-size: 1.2em; font-style: italic; } .title-author { font-size: 1.2em; margin-top: 2em; } .title-publisher { margin-top: 4em; font-size: 0.9em; }',
    '.gen-copyright p { text-align: left; font-size: 0.85em; }',
    '.gen-dedication p, .gen-epigraph p { font-style: italic; }',
    '.gen-epigraph .epigraph-source { font-style: normal; text-align: right; }',
    '.gen-toc { text-align: left; } .toc-list { list-style: none; margin: 0; padding: 0; } .toc-list li { margin: 0 0 0.3em; } .toc-in-part { padding-left: 1.5em; } .toc-part { font-variant: small-caps; margin-top: 0.6em; }',
    '.gen-about p { text-align: left; text-indent: 0; }',
    '.also-by { list-style: none; padding: 0; margin: 0; } .also-by li { margin: 0 0 0.4em; font-style: italic; }',
    '.ms-head { display: flex; justify-content: space-between; align-items: flex-start; line-height: 1.2; }',
    '.ms-contact p, .ms-words { text-align: left; margin: 0; }',
    '.ms-title { font-family: inherit; font-size: 1em; font-weight: normal; text-align: center; margin: 0 0 1em; }'
  ]
  for (const level of ['part', 'chapter', 'chapterScene', 'scene'] as const) {
    const layout = sections[level]
    const font = layout.font ?? typography.headingFont
    rules.push(
      `.sec-${level} { font-family: ${fontStack(font)}; font-size: ${size(layout.size)}; font-weight: ${layout.bold ? 'bold' : 'normal'}; font-style: ${layout.italic ? 'italic' : 'normal'}; font-variant: ${layout.case === 'smallCaps' ? 'small-caps' : 'normal'}; text-align: ${layout.align}; padding-top: ${size(layout.spaceBefore)}; margin-bottom: ${size(layout.spaceAfter)}; }`
    )
  }
  if (flavour === 'print') rules.push(...pageCss(book))
  if (flavour === 'web') {
    rules.push(
      'body { max-width: 36em; margin: 3em auto; padding: 0 1.25em; }',
      '.brk-page, .brk-recto { margin-top: 4em; }',
      'hr.sep-page { border: 0; border-top: 1px solid #ccc; margin: 3em 0; }'
    )
  }
  if (epub) {
    rules.push(
      '.brk-page, .brk-recto { page-break-before: always; break-before: page; }',
      'hr.sep-page { border: 0; page-break-after: always; break-after: page; }',
      '.sec, .doc-heading { page-break-after: avoid; break-after: avoid; }',
      '.gen-title, .gen-dedication, .gen-epigraph { margin-top: 20%; }',
      '.ms-head { display: block; }',
      '.cover { text-align: center; margin: 0; padding: 0; } .cover img { max-width: 100%; max-height: 100%; }'
    )
  }
  return rules.join('\n')
}

/** The `<html lang>` value. */
function lang(book: CompiledBook): string {
  return escapeXml(book.metadata.language || 'en')
}

/**
 * The Paged.js handler the print page registers before laying out. Once every page is laid out
 * it walks the pages in order and:
 * - marks `ms-bare` (no headers or footers, see the print style) a page holding front-division
 *   content or the start of an opener under `hideOnOpeners` (`ms-opener`);
 * - numbers the pages into `--ms-folio`, which the margin boxes print: from 1 at the first page,
 *   again from 1 at the body's first page (`ms-restart`). Paged.js's own `counter-reset: page`
 *   does not carry past the page it is set on in this Chromium, so the folio is ours;
 * - writes each contents entry's folio into its link (`data-folio`), printed after the label.
 * Run after the Paged.js polyfill loads.
 */
export const PAGED_FURNITURE_HANDLER = `(function () {
  class MythScribeFurniture extends window.Paged.Handler {
    afterRendered() {
      let folio = 0
      for (const page of document.querySelectorAll('.pagedjs_page')) {
        if (page.querySelector('.ms-front') || page.querySelector('.ms-opener:not([data-split-from])')) {
          page.classList.add('ms-bare')
        }
        folio = page.querySelector('.ms-restart:not([data-split-from])') ? 1 : folio + 1
        page.style.setProperty('--ms-folio', '"' + folio + '"')
        page.setAttribute('data-ms-folio', String(folio))
      }
      for (const link of document.querySelectorAll('.gen-toc a[href^="#"]')) {
        const target = document.getElementById(link.getAttribute('href').slice(1))
        const page = target ? target.closest('.pagedjs_page') : null
        if (page) link.setAttribute('data-folio', page.getAttribute('data-ms-folio'))
      }
    }
  }
  window.Paged.registerHandlers(MythScribeFurniture)
})()`

export interface PrintDocumentOptions {
  /** `@font-face` rules for the format's fonts (`fontFaceCss`), URLs the window can load. */
  fontFaceCss: string
  /** Extra markup for the end of `<head>` (the PDF printer's Paged.js scripts). */
  head?: string
}

/** The print page the PDF is made from (and the preview lays out): one HTML document. */
export function printDocument(book: CompiledBook, options: PrintDocumentOptions): string {
  return [
    '<!doctype html>',
    `<html lang="${lang(book)}">`,
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeXml(book.metadata.title)}</title>`,
    `<style>\n${options.fontFaceCss}\n${bookCss(book, 'print')}\n</style>`,
    options.head ?? '',
    '</head>',
    '<body>',
    bookBodyHtml(book, 'print'),
    '</body>',
    '</html>',
    ''
  ].join('\n')
}

/** The HTML output: one standalone page in a readable column, fonts named with fallbacks. */
export function webDocument(book: CompiledBook): string {
  const { metadata } = book
  const meta = [
    metadata.author ? `<meta name="author" content="${escapeXml(metadata.author)}">` : '',
    metadata.description
      ? `<meta name="description" content="${escapeXml(metadata.description)}">`
      : '',
    metadata.keywords.length > 0
      ? `<meta name="keywords" content="${escapeXml(metadata.keywords.join(', '))}">`
      : ''
  ].filter(Boolean)
  return [
    '<!doctype html>',
    `<html lang="${lang(book)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeXml(metadata.title)}</title>`,
    ...meta,
    `<style>\n${bookCss(book, 'web')}\n</style>`,
    '</head>',
    '<body>',
    bookBodyHtml(book, 'web'),
    '</body>',
    '</html>',
    ''
  ].join('\n')
}
