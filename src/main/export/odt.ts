import { CODE_FONT, officeFontName } from '@shared/bookFonts'
import {
  pageDimensions,
  type CompileFormat,
  type FurnitureSlots,
  type SectionLayout,
  type SectionLevel,
  type Separator
} from '@shared/compileFormat'
import { htmlId } from '@shared/compileHtml'
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
import { zipBuffer, type ZipEntryInput } from '../backups/zip'
import { w3cdtf } from './docx'
import { flatParagraphs, smallCapsLead } from './inlines'

/**
 * The ODT writer (Compile v2, CV2): an OpenDocument Text package written by hand and zipped
 * with the backup zip writer (`mimetype` first and stored). Named paragraph styles carry the
 * format (Text body, Body First, one title style per section level with its outline level), a
 * page layout carries the page (mirrored when the format is), and three master pages carry the
 * furniture: Standard (headers and footers, left pages their own when facing), Opener (bare,
 * then Standard), and Front (bare). Each page run starts with its master and, at the body,
 * restarts page numbering. `{chapter}` is ODF's chapter field (the latest chapter-level heading).
 * A new recto is a new page (ODF has no right-page break; decided by Claude, unconfirmed). Notes
 * in `comments` mode are annotations.
 */

const NS = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
  'xmlns:xlink="http://www.w3.org/1999/xlink"',
  'xmlns:dc="http://purl.org/dc/elements/1.1/"',
  'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"'
].join(' ')
const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>'
const MIMETYPE = 'application/vnd.oasis.opendocument.text'

const inch = (n: number): string => `${Math.round(n * 1000) / 1000}in`
const pt = (n: number): string => `${Math.round(n * 100) / 100}pt`

/** ODF text: escaped, tabs as `<text:tab/>`, runs of spaces kept with `<text:s/>`. */
export function odfText(value: string): string {
  return escapeXml(value)
    .replace(/\t/g, '<text:tab/>')
    .replace(/\r?\n/g, ' ')
    .replace(/ {2,}/g, (spaces) => ` <text:s text:c="${spaces.length - 1}"/>`)
    .replace(/^ /, '<text:s/>')
}

const ALIGN: Record<ContentAlign, string> = {
  left: 'start',
  center: 'center',
  right: 'end',
  justify: 'justify'
}

const LEVEL_STYLE: Record<SectionLevel, string> = {
  part: 'Part_20_Title',
  chapter: 'Chapter_20_Title',
  chapterScene: 'Chapter_20_Scene_20_Title',
  scene: 'Scene_20_Title'
}
const LEVEL_NAME: Record<SectionLevel, string> = {
  part: 'Part Title',
  chapter: 'Chapter Title',
  chapterScene: 'Chapter Scene Title',
  scene: 'Scene Title'
}
const LEVEL_OUTLINE: Record<SectionLevel, number> = {
  part: 1,
  chapter: 2,
  chapterScene: 2,
  scene: 3
}

function fontDecl(name: string): string {
  const n = escapeXml(name)
  return `<style:font-face style:name="${n}" svg:font-family="'${n}'"/>`
}

class OdtWriter {
  private readonly out: string[] = []
  private readonly autoStyles = new Map<string, string>()
  private readonly fonts = new Set<string>()
  private readonly comments = new Map<string, Inline[][]>()
  /** The master and numbering the next paragraph opens its page run with. */
  private pendingRun: PageRun | null = null

  constructor(private readonly book: CompiledBook) {
    for (const item of book.items)
      if (item.kind === 'note' && item.mode === 'comments')
        this.comments.set(item.id, flatParagraphs(item.blocks))
  }

  private get format(): CompileFormat {
    return this.book.format
  }

  private font(name: string): string {
    this.fonts.add(name)
    return escapeXml(name)
  }

