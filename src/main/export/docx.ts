import { CODE_FONT, officeFontName } from '@shared/bookFonts'
import {
  pageDimensions,
  type CompileFormat,
  type FurnitureSlots,
  type SectionLayout,
  type SectionLevel,
  type Separator
} from '@shared/compileFormat'
import {
  furnitureSegments,
  furnitureValues,
  type BookItem,
  type CompiledBook,
  type ContentAlign,
  type ContentBlock,
  type GeneratedPage,
  type Inline
} from '@shared/compileModel'
import { pageRuns, type PageRun } from '@shared/compilePages'
import { escapeXml } from '@shared/xmlEscape'
import { zipBuffer } from '../backups/zip'
import { flatParagraphs, plainRun, smallCapsLead, splitDropCap } from './inlines'

/**
 * The DOCX writer (Compile v2, CV2): a WordprocessingML package written by hand from the
 * compiled book and zipped with the backup zip writer, so no dependency.
 *
 * - Styles carry the format: Normal (font, size, line spacing, first-line indent, justification,
 *   widow control), Body First (the unindented opening), one title style per section level with
 *   its outline level (parts 1, chapters 2, scenes 3) so Word's navigation pane and TOC see them.
 * - Every page run (`pageRuns`) is a Word section: its start (`nextPage`, `oddPage` for a recto),
 *   page size and margins (mirrored and gutter in the settings), headers and footers with a PAGE
 *   field, an empty first-page header on openers (`titlePg`), empty furniture in the front
 *   division, and the page numbering restarted at the body. `{chapter}` is written as the
 *   chapter that opens the section, so each section with its own chapter gets its own header part
 *   (identical parts are shared).
 * - The contents page is a Word TOC field whose cached entries link to bookmarks on the headings
 *   (no page numbers until Word updates the field).
 * - Notes in `comments` mode are Word comments on the first paragraph of their document.
 */

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

const tw = (points: number): number => Math.round(points * 20)
const twIn = (inches: number): number => Math.round(inches * 1440)

const JUSTIFY: Record<ContentAlign | 'left' | 'center' | 'right', string> = {
  left: 'left',
  center: 'center',
  right: 'right',
  justify: 'both'
}

const LEVEL_STYLE: Record<SectionLevel, string> = {
  part: 'PartTitle',
  chapter: 'ChapterTitle',
  chapterScene: 'ChapterSceneTitle',
  scene: 'SceneTitle'
}
const LEVEL_NAME: Record<SectionLevel, string> = {
  part: 'Part Title',
  chapter: 'Chapter Title',
  chapterScene: 'Chapter Scene Title',
  scene: 'Scene Title'
}
const LEVEL_OUTLINE: Record<SectionLevel, number> = {
  part: 0,
  chapter: 1,
  chapterScene: 1,
  scene: 2
}

// ---------------------------------------------------------------------------------------------
// Runs and paragraphs

function fontsXml(name: string): string {
  const font = escapeXml(name)
  return `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/>`
}