  /** An automatic style, shared by every use of the same properties. */
  private auto(
    family: 'paragraph' | 'text',
    parent: string | null,
    props: string,
    extra = ''
  ): string {
    const key = `${family}|${parent ?? ''}|${props}|${extra}`
    let name = this.autoStyles.get(key)
    if (name === undefined) {
      name = `${family === 'paragraph' ? 'P' : 'T'}${this.autoStyles.size + 1}`
      this.autoStyles.set(key, name)
    }
    return name
  }

  private autoStylesXml(): string {
    return [...this.autoStyles.entries()]
      .map(([key, name]) => {
        const [family = 'paragraph', parent = '', props = '', extra = ''] = key.split('|')
        return `<style:style style:name="${name}" style:family="${family}"${parent ? ` style:parent-style-name="${parent}"` : ''}${extra}>${props}</style:style>`
      })
      .join('')
  }

  private runs(inlines: readonly Inline[]): string {
    return inlines
      .map((run) => {
        if (run.kind === 'hardBreak') return '<text:line-break/>'
        const props = [
          run.code ? ` style:font-name="${this.font(officeFontName(CODE_FONT))}"` : '',
          run.bold ? ' fo:font-weight="bold"' : '',
          run.italic ? ' fo:font-style="italic"' : '',
          run.underline
            ? ' style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"'
            : '',
          run.strike ? ' style:text-line-through-style="solid"' : '',
          run.smallCaps ? ' fo:font-variant="small-caps"' : '',
          run.ai ? ' fo:background-color="#dcdcdc"' : ''
        ].join('')
        const content = odfText(run.text)
        if (props === '') return content
        const name = this.auto('text', null, `<style:text-properties${props}/>`)
        return `<text:span text:style-name="${name}">${content}</text:span>`
      })
      .join('')
  }

  /** One paragraph (or heading); opens the pending page run on it and anchors a comment. */
  private para(
    style: string,
    content: string,
    options: {
      commentFor?: string | null
      heading?: number
      bookmark?: string
      paraProps?: string
    } = {}
  ): void {
    let name = style
    const run = this.pendingRun
    if (run !== null) {
      this.pendingRun = null
      const master = run.front ? 'Front' : run.bareFirst ? 'Opener' : 'Standard'
      const numbering = run.restartNumbering ? ' style:page-number="1"' : ''
      name = this.auto(
        'paragraph',
        style,
        `<style:paragraph-properties${numbering}/>`,
        ` style:master-page-name="${master}"`
      )
    } else if (options.paraProps !== undefined) {
      name = this.auto('paragraph', style, options.paraProps)
    }
    let annotation = ''
    const anchor = options.commentFor ?? null
    if (anchor !== null) {
      const comment = this.comments.get(anchor)
      if (comment !== undefined) {
        this.comments.delete(anchor)
        const paragraphs = comment.map((p) => `<text:p>${this.runs(p)}</text:p>`).join('')
        annotation = `<office:annotation><dc:creator>${escapeXml(this.book.metadata.author || 'Author')}</dc:creator>${paragraphs || '<text:p/>'}</office:annotation>`
      }
    }
    const mark =
      options.bookmark !== undefined ? `<text:bookmark text:name="${options.bookmark}"/>` : ''
    const body = annotation + mark + content
    this.out.push(
      options.heading !== undefined
        ? `<text:h text:style-name="${name}" text:outline-level="${options.heading}">${body}</text:h>`
        : `<text:p text:style-name="${name}">${body}</text:p>`
    )
  }

  write(): { content: string; styles: string } {
    const runs = new Map(pageRuns(this.book).map((run) => [run.start, run]))
    this.book.items.forEach((item, index) => {
      const run = runs.get(index)
      // The first run needs no page break; it still sets the master and the numbering.
      if (run !== undefined) this.pendingRun = run
      this.item(item)
    })
    if (this.out.length === 0) this.para('Text_20_body', '')
    const styles = this.stylesXml()
    const fontDecls = [...this.fonts].map(fontDecl).join('')
    const content =
      `${XML_DECL}<office:document-content ${NS} office:version="1.3">` +
      `<office:font-face-decls>${fontDecls}</office:font-face-decls>` +
      `<office:automatic-styles>${this.autoStylesXml()}</office:automatic-styles>` +
      `<office:body><office:text>${this.out.join('')}</office:text></office:body></office:document-content>`
    return {
      content,
      styles: styles.replace(
        '<office:font-face-decls/>',
        `<office:font-face-decls>${fontDecls}</office:font-face-decls>`
      )
    }
  }

  private item(item: BookItem): void {
    switch (item.kind) {
      case 'page':
        this.generated(item.page)
        return
      case 'matter':
        this.blocks(item.blocks, item.id, true, false)
        return
      case 'section': {
        if (item.heading === null) return
        const content = item.heading.lines.map(odfText).join('<text:line-break/>')
        this.para(LEVEL_STYLE[item.level], content, {
          commentFor: item.id,
          heading: LEVEL_OUTLINE[item.level],
          bookmark: htmlId('s', item.id)
        })
        return
      }
      case 'separator':
        this.separator(item.separator)
        return
      case 'text':
        this.blocks(item.blocks, item.id, false, false)
        return
      case 'synopsis':
        this.para('Synopsis', odfText(item.text), { commentFor: item.id })
        return
      case 'note':
        if (item.mode === 'comments') {
          if (this.comments.has(item.id)) this.para('Body_20_First', '', { commentFor: item.id })
          return
        }
        this.para('Note_20_Label', 'Note')
        for (const runs of flatParagraphs(item.blocks)) this.para('Note', this.runs(runs))
    }
  }

  private separator(separator: Separator): void {
    switch (separator.kind) {
      case 'text':
        this.para('Scene_20_Break', odfText(separator.text))
        return
      case 'blankLine':
        this.para('Body_20_First', '')
        return
      case 'pageBreak':
        this.para('Body_20_First', '', {
          paraProps: '<style:paragraph-properties fo:break-after="page"/>'
        })
    }
  }

  private blocks(
    blocks: readonly ContentBlock[],
    anchorId: string,
    matter: boolean,
    quote: boolean
  ): void {
    blocks.forEach((block, index) => {
      const commentFor = index === 0 ? anchorId : null
      switch (block.kind) {
        case 'paragraph': {
          const base = quote
            ? 'Quote'
            : block.opening === 'none' && !(matter && index === 0)
              ? 'Text_20_body'
              : 'Body_20_First'
          const alignProps =
            block.align !== null
              ? `<style:paragraph-properties fo:text-align="${ALIGN[block.align]}"${block.align === 'center' || block.align === 'right' ? ' fo:text-indent="0in"' : ''}/>`
              : undefined
          const dropProps =
            block.opening === 'dropCap' && !quote
              ? '<style:paragraph-properties><style:drop-cap style:lines="3" style:length="1" style:distance="0.04in"/></style:paragraph-properties>'
              : undefined
          const runs = block.opening === 'smallCapsLine' ? smallCapsLead(block.runs) : block.runs
          this.para(base, this.runs(runs), { commentFor, paraProps: dropProps ?? alignProps })
          return
        }
        case 'heading':
          this.para(`Text_20_Heading_20_${block.level}`, this.runs(block.runs), { commentFor })
          return
        case 'quote':
          this.blocks(block.blocks, commentFor ?? '', matter, true)
          return
        case 'separator':
          this.separator(block.separator)
      }
    })
  }