/** One run, optionally at its own size (half-points) and lowered by `position` (drop caps). */
export function runXml(run: Inline, sizeHalfPoints: number | null = null, position = 0): string {
  if (run.kind === 'hardBreak') return '<w:r><w:br/></w:r>'
  // CT_RPr order: rFonts, b, i, smallCaps, strike, position, sz, szCs, highlight, u.
  const props = [
    run.code ? fontsXml(officeFontName(CODE_FONT)) : '',
    run.bold ? '<w:b/>' : '',
    run.italic ? '<w:i/>' : '',
    run.smallCaps ? '<w:smallCaps/>' : '',
    run.strike ? '<w:strike/>' : '',
    position !== 0 ? `<w:position w:val="${position}"/>` : '',
    sizeHalfPoints !== null
      ? `<w:sz w:val="${sizeHalfPoints}"/><w:szCs w:val="${sizeHalfPoints}"/>`
      : '',
    run.ai ? '<w:highlight w:val="lightGray"/>' : '',
    run.underline ? '<w:u w:val="single"/>' : ''
  ].join('')
  const rPr = props.length > 0 ? `<w:rPr>${props}</w:rPr>` : ''
  return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(run.text)}</w:t></w:r>`
}

interface Paragraph {
  style: string
  keepNext?: boolean
  framePr?: string
  tabs?: string
  spacing?: string
  ind?: string
  jc?: string
  sectPr?: string
  content: string
  bookmark?: { id: number; name: string }
  comments: number[]
}

function paragraph(style: string, content: string, over: Partial<Paragraph> = {}): Paragraph {
  return { style, content, comments: [], ...over }
}

function paragraphXml(p: Paragraph): string {
  // CT_PPr order: pStyle, keepNext, framePr, tabs, spacing, ind, jc, sectPr.
  const pPr = [
    `<w:pStyle w:val="${p.style}"/>`,
    p.keepNext ? '<w:keepNext/>' : '',
    p.framePr ?? '',
    p.tabs ?? '',
    p.spacing ?? '',
    p.ind ?? '',
    p.jc !== undefined ? `<w:jc w:val="${p.jc}"/>` : '',
    p.sectPr ?? ''
  ].join('')
  let content = p.content
  if (p.bookmark !== undefined) {
    const { id, name } = p.bookmark
    content = `<w:bookmarkStart w:id="${id}" w:name="${name}"/>${content}<w:bookmarkEnd w:id="${id}"/>`
  }
  for (const id of p.comments) {
    content =
      `<w:commentRangeStart w:id="${id}"/>${content}<w:commentRangeEnd w:id="${id}"/>` +
      `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r>`
  }
  return `<w:p><w:pPr>${pPr}</w:pPr>${content}</w:p>`
}

const runs = (inlines: readonly Inline[]): string => inlines.map((r) => runXml(r)).join('')
const text = (value: string): string => runXml(plainRun(value))

// ---------------------------------------------------------------------------------------------
// The body

interface Comment {
  id: number
  paragraphs: Inline[][]
}

class BodyWriter {
  readonly sections: { run: PageRun; paragraphs: Paragraph[] }[] = []
  readonly comments: Comment[] = []
  private readonly pendingComments = new Map<string, Comment>()
  private readonly bookmarks = new Map<string, { id: number; name: string }>()

  constructor(
    private readonly book: CompiledBook,
    private readonly dropCapPoints: number
  ) {
    book.toc.forEach((entry, index) =>
      this.bookmarks.set(entry.id, { id: index + 1, name: `_TocMS${index + 1}` })
    )
    for (const item of book.items) {
      if (item.kind === 'note' && item.mode === 'comments') {
        const comment = { id: this.comments.length, paragraphs: flatParagraphs(item.blocks) }
        this.comments.push(comment)
        this.pendingComments.set(item.id, comment)
      }
    }
  }

  private get current(): Paragraph[] {
    const section = this.sections[this.sections.length - 1]
    if (section === undefined) throw new Error('No section started')
    return section.paragraphs
  }

  private push(p: Paragraph, anchorId: string | null = null): void {
    if (anchorId !== null) {
      const comment = this.pendingComments.get(anchorId)
      if (comment !== undefined) {
        p.comments.push(comment.id)
        this.pendingComments.delete(anchorId)
      }
    }
    this.current.push(p)
  }

  write(): void {
    const runsByStart = new Map(pageRuns(this.book).map((run) => [run.start, run]))
    this.book.items.forEach((item, index) => {
      const run = runsByStart.get(index)
      if (run !== undefined) this.sections.push({ run, paragraphs: [] })
      this.item(item)
    })
    for (const section of this.sections)
      if (section.paragraphs.length === 0) section.paragraphs.push(paragraph('Normal', ''))
  }

  private item(item: BookItem): void {
    switch (item.kind) {
      case 'page':
        this.generated(item.page)
        return
      case 'matter':
        this.blocks(item.blocks, item.id, true)
        return
      case 'section': {
        if (item.heading === null) return
        const content = item.heading.lines
          .map((line, index) => (index > 0 ? '<w:r><w:br/></w:r>' : '') + text(line))
          .join('')
        this.push(
          paragraph(LEVEL_STYLE[item.level], content, { bookmark: this.bookmarks.get(item.id) }),
          item.id
        )
        return
      }
      case 'separator':
        this.separator(item.separator)
        return
      case 'text':
        this.blocks(item.blocks, item.id, false)
        return
      case 'synopsis':
        this.push(paragraph('Synopsis', text(item.text)), item.id)
        return
      case 'note': {
        const pending = this.pendingComments.get(item.id)
        if (item.mode === 'comments') {
          if (pending === undefined) return
          // Nothing of the node printed: the comment goes on the last paragraph so far.
          const last = this.current[this.current.length - 1]
          if (last !== undefined) last.comments.push(pending.id)
          else this.push(paragraph('Normal', ''), item.id)
          this.pendingComments.delete(item.id)
          return
        }
        this.push(paragraph('NoteLabel', text('Note')))
        for (const runsOf of flatParagraphs(item.blocks)) this.push(paragraph('Note', runs(runsOf)))
        return
      }
    }
  }

  private separator(separator: Separator): void {
    switch (separator.kind) {
      case 'text':
        this.push(paragraph('SceneBreak', text(separator.text)))
        return
      case 'blankLine':
        this.push(paragraph('BodyFirst', ''))
        return
      case 'pageBreak':
        this.push(paragraph('BodyFirst', '<w:r><w:br w:type="page"/></w:r>'))
    }
  }

  private blocks(
    blocks: readonly ContentBlock[],
    anchorId: string,
    matter: boolean,
    quote = false
  ): void {
    blocks.forEach((block, index) => {
      const anchor = index === 0 ? anchorId : null
      switch (block.kind) {
        case 'paragraph': {
          const align = block.align !== null ? JUSTIFY[block.align] : undefined
          const unindent =
            block.align === 'center' || block.align === 'right'
              ? '<w:ind w:firstLine="0"/>'
              : undefined
          const base = quote
            ? 'Quote'
            : block.opening === 'none' && !(matter && index === 0)
              ? 'Normal'
              : 'BodyFirst'
          if (block.opening === 'dropCap' && !quote) {
            const split = splitDropCap(block.runs)
            if (split !== null) {
              this.push(this.dropCap(split.cap), anchor)
              this.push(paragraph('BodyFirst', runs(split.rest), { jc: align, ind: unindent }))
              return
            }
          }
          const inlines = block.opening === 'smallCapsLine' ? smallCapsLead(block.runs) : block.runs
          this.push(paragraph(base, runs(inlines), { jc: align, ind: unindent }), anchor)
          return
        }
        case 'heading':
          this.push(
            paragraph(`DocHeading${block.level}`, runs(block.runs), {
              jc: block.align !== null ? JUSTIFY[block.align] : undefined
            }),
            anchor
          )
          return
        case 'quote':
          this.blocks(block.blocks, anchor ?? '', matter, true)
          return
        case 'separator':
          this.separator(block.separator)
      }
    })
  }

  private dropCap(cap: Inline): Paragraph {
    const size = Math.round(this.dropCapPoints * 2)
    return paragraph('BodyFirst', runXml(cap, size), {
      keepNext: true,
      framePr:
        '<w:framePr w:dropCap="drop" w:lines="3" w:wrap="around" w:vAnchor="text" w:hAnchor="text"/>',
      spacing: `<w:spacing w:before="0" w:after="0" w:line="${tw(this.dropCapPoints * 0.9)}" w:lineRule="exact"/>`
    })
  }

  private generated(page: GeneratedPage): void {
    switch (page.kind) {
      case 'titlePage':
        this.push(paragraph('TitleMain', text(page.title)))
        if (page.subtitle) this.push(paragraph('TitleSub', text(page.subtitle)))
        if (page.series) this.push(paragraph('Centered', text(page.series)))
        if (page.author) this.push(paragraph('TitleAuthor', text(page.author)))
        if (page.publisher) this.push(paragraph('TitlePublisher', text(page.publisher)))
        return
      case 'manuscriptTitle': {
        const [firstLine = '', ...rest] = page.contact
        const right = this.textWidth()
        this.push(
          paragraph('MsContact', `${text(firstLine)}<w:r><w:tab/></w:r>${text(page.wordCount)}`, {
            tabs: `<w:tabs><w:tab w:val="right" w:pos="${right}"/></w:tabs>`
          })
        )
        for (const line of rest) this.push(paragraph('MsContact', text(line)))
        this.push(paragraph('MsTitle', text(page.title)))
        if (page.byline) this.push(paragraph('Centered', text(page.byline)))
        return
      }
      case 'copyright':
        for (const line of page.lines) this.push(paragraph('Copyright', text(line)))
        return
      case 'dedication':
        page.paragraphs.forEach((line, index) =>
          this.push(
            paragraph(
              index === 0 ? 'Dedication' : 'Centered',
              runXml(plainRun(line, { italic: true }))
            )
          )
        )
        return
      case 'epigraph':
        page.paragraphs.forEach((line, index) =>
          this.push(paragraph(index === 0 ? 'Epigraph' : 'EpigraphText', text(line)))
        )
        if (page.source) this.push(paragraph('EpigraphSource', text(`— ${page.source}`)))
        return
      case 'toc':
        this.push(paragraph('GenHeading', text(page.title)))
        this.toc(page)
        return
      case 'aboutAuthor':
        this.push(paragraph('GenHeading', text(page.title)))
        for (const line of page.paragraphs) this.push(paragraph('BodyFirst', text(line)))
        return
      case 'alsoBy':
        this.push(paragraph('GenHeading', text(page.title)))
        for (const title of page.titles)
          this.push(paragraph('Centered', runXml(plainRun(title, { italic: true }))))
    }
  }

  private toc(page: Extract<GeneratedPage, { kind: 'toc' }>): void {
    const begin =
      '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-2" \\h \\z \\u </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
    const end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
    if (page.entries.length === 0) {
      this.push(paragraph('TOC1', begin + end))
      return
    }
    page.entries.forEach((entry, index) => {
      const anchor = this.bookmarks.get(entry.id)?.name ?? ''
      const link = `<w:hyperlink w:anchor="${anchor}" w:history="1">${runXml(plainRun(entry.label))}</w:hyperlink>`
      const style = entry.level !== 'part' && entry.inPart ? 'TOC2' : 'TOC1'
      const head = index === 0 ? begin : ''
      const tail = index === page.entries.length - 1 ? end : ''
      this.push(paragraph(style, head + link + tail))
    })
  }

  textWidth(): number {
    const { pageSetup } = this.book.format
    const { width } = pageDimensions(pageSetup)
    const { inside, outside } = pageSetup.margins
    return twIn(width - inside - outside - pageSetup.gutter)
  }
}

// ---------------------------------------------------------------------------------------------
// Headers and footers

interface Part {
  name: string
  rId: string
  kind: 'header' | 'footer'
  xml: string
}

function furnitureXml(
  kind: 'header' | 'footer',
  slots: FurnitureSlots | null,
  book: CompiledBook,
  chapter: string,
  textWidth: number
): string {
  const root = kind === 'header' ? 'w:hdr' : 'w:ftr'
  const style = kind === 'header' ? 'Header' : 'Footer'
  let content = ''
  if (slots !== null && (slots.left || slots.center || slots.right)) {
    const values = furnitureValues(book.metadata, '', chapter)
    const slot = (template: string): string =>
      furnitureSegments(template)
        .map((segment) => {
          if (segment.kind === 'text') return text(segment.text)
          if (segment.token === 'page')
            return '<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>'
          return text(values[segment.token])
        })
        .join('')
    const tab = '<w:r><w:tab/></w:r>'
    content = `${slot(slots.left)}${tab}${slot(slots.center)}${tab}${slot(slots.right)}`
  }
  const tabs = `<w:tabs><w:tab w:val="center" w:pos="${Math.round(textWidth / 2)}"/><w:tab w:val="right" w:pos="${textWidth}"/></w:tabs>`
  return `${XML_DECL}<${root} xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:p><w:pPr><w:pStyle w:val="${style}"/>${tabs}</w:pPr>${content}</w:p></${root}>`
}

class Furniture {
  readonly parts: Part[] = []
  private readonly byXml = new Map<string, Part>()

  constructor(
    private readonly book: CompiledBook,
    private readonly textWidth: number,
    private readonly firstRId: number
  ) {}

  ref(kind: 'header' | 'footer', slots: FurnitureSlots | null, chapter: string): string {
    const xml = furnitureXml(kind, slots, this.book, chapter, this.textWidth)
    let part = this.byXml.get(xml)
    if (part === undefined) {
      const n = this.parts.filter((p) => p.kind === kind).length + 1
      part = { name: `${kind}${n}.xml`, rId: `rId${this.firstRId + this.parts.length}`, kind, xml }
      this.parts.push(part)
      this.byXml.set(xml, part)
    }
    return part.rId
  }
}

function sectPrXml(run: PageRun, format: CompileFormat, furniture: Furniture): string {
  const { pageSetup, headersFooters } = format
  const { width, height } = pageDimensions(pageSetup)
  const { top, bottom, inside, outside } = pageSetup.margins
  const refs: string[] = []
  const bare = run.front
  const recto = bare ? null : headersFooters.recto
  const verso = bare ? null : headersFooters.verso
  for (const kind of ['header', 'footer'] as const) {
    const tag = kind === 'header' ? 'w:headerReference' : 'w:footerReference'
    const slots = (f: typeof recto): FurnitureSlots | null => (f === null ? null : f[kind])
    refs.push(
      `<${tag} w:type="default" r:id="${furniture.ref(kind, slots(recto), run.runningHead)}"/>`
    )
    if (headersFooters.facing)
      refs.push(
        `<${tag} w:type="even" r:id="${furniture.ref(kind, slots(verso), run.runningHead)}"/>`
      )
    if (run.bareFirst && !bare)
      refs.push(`<${tag} w:type="first" r:id="${furniture.ref(kind, null, '')}"/>`)
  }
  // Headers above the text, half the top margin from the edge (at most half an inch).
  const header = Math.min(720, twIn(top / 2))
  const footer = Math.min(720, twIn(bottom / 2))
  return [
    '<w:sectPr>',
    ...refs,
    run.how === 'newRecto' ? '<w:type w:val="oddPage"/>' : '<w:type w:val="nextPage"/>',
    `<w:pgSz w:w="${twIn(width)}" w:h="${twIn(height)}"/>`,
    `<w:pgMar w:top="${twIn(top)}" w:right="${twIn(outside)}" w:bottom="${twIn(bottom)}" w:left="${twIn(inside)}" w:header="${header}" w:footer="${footer}" w:gutter="${twIn(pageSetup.gutter)}"/>`,
    run.restartNumbering ? '<w:pgNumType w:start="1"/>' : '',
    run.bareFirst && !bare ? '<w:titlePg/>' : '',
    '</w:sectPr>'
  ].join('')
}

// ---------------------------------------------------------------------------------------------
// Styles and settings

function spacingXml(before: number, after: number, line: string): string {
  return `<w:spacing w:before="${tw(before)}" w:after="${tw(after)}" ${line}/>`
}

function lineXml(format: CompileFormat): string {
  const spacing = format.typography.lineSpacing
  return spacing.mode === 'multiple'
    ? `w:line="${Math.round(240 * spacing.value)}" w:lineRule="auto"`
    : `w:line="${tw(spacing.points)}" w:lineRule="exact"`
}

function paragraphStyle(
  id: string,
  name: string,
  pPr: string,
  rPr = '',
  next = 'Normal',
  basedOn = 'Normal'
): string {
  return (
    `<w:style w:type="paragraph" w:customStyle="1" w:styleId="${id}"><w:name w:val="${name}"/>` +
    `<w:basedOn w:val="${basedOn}"/><w:next w:val="${next}"/><w:qFormat/>` +
    `<w:pPr>${pPr}</w:pPr>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}</w:style>`
  )
}

function levelStyle(level: SectionLevel, layout: SectionLayout, format: CompileFormat): string {
  const font = officeFontName(layout.font ?? format.typography.headingFont)
  const size = Math.round(layout.size * 2)
  // CT_PPr: keepNext, keepLines, spacing, ind, jc, outlineLvl. CT_RPr: rFonts, b, i, smallCaps, sz.
  const pPr =
    '<w:keepNext/><w:keepLines/>' +
    spacingXml(layout.spaceBefore, layout.spaceAfter, 'w:line="240" w:lineRule="auto"') +
    `<w:ind w:firstLine="0"/><w:jc w:val="${JUSTIFY[layout.align]}"/><w:outlineLvl w:val="${LEVEL_OUTLINE[level]}"/>`
  const rPr =
    fontsXml(font) +
    (layout.bold ? '<w:b/>' : '<w:b w:val="0"/>') +
    (layout.italic ? '<w:i/>' : '') +
    (layout.case === 'smallCaps' ? '<w:smallCaps/>' : '') +
    `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`
  return paragraphStyle(LEVEL_STYLE[level], LEVEL_NAME[level], pPr, rPr, 'BodyFirst')
}

function stylesXml(book: CompiledBook, textWidth: number): string {
  const { format } = book
  const { typography } = format
  const font = officeFontName(typography.font)
  const heading = officeFontName(typography.headingFont)
  const size = Math.round(typography.size * 2)
  const indent = Math.round(typography.indent * typography.size * 20)
  const line = lineXml(format)
  const single = 'w:line="240" w:lineRule="auto"'
  const center = '<w:ind w:firstLine="0"/><w:jc w:val="center"/>'
  const lang = escapeXml(book.metadata.language || 'en')
  const half = (factor: number): string => {
    const value = Math.round(size * factor)
    return `<w:sz w:val="${value}"/><w:szCs w:val="${value}"/>`
  }
  return (
    `${XML_DECL}<w:styles xmlns:w="${W_NS}">` +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    fontsXml(font) +
    `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:lang w:val="${lang}"/>` +
    '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>' +
    spacingXml(0, typography.paragraphSpacing, line) +
    '</w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>' +
    `<w:pPr>${typography.widowControl > 0 ? '<w:widowControl/>' : '<w:widowControl w:val="0"/>'}` +
    `<w:ind w:firstLine="${indent}"/>${typography.justify ? '<w:jc w:val="both"/>' : ''}</w:pPr></w:style>` +
    paragraphStyle('BodyFirst', 'Body First', '<w:ind w:firstLine="0"/>') +
    (['part', 'chapter', 'chapterScene', 'scene'] as const)
      .map((level) => levelStyle(level, format.sections[level], format))
      .join('') +
    paragraphStyle(
      'DocHeading1',
      'Text Heading 1',
      `<w:keepNext/>${spacingXml(12, 6, single)}<w:ind w:firstLine="0"/>`,
      `<w:b/>${half(1.15)}`,
      'BodyFirst'
    ) +
    paragraphStyle(
      'DocHeading2',
      'Text Heading 2',
      `<w:keepNext/>${spacingXml(12, 6, single)}<w:ind w:firstLine="0"/>`,
      `<w:b/>${half(1.05)}`,
      'BodyFirst'
    ) +
    paragraphStyle(
      'DocHeading3',
      'Text Heading 3',
      `<w:keepNext/>${spacingXml(12, 6, single)}<w:ind w:firstLine="0"/>`,
      '<w:b/>',
      'BodyFirst'
    ) +
    paragraphStyle(
      'SceneBreak',
      'Scene Break',
      `<w:keepNext/>${spacingXml(6, 6, line)}${center}`,
      '',
      'BodyFirst'
    ) +
    paragraphStyle('Quote', 'Quote', '<w:ind w:left="720" w:right="720" w:firstLine="0"/>') +
    paragraphStyle(
      'Synopsis',
      'Synopsis',
      `${spacingXml(0, 6, line)}<w:ind w:firstLine="0"/>`,
      '<w:i/>'
    ) +
    paragraphStyle(
      'NoteLabel',
      'Note Label',
      `<w:keepNext/>${spacingXml(6, 0, single)}<w:ind w:left="360" w:firstLine="0"/>`,
      `<w:b/><w:caps/>${half(0.75)}`,
      'Note'
    ) +
    paragraphStyle(
      'Note',
      'Note',
      `${spacingXml(0, 6, single)}<w:ind w:left="360" w:firstLine="0"/>`,
      half(0.9),
      'Note'
    ) +
    paragraphStyle('Centered', 'Centered', center) +
    paragraphStyle(
      'TitleMain',
      'Book Title',
      `${spacingXml(144, 12, single)}${center}`,
      `${fontsXml(heading)}${half(2.2)}`
    ) +
    paragraphStyle(
      'TitleSub',
      'Book Subtitle',
      `${spacingXml(0, 12, single)}${center}`,
      `<w:i/>${half(1.2)}`
    ) +
    paragraphStyle(
      'TitleAuthor',
      'Book Author',
      `${spacingXml(36, 0, single)}${center}`,
      half(1.2)
    ) +
    paragraphStyle(
      'TitlePublisher',
      'Book Publisher',
      `${spacingXml(144, 0, single)}${center}`,
      half(0.9)
    ) +
    paragraphStyle(
      'Copyright',
      'Copyright',
      `${spacingXml(0, 6, single)}<w:ind w:firstLine="0"/>`,
      half(0.85)
    ) +
    paragraphStyle('Dedication', 'Dedication', `${spacingXml(144, 0, line)}${center}`) +
    paragraphStyle(
      'Epigraph',
      'Epigraph',
      `${spacingXml(108, 0, line)}<w:ind w:left="720" w:right="720" w:firstLine="0"/>`,
      '<w:i/>',
      'EpigraphText'
    ) +
    paragraphStyle(
      'EpigraphText',
      'Epigraph Text',
      '<w:ind w:left="720" w:right="720" w:firstLine="0"/>',
      '<w:i/>',
      'EpigraphText'
    ) +
    paragraphStyle(
      'EpigraphSource',
      'Epigraph Source',
      '<w:ind w:left="720" w:right="720" w:firstLine="0"/><w:jc w:val="right"/>'
    ) +
    paragraphStyle(
      'GenHeading',
      'Page Heading',
      `<w:keepNext/>${spacingXml(72, 24, single)}${center}`,
      `${fontsXml(heading)}${half(1.4)}`,
      'BodyFirst'
    ) +
    paragraphStyle('TOC1', 'toc 1', `${spacingXml(0, 4, single)}<w:ind w:firstLine="0"/>`) +
    paragraphStyle(
      'TOC2',
      'toc 2',
      `${spacingXml(0, 4, single)}<w:ind w:left="360" w:firstLine="0"/>`
    ) +
    paragraphStyle(
      'MsContact',
      'Manuscript Contact',
      `${spacingXml(0, 0, single)}<w:ind w:firstLine="0"/>`
    ) +
    paragraphStyle(
      'MsTitle',
      'Manuscript Title',
      `${spacingXml(180, 0, line)}${center}`,
      '',
      'Centered'
    ) +
    paragraphStyle(
      'Header',
      'header',
      `${spacingXml(0, 0, single)}<w:tabs><w:tab w:val="center" w:pos="${Math.round(textWidth / 2)}"/><w:tab w:val="right" w:pos="${textWidth}"/></w:tabs><w:ind w:firstLine="0"/>`
    ) +
    paragraphStyle(
      'Footer',
      'footer',
      `${spacingXml(0, 0, single)}<w:tabs><w:tab w:val="center" w:pos="${Math.round(textWidth / 2)}"/><w:tab w:val="right" w:pos="${textWidth}"/></w:tabs><w:ind w:firstLine="0"/>`
    ) +
    paragraphStyle(
      'CommentText',
      'annotation text',
      `${spacingXml(0, 0, single)}<w:ind w:firstLine="0"/>`,
      half(0.85)
    ) +
    '<w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/><w:rPr><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>' +
    '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>' +
    '</w:styles>'
  )
}

function settingsXml(format: CompileFormat): string {
  // CT_Settings order: mirrorMargins, defaultTabStop, autoHyphenation, evenAndOddHeaders,
  // characterSpacingControl, compat.
  return (
    `${XML_DECL}<w:settings xmlns:w="${W_NS}">` +
    (format.pageSetup.mirrored ? '<w:mirrorMargins/>' : '') +
    '<w:defaultTabStop w:val="720"/>' +
    (format.typography.hyphenate ? '<w:autoHyphenation/>' : '') +
    (format.headersFooters.facing ? '<w:evenAndOddHeaders/>' : '') +
    '<w:characterSpacingControl w:val="doNotCompress"/>' +
    '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>' +
    '</w:settings>'
  )
}

function commentsXml(comments: readonly Comment[], author: string, stamp: string): string {
  const body = comments
    .map(
      (c) =>
        `<w:comment w:id="${c.id}" w:author="${escapeXml(author)}" w:date="${stamp}" w:initials="${escapeXml(initials(author))}">` +
        (c.paragraphs.length > 0 ? c.paragraphs : [[]])
          .map((p) => paragraphXml(paragraph('CommentText', runs(p))))
          .join('') +
        '</w:comment>'
    )
    .join('')
  return `${XML_DECL}<w:comments xmlns:w="${W_NS}" xmlns:r="${R_NS}">${body}</w:comments>`
}

function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
  return letters.slice(0, 4) || 'A'
}

/** W3CDTF without milliseconds, as Word writes it. */
export function w3cdtf(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`
}