  private generated(page: GeneratedPage): void {
    const plain = (style: string, value: string): void => this.para(style, odfText(value))
    switch (page.kind) {
      case 'titlePage':
        plain('Book_20_Title', page.title)
        if (page.subtitle) plain('Book_20_Subtitle', page.subtitle)
        if (page.series) plain('Centered', page.series)
        if (page.author) plain('Book_20_Author', page.author)
        if (page.publisher) plain('Book_20_Publisher', page.publisher)
        return
      case 'manuscriptTitle': {
        const [firstLine = '', ...rest] = page.contact
        this.para(
          'Manuscript_20_Contact',
          `${odfText(firstLine)}<text:tab/>${odfText(page.wordCount)}`
        )
        for (const line of rest) plain('Manuscript_20_Contact', line)
        plain('Manuscript_20_Title', page.title)
        if (page.byline) plain('Centered', page.byline)
        return
      }
      case 'copyright':
        for (const line of page.lines) plain('Copyright', line)
        return
      case 'dedication':
        page.paragraphs.forEach((line, index) =>
          plain(index === 0 ? 'Dedication' : 'Dedication_20_Text', line)
        )
        return
      case 'epigraph':
        page.paragraphs.forEach((line, index) =>
          plain(index === 0 ? 'Epigraph' : 'Epigraph_20_Text', line)
        )
        if (page.source) plain('Epigraph_20_Source', `— ${page.source}`)
        return
      case 'toc':
        plain('Page_20_Heading', page.title)
        for (const entry of page.entries)
          this.para(
            entry.level !== 'part' && entry.inPart ? 'Contents_20_2' : 'Contents_20_1',
            `<text:a xlink:type="simple" xlink:href="#${htmlId('s', entry.id)}">${odfText(entry.label)}</text:a>`
          )
        return
      case 'aboutAuthor':
        plain('Page_20_Heading', page.title)
        for (const line of page.paragraphs) plain('Body_20_First', line)
        return
      case 'alsoBy':
        plain('Page_20_Heading', page.title)
        for (const title of page.titles) plain('Dedication_20_Text', title)
    }
  }

  // -------------------------------------------------------------------------------------------
  // styles.xml

  private furniture(slots: FurnitureSlots, style: string): string {
    if (!slots.left && !slots.center && !slots.right) return `<text:p text:style-name="${style}"/>`
    const values = furnitureValues(this.book.metadata, '', '')
    const slot = (template: string): string =>
      furnitureSegments(template)
        .map((s) => {
          if (s.kind === 'text') return odfText(s.text)
          if (s.token === 'page')
            return '<text:page-number text:select-page="current">1</text:page-number>'
          if (s.token === 'chapter')
            return '<text:chapter text:display="name" text:outline-level="2"/>'
          return odfText(values[s.token])
        })
        .join('')
    return `<text:p text:style-name="${style}">${slot(slots.left)}<text:tab/>${slot(slots.center)}<text:tab/>${slot(slots.right)}</text:p>`
  }

  private stylesXml(): string {
    const { typography, pageSetup, headersFooters, sections } = this.format
    const { width, height } = pageDimensions(pageSetup)
    const { top, bottom, inside, outside } = pageSetup.margins
    const textWidth = width - inside - outside - pageSetup.gutter
    const body = this.font(officeFontName(typography.font))
    const heading = this.font(officeFontName(typography.headingFont))
    const size = typography.size
    const lineHeight =
      typography.lineSpacing.mode === 'multiple'
        ? `${Math.round(typography.lineSpacing.value * 100)}%`
        : pt(typography.lineSpacing.points)
    const lines = Math.max(typography.widowControl, 0)
    const lang = (this.book.metadata.language || 'en').split('-')
    const tabs = `<style:tab-stops><style:tab-stop style:position="${inch(textWidth / 2)}" style:type="center"/><style:tab-stop style:position="${inch(textWidth)}" style:type="right"/></style:tab-stops>`
    const style = (
      name: string,
      display: string,
      parent: string,
      paragraph: string,
      text = '',
      extra = ''
    ): string =>
      `<style:style style:name="${name}" style:display-name="${display}" style:family="paragraph" style:parent-style-name="${parent}"${extra}>` +
      `<style:paragraph-properties${paragraph}/>${text ? `<style:text-properties${text}/>` : ''}</style:style>`
    const centre = ' fo:text-align="center" fo:text-indent="0in"'
    const single = ' fo:line-height="115%"'
    const level = (lvl: SectionLevel, layout: SectionLayout): string => {
      const font = this.font(officeFontName(layout.font ?? typography.headingFont))
      return style(
        LEVEL_STYLE[lvl],
        LEVEL_NAME[lvl],
        'Standard',
        ` fo:text-align="${ALIGN[layout.align]}" fo:text-indent="0in" fo:margin-top="${pt(layout.spaceBefore)}" fo:margin-bottom="${pt(layout.spaceAfter)}" fo:line-height="120%" fo:keep-with-next="always"`,
        ` style:font-name="${font}" fo:font-size="${pt(layout.size)}" fo:font-weight="${layout.bold ? 'bold' : 'normal'}" fo:font-style="${layout.italic ? 'italic' : 'normal'}"${layout.case === 'smallCaps' ? ' fo:font-variant="small-caps"' : ''}`,
        ` style:default-outline-level="${LEVEL_OUTLINE[lvl]}" style:next-style-name="Body_20_First"`
      )
    }
    const named = [
      `<style:default-style style:family="paragraph"><style:paragraph-properties fo:orphans="${lines}" fo:widows="${lines}"/>` +
        `<style:text-properties style:font-name="${body}" fo:font-size="${pt(size)}" fo:language="${escapeXml(lang[0] ?? 'en')}"${lang[1] ? ` fo:country="${escapeXml(lang[1])}"` : ''} fo:hyphenate="${typography.hyphenate}"/></style:default-style>`,
      '<style:style style:name="Standard" style:family="paragraph" style:class="text"/>',
      style(
        'Text_20_body',
        'Text body',
        'Standard',
        ` fo:text-indent="${pt(typography.indent * size)}" fo:line-height="${lineHeight}" fo:margin-top="0in" fo:margin-bottom="${pt(typography.paragraphSpacing)}" fo:text-align="${typography.justify ? 'justify' : 'start'}"`
      ),
      style(
        'Body_20_First',
        'Body First',
        'Text_20_body',
        ' fo:text-indent="0in"',
        '',
        ' style:next-style-name="Text_20_body"'
      ),
      ...(['part', 'chapter', 'chapterScene', 'scene'] as const).map((lvl) =>
        level(lvl, sections[lvl])
      ),
      style(
        'Text_20_Heading_20_1',
        'Text Heading 1',
        'Body_20_First',
        ' fo:margin-top="12pt" fo:margin-bottom="6pt" fo:keep-with-next="always"',
        ' fo:font-weight="bold" fo:font-size="115%"'
      ),
      style(
        'Text_20_Heading_20_2',
        'Text Heading 2',
        'Body_20_First',
        ' fo:margin-top="12pt" fo:margin-bottom="6pt" fo:keep-with-next="always"',
        ' fo:font-weight="bold" fo:font-size="105%"'
      ),
      style(
        'Text_20_Heading_20_3',
        'Text Heading 3',
        'Body_20_First',
        ' fo:margin-top="12pt" fo:margin-bottom="6pt" fo:keep-with-next="always"',
        ' fo:font-weight="bold"'
      ),
      style(
        'Scene_20_Break',
        'Scene Break',
        'Body_20_First',
        `${centre} fo:margin-top="6pt" fo:margin-bottom="6pt" fo:keep-with-next="always"`
      ),
      style('Quote', 'Quote', 'Body_20_First', ' fo:margin-left="0.5in" fo:margin-right="0.5in"'),
      style(
        'Synopsis',
        'Synopsis',
        'Body_20_First',
        ' fo:margin-bottom="6pt"',
        ' fo:font-style="italic"'
      ),
      style(
        'Note_20_Label',
        'Note Label',
        'Standard',
        ' fo:margin-left="0.25in" fo:margin-top="6pt" fo:keep-with-next="always"',
        ' fo:font-weight="bold" fo:font-size="75%" fo:text-transform="uppercase"'
      ),
      style(
        'Note',
        'Note',
        'Standard',
        ` fo:margin-left="0.25in" fo:margin-bottom="6pt"${single}`,
        ' fo:font-size="90%"'
      ),
      style('Centered', 'Centered', 'Body_20_First', centre),
      style(
        'Book_20_Title',
        'Book Title',
        'Standard',
        `${centre} fo:margin-top="2in" fo:margin-bottom="12pt"`,
        ` style:font-name="${heading}" fo:font-size="220%"`
      ),
      style(
        'Book_20_Subtitle',
        'Book Subtitle',
        'Standard',
        `${centre} fo:margin-bottom="12pt"`,
        ' fo:font-style="italic" fo:font-size="120%"'
      ),
      style(
        'Book_20_Author',
        'Book Author',
        'Standard',
        `${centre} fo:margin-top="36pt"`,
        ' fo:font-size="120%"'
      ),
      style(
        'Book_20_Publisher',
        'Book Publisher',
        'Standard',
        `${centre} fo:margin-top="2in"`,
        ' fo:font-size="90%"'
      ),
      style(
        'Copyright',
        'Copyright',
        'Standard',
        ` fo:margin-bottom="6pt"${single}`,
        ' fo:font-size="85%"'
      ),
      style(
        'Dedication',
        'Dedication',
        'Standard',
        `${centre} fo:margin-top="2in"`,
        ' fo:font-style="italic"'
      ),
      style('Dedication_20_Text', 'Dedication Text', 'Standard', centre, ' fo:font-style="italic"'),
      style(
        'Epigraph',
        'Epigraph',
        'Standard',
        ' fo:margin-left="0.5in" fo:margin-right="0.5in" fo:margin-top="1.5in"',
        ' fo:font-style="italic"'
      ),
      style(
        'Epigraph_20_Text',
        'Epigraph Text',
        'Standard',
        ' fo:margin-left="0.5in" fo:margin-right="0.5in"',
        ' fo:font-style="italic"'
      ),
      style(
        'Epigraph_20_Source',
        'Epigraph Source',
        'Standard',
        ' fo:margin-left="0.5in" fo:margin-right="0.5in" fo:text-align="end"'
      ),
      style(
        'Page_20_Heading',
        'Page Heading',
        'Standard',
        `${centre} fo:margin-top="1in" fo:margin-bottom="24pt" fo:keep-with-next="always"`,
        ` style:font-name="${heading}" fo:font-size="140%"`
      ),
      style('Contents_20_1', 'Contents 1', 'Standard', ` fo:margin-bottom="4pt"${single}`),
      style(
        'Contents_20_2',
        'Contents 2',
        'Standard',
        ` fo:margin-left="0.25in" fo:margin-bottom="4pt"${single}`
      ),
      `<style:style style:name="Manuscript_20_Contact" style:display-name="Manuscript Contact" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties${single}>${tabs}</style:paragraph-properties></style:style>`,
      style(
        'Manuscript_20_Title',
        'Manuscript Title',
        'Standard',
        `${centre} fo:margin-top="2.5in" fo:line-height="${lineHeight}"`
      ),
      `<style:style style:name="Header" style:family="paragraph" style:parent-style-name="Standard" style:class="extra"><style:paragraph-properties>${tabs}</style:paragraph-properties></style:style>`,
      `<style:style style:name="Footer" style:family="paragraph" style:parent-style-name="Standard" style:class="extra"><style:paragraph-properties>${tabs}</style:paragraph-properties></style:style>`
    ].join('')
    const binding = inside + pageSetup.gutter
    const layoutProps = (marginTop: number, marginBottom: number): string =>
      `<style:page-layout-properties fo:page-width="${inch(width)}" fo:page-height="${inch(height)}" fo:margin-top="${inch(marginTop)}" fo:margin-bottom="${inch(marginBottom)}" fo:margin-left="${inch(binding)}" fo:margin-right="${inch(outside)}"/>`
    const usage = pageSetup.mirrored ? 'mirrored' : 'all'
    // With furniture the header sits inside the top margin, so the page margin is halved and the
    // header area takes the rest; the bare layout keeps the whole margin so the text stays put.
    const pageLayouts =
      `<style:page-layout style:name="pm1" style:page-usage="${usage}">${layoutProps(top / 2, bottom / 2)}` +
      `<style:header-style><style:header-footer-properties fo:min-height="${inch(top / 2)}" fo:margin-bottom="0in"/></style:header-style>` +
      `<style:footer-style><style:header-footer-properties fo:min-height="${inch(bottom / 2)}" fo:margin-top="0in"/></style:footer-style></style:page-layout>` +
      `<style:page-layout style:name="pm2" style:page-usage="${usage}">${layoutProps(top, bottom)}<style:header-style/><style:footer-style/></style:page-layout>`
    const { recto, verso, facing } = headersFooters
    const masters =
      '<style:master-page style:name="Standard" style:page-layout-name="pm1">' +
      `<style:header>${this.furniture(recto.header, 'Header')}</style:header>` +
      (facing
        ? `<style:header-left>${this.furniture(verso.header, 'Header')}</style:header-left>`
        : '') +
      `<style:footer>${this.furniture(recto.footer, 'Footer')}</style:footer>` +
      (facing
        ? `<style:footer-left>${this.furniture(verso.footer, 'Footer')}</style:footer-left>`
        : '') +
      '</style:master-page>' +
      '<style:master-page style:name="Opener" style:page-layout-name="pm2" style:next-style-name="Standard"/>' +
      '<style:master-page style:name="Front" style:page-layout-name="pm2"/>'
    return (
      `${XML_DECL}<office:document-styles ${NS} office:version="1.3">` +
      '<office:font-face-decls/>' +
      `<office:styles>${named}</office:styles>` +
      `<office:automatic-styles>${pageLayouts}</office:automatic-styles>` +
      `<office:master-styles>${masters}</office:master-styles>` +
      '</office:document-styles>'
    )
  }
}