function coreXml(book: CompiledBook, modified: Date): string {
  const { metadata } = book
  const stamp = w3cdtf(modified)
  const optional = (tag: string, value: string): string =>
    value ? `<${tag}>${escapeXml(value)}</${tag}>` : ''
  return (
    `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escapeXml(metadata.title)}</dc:title>` +
    optional('dc:subject', metadata.subtitle) +
    optional('dc:creator', metadata.author) +
    optional('cp:keywords', metadata.keywords.join(', ')) +
    optional('dc:description', metadata.description) +
    optional('dc:language', metadata.language) +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>` +
    '</cp:coreProperties>'
  )
}

/** The drop cap's height: three lines of the body. */
function dropCapPoints(format: CompileFormat): number {
  const { typography } = format
  const lineHeight =
    typography.lineSpacing.mode === 'exact'
      ? typography.lineSpacing.points
      : typography.size * 1.15 * typography.lineSpacing.value
  return Math.round(lineHeight * 3 * 0.95 * 2) / 2
}

export interface DocxOptions {
  modified?: Date
}

/** The compiled book as a DOCX package. */
export function renderDocx(book: CompiledBook, options: DocxOptions = {}): Buffer {
  const modified = options.modified ?? new Date()
  const body = new BodyWriter(book, dropCapPoints(book.format))
  body.write()
  const textWidth = body.textWidth()
  const hasComments = body.comments.length > 0
  // rId1 styles, rId2 settings, rId3 comments (when any); headers and footers after.
  const furniture = new Furniture(book, textWidth, hasComments ? 4 : 3)
  const sections = body.sections
  const paragraphsXml = sections
    .map((section, index) => {
      const sectPr = sectPrXml(section.run, book.format, furniture)
      const last = index === sections.length - 1
      const paras = section.paragraphs.map((p, i) =>
        !last && i === section.paragraphs.length - 1 ? { ...p, sectPr } : p
      )
      return paras.map(paragraphXml).join('') + (last ? sectPr : '')
    })
    .join('')
  const documentXml = `${XML_DECL}<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${paragraphsXml}</w:body></w:document>`

  const rels = [
    `<Relationship Id="rId1" Type="${REL_TYPE}/styles" Target="styles.xml"/>`,
    `<Relationship Id="rId2" Type="${REL_TYPE}/settings" Target="settings.xml"/>`,
    hasComments
      ? `<Relationship Id="rId3" Type="${REL_TYPE}/comments" Target="comments.xml"/>`
      : '',
    ...furniture.parts.map(
      (part) =>
        `<Relationship Id="${part.rId}" Type="${REL_TYPE}/${part.kind}" Target="${part.name}"/>`
    )
  ].join('')
  const wml = 'application/vnd.openxmlformats-officedocument.wordprocessingml'
  const contentTypes =
    `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `<Override PartName="/word/document.xml" ContentType="${wml}.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="${wml}.styles+xml"/>` +
    `<Override PartName="/word/settings.xml" ContentType="${wml}.settings+xml"/>` +
    (hasComments
      ? `<Override PartName="/word/comments.xml" ContentType="${wml}.comments+xml"/>`
      : '') +
    furniture.parts
      .map(
        (part) => `<Override PartName="/word/${part.name}" ContentType="${wml}.${part.kind}+xml"/>`
      )
      .join('') +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '</Types>'
  const rootRels =
    `${XML_DECL}<Relationships xmlns="${REL_NS}">` +
    `<Relationship Id="rId1" Type="${REL_TYPE}/officeDocument" Target="word/document.xml"/>` +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '</Relationships>'
  const file = (name: string, value: string): { name: string; data: Buffer } => ({
    name,
    data: Buffer.from(value, 'utf8')
  })
  return zipBuffer(
    [
      file('[Content_Types].xml', contentTypes),
      file('_rels/.rels', rootRels),
      file('word/document.xml', documentXml),
      file('word/styles.xml', stylesXml(book, textWidth)),
      file('word/settings.xml', settingsXml(book.format)),
      ...(hasComments
        ? [
            file(
              'word/comments.xml',
              commentsXml(body.comments, book.metadata.author || 'Author', w3cdtf(modified))
            )
          ]
        : []),
      ...furniture.parts.map((part) => file(`word/${part.name}`, part.xml)),
      file(
        'word/_rels/document.xml.rels',
        `${XML_DECL}<Relationships xmlns="${REL_NS}">${rels}</Relationships>`
      ),
      file('docProps/core.xml', coreXml(book, modified))
    ],
    modified
  )
}