function metaXml(book: CompiledBook, modified: Date): string {
  const m = book.metadata
  const optional = (tag: string, value: string): string =>
    value ? `<${tag}>${escapeXml(value)}</${tag}>` : ''
  return (
    `${XML_DECL}<office:document-meta ${NS} office:version="1.3"><office:meta>` +
    '<meta:generator>MythScribe</meta:generator>' +
    `<dc:title>${escapeXml(m.title)}</dc:title>` +
    optional('dc:subject', m.subtitle) +
    optional('dc:description', m.description) +
    optional('meta:initial-creator', m.author) +
    optional('dc:creator', m.author) +
    optional('dc:language', m.language) +
    m.keywords.map((k) => `<meta:keyword>${escapeXml(k)}</meta:keyword>`).join('') +
    `<meta:creation-date>${w3cdtf(modified)}</meta:creation-date><dc:date>${w3cdtf(modified)}</dc:date>` +
    '</office:meta></office:document-meta>'
  )
}

const MANIFEST =
  `${XML_DECL}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">` +
  `<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${MIMETYPE}"/>` +
  '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
  '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>' +
  '<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>' +
  '</manifest:manifest>'

/** The compiled book as an ODT package. */
export function renderOdt(book: CompiledBook, modified = new Date()): Buffer {
  const { content, styles } = new OdtWriter(book).write()
  const text = (name: string, value: string, store = false): ZipEntryInput => ({
    name,
    data: Buffer.from(value, 'utf8'),
    store
  })
  return zipBuffer(
    [
      text('mimetype', MIMETYPE, true),
      text('META-INF/manifest.xml', MANIFEST),
      text('content.xml', content),
      text('styles.xml', styles),
      text('meta.xml', metaXml(book, modified))
    ],
    modified
  )
}
