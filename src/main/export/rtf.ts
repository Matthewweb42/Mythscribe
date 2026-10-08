import { CODE_FONT, officeFontName } from '@shared/bookFonts'
import {
  pageDimensions,
  type CompileFormat,
  type FurnitureSlots,
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
import { flatParagraphs, plainRun, smallCapsLead } from './inlines'

/**
 * The RTF writer (Compile v2, CV2): Rich Text Format 1.9 written by hand, direct formatting on
 * every paragraph (no style sheet). Page size, margins, mirrored margins, and gutter are the
 * document's; every page run (`pageRuns`) is an RTF section with its start (`\sbkodd` for a
 * recto), its headers and footers (a PAGE field; `{chapter}` as the chapter that opens the
 * section), an empty first-page header on openers, and the numbering restarted at the body.
 * Notes in `comments` mode are RTF annotations. A drop cap opens unindented (RTF's drop caps are
 * frames few readers honour; decided by Claude, unconfirmed).
 */

const tw = (points: number): number => Math.round(points * 20)
const twIn = (inches: number): number => Math.round(inches * 1440)

/** RTF text: control characters escaped, everything past ASCII as `\uN?` (UTF-16, signed). */
export function rtfText(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    const char = text[i] ?? ''
    if (char === '\\' || char === '{' || char === '}') out += `\\${char}`
    else if (char === '\t') out += '\\tab '
    else if (char === '\n' || char === '\r') out += ' '
    else if (code < 0x20) continue
    else if (code < 0x80) out += char
    else out += `\\u${code > 0x7fff ? code - 0x10000 : code}?`
  }
  return out
}

const ALIGN: Record<ContentAlign, string> = {
  left: '\\ql',
  center: '\\qc',
  right: '\\qr',
  justify: '\\qj'
}

class Fonts {
  private readonly names: string[] = []
  index(name: string): number {
    let at = this.names.indexOf(name)
    if (at === -1) {
      at = this.names.length
      this.names.push(name)
    }
    return at
  }
  table(): string {
    return `{\\fonttbl${this.names.map((name, i) => `{\\f${i}\\fnil ${rtfText(name)};}`).join('')}}`
  }
}

const LEVEL_OUTLINE: Record<SectionLevel, number> = {
  part: 0,
  chapter: 1,
  chapterScene: 1,
  scene: 2
}

class RtfWriter {
  private readonly fonts = new Fonts()
  private readonly out: string[] = []
  private readonly body: number
  private readonly code: number
  private readonly size: number
  private readonly comments = new Map<string, Inline[][]>()

  constructor(private readonly book: CompiledBook) {
    const { typography } = book.format
    this.body = this.fonts.index(officeFontName(typography.font))
    this.code = this.fonts.index(officeFontName(CODE_FONT))
    this.size = Math.round(typography.size * 2)
    for (const item of book.items)
      if (item.kind === 'note' && item.mode === 'comments')
        this.comments.set(item.id, flatParagraphs(item.blocks))
  }

  private get format(): CompileFormat {
    return this.book.format
  }

  private lineSpacing(): string {
    const spacing = this.format.typography.lineSpacing
    return spacing.mode === 'multiple'
      ? `\\sl${Math.round(240 * spacing.value)}\\slmult1`
      : `\\sl-${tw(spacing.points)}\\slmult0`
  }

  private runs(inlines: readonly Inline[]): string {
    return inlines
      .map((run) => {
        if (run.kind === 'hardBreak') return '\\line '
        const marks = [
          run.code ? `\\f${this.code}` : '',
          run.bold ? '\\b' : '',
          run.italic ? '\\i' : '',
          run.underline ? '\\ul' : '',
          run.strike ? '\\strike' : '',
          run.smallCaps ? '\\scaps' : '',
          run.ai ? '\\highlight1' : ''
        ].join('')
        return marks ? `{${marks} ${rtfText(run.text)}}` : rtfText(run.text)
      })
      .join('')
  }

  private para(props: string, content: string, commentFor: string | null = null): void {
    let annotation = ''
    if (commentFor !== null) {
      const comment = this.comments.get(commentFor)
      if (comment !== undefined) {
        this.comments.delete(commentFor)
        const author = rtfText(this.book.metadata.author || 'Author')
        const text = comment.map((p) => `${this.runs(p)}\\par `).join('')
        annotation = `{\\*\\atnid ${author}}{\\*\\atnauthor ${author}}\\chatn{\\*\\annotation\\pard\\plain\\f${this.body}\\fs20 ${text}}`
      }
    }
    this.out.push(
      `\\pard\\plain\\f${this.body}\\fs${this.size}${props} ${content}${annotation}\\par`
    )
  }

  private bodyProps(indent: boolean, align: ContentAlign | null): string {
    const { typography } = this.format
    const fi =
      indent && align !== 'center' && align !== 'right'
        ? Math.round(typography.indent * typography.size * 20)
        : 0
    const jc = align !== null ? ALIGN[align] : typography.justify ? '\\qj' : '\\ql'
    return `\\fi${fi}${this.lineSpacing()}\\sa${tw(typography.paragraphSpacing)}${jc}${typography.widowControl > 0 ? '\\widctlpar' : '\\nowidctlpar'}`
  }

  write(): string {
    const { format, metadata } = this.book
    const { pageSetup, headersFooters, typography } = format
    const { width, height } = pageDimensions(pageSetup)
    const { top, bottom, inside, outside } = pageSetup.margins
    const runs = new Map(pageRuns(this.book).map((run) => [run.start, run]))
    this.book.items.forEach((item, index) => {
      const run = runs.get(index)
      if (run !== undefined) this.section(run, index === 0)
      this.item(item)
    })
    const info = [
      `{\\title ${rtfText(metadata.title)}}`,
      metadata.subtitle ? `{\\subject ${rtfText(metadata.subtitle)}}` : '',
      metadata.author ? `{\\author ${rtfText(metadata.author)}}` : '',
      metadata.keywords.length > 0 ? `{\\keywords ${rtfText(metadata.keywords.join(', '))}}` : '',
      metadata.description ? `{\\doccomm ${rtfText(metadata.description)}}` : ''
    ].join('')
    const doc = [
      `\\paperw${twIn(width)}\\paperh${twIn(height)}`,
      `\\margl${twIn(inside)}\\margr${twIn(outside)}\\margt${twIn(top)}\\margb${twIn(bottom)}\\gutter${twIn(pageSetup.gutter)}`,
      headersFooters.facing ? '\\facingp' : '',
      pageSetup.mirrored ? '\\margmirror' : '',
      typography.widowControl > 0 ? '\\widowctrl' : '',
      typography.hyphenate ? '\\hyphauto1' : ''
    ].join('')
    // The font table is built while writing, so the head goes on last.
    return `{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1${this.fonts.table()}{\\colortbl;\\red220\\green220\\blue220;}{\\info${info}}${doc}\n${this.out.join('\n')}\n}\n`
  }

  private section(run: PageRun, first: boolean): void {
    const { headersFooters } = this.format
    const { top, bottom } = this.format.pageSetup.margins
    const props = [
      first ? '\\sectd' : '\\sect\\sectd',
      run.how === 'newRecto' ? '\\sbkodd' : '\\sbkpage',
      run.restartNumbering ? '\\pgnrestart\\pgnstarts1' : '',
      run.bareFirst && !run.front ? '\\titlepg' : '',
      `\\headery${Math.min(720, twIn(top / 2))}\\footery${Math.min(720, twIn(bottom / 2))}`
    ].join('')
    const groups: string[] = []
    const slots = (side: 'recto' | 'verso', kind: 'header' | 'footer'): FurnitureSlots | null =>
      run.front ? null : headersFooters[side][kind]
    for (const kind of ['header', 'footer'] as const) {
      if (headersFooters.facing) {
        groups.push(`{\\${kind}r ${this.furniture(slots('recto', kind), run.runningHead)}}`)
        groups.push(`{\\${kind}l ${this.furniture(slots('verso', kind), run.runningHead)}}`)
      } else {
        groups.push(`{\\${kind} ${this.furniture(slots('recto', kind), run.runningHead)}}`)
      }
      if (run.bareFirst && !run.front) groups.push(`{\\${kind}f ${this.furniture(null, '')}}`)
    }
    this.out.push(props + groups.join(''))
  }

  private furniture(slots: FurnitureSlots | null, chapter: string): string {
    const { pageSetup } = this.format
    const { width } = pageDimensions(pageSetup)
    const textWidth = twIn(
      width - pageSetup.margins.inside - pageSetup.margins.outside - pageSetup.gutter
    )
    let content = ''
    if (slots !== null && (slots.left || slots.center || slots.right)) {
      const values = furnitureValues(this.book.metadata, '', chapter)
      const slot = (template: string): string =>
        furnitureSegments(template)
          .map((s) => {
            if (s.kind === 'text') return rtfText(s.text)
            if (s.token === 'page') return '{\\field{\\*\\fldinst PAGE}{\\fldrslt 1}}'
            return rtfText(values[s.token])
          })
          .join('')
      content = `${slot(slots.left)}\\tab ${slot(slots.center)}\\tab ${slot(slots.right)}`
    }
    return `\\pard\\plain\\f${this.body}\\fs${this.size}\\tqc\\tx${Math.round(textWidth / 2)}\\tqr\\tx${textWidth} ${content}\\par`
  }

  private item(item: BookItem): void {
    switch (item.kind) {
      case 'page':
        this.generated(item.page)
        return
      case 'matter':
        this.blocks(item.blocks, item.id, true, '')
        return
      case 'section': {
        if (item.heading === null) return
        const layout = item.layout
        const font = this.fonts.index(
          officeFontName(layout.font ?? this.format.typography.headingFont)
        )
        const props = [
          '\\keepn\\fi0',
          `\\f${font}\\fs${Math.round(layout.size * 2)}`,
          layout.bold ? '\\b' : '',
          layout.italic ? '\\i' : '',
          layout.case === 'smallCaps' ? '\\scaps' : '',
          ALIGN[layout.align],
          `\\sb${tw(layout.spaceBefore)}\\sa${tw(layout.spaceAfter)}`,
          `\\outlinelevel${LEVEL_OUTLINE[item.level]}`
        ].join('')
        this.para(props, item.heading.lines.map(rtfText).join('\\line '), item.id)
        return
      }
      case 'separator':
        this.separator(item.separator)
        return
      case 'text':
        this.blocks(item.blocks, item.id, false, '')
        return
      case 'synopsis':
        this.para(`${this.bodyProps(false, null)}\\i`, rtfText(item.text), item.id)
        return
      case 'note':
        if (item.mode === 'comments') {
          // A note whose node printed nothing goes on an empty paragraph of its own.
          if (this.comments.has(item.id)) this.para('', '', item.id)
          return
        }
        this.para('\\keepn\\li360\\fi0\\b\\fs16', 'NOTE')
        for (const runs of flatParagraphs(item.blocks))
          this.para(`\\li360\\fi0\\sa120\\fs${Math.round(this.size * 0.9)}`, this.runs(runs))
    }
  }

  private separator(separator: Separator): void {
    switch (separator.kind) {
      case 'text':
        this.para(
          `${this.bodyProps(false, 'center')}\\keepn\\sb120\\sa120`,
          rtfText(separator.text)
        )
        return
      case 'blankLine':
        this.para(this.bodyProps(false, null), '')
        return
      case 'pageBreak':
        this.para(this.bodyProps(false, null), '\\page')
    }
  }

  private blocks(
    blocks: readonly ContentBlock[],
    anchorId: string,
    matter: boolean,
    extra: string
  ): void {
    blocks.forEach((block, index) => {
      const anchor = index === 0 ? anchorId : null
      switch (block.kind) {
        case 'paragraph': {
          const indent = extra === '' && block.opening === 'none' && !(matter && index === 0)
          const runs = block.opening === 'smallCapsLine' ? smallCapsLead(block.runs) : block.runs
          this.para(this.bodyProps(indent, block.align) + extra, this.runs(runs), anchor)
          return
        }
        case 'heading':
          this.para(
            `${this.bodyProps(false, block.align)}\\keepn\\b\\sb240\\sa120${extra}`,
            this.runs(block.runs),
            anchor
          )
          return
        case 'quote':
          this.blocks(block.blocks, anchor ?? '', matter, '\\li720\\ri720\\fi0')
          return
        case 'separator':
          this.separator(block.separator)
      }
    })
  }

  private generated(page: GeneratedPage): void {
    const centre = `${this.bodyProps(false, 'center')}`
    const big = (factor: number): string => `\\fs${Math.round(this.size * factor)}`
    switch (page.kind) {
      case 'titlePage':
        this.para(`${centre}\\sb2880\\sa240${big(2.2)}`, rtfText(page.title))
        if (page.subtitle) this.para(`${centre}\\i${big(1.2)}`, rtfText(page.subtitle))
        if (page.series) this.para(centre, rtfText(page.series))
        if (page.author) this.para(`${centre}\\sb720${big(1.2)}`, rtfText(page.author))
        if (page.publisher) this.para(`${centre}\\sb2880${big(0.9)}`, rtfText(page.publisher))
        return
      case 'manuscriptTitle': {
        const { pageSetup } = this.format
        const { width } = pageDimensions(pageSetup)
        const right = twIn(
          width - pageSetup.margins.inside - pageSetup.margins.outside - pageSetup.gutter
        )
        const [firstLine = '', ...rest] = page.contact
        this.para(
          `\\fi0\\ql\\tqr\\tx${right}`,
          `${rtfText(firstLine)}\\tab ${rtfText(page.wordCount)}`
        )
        for (const line of rest) this.para('\\fi0\\ql', rtfText(line))
        this.para(`${centre}\\sb3600`, rtfText(page.title))
        if (page.byline) this.para(centre, rtfText(page.byline))
        return
      }
      case 'copyright':
        for (const line of page.lines) this.para(`\\fi0\\ql\\sa120${big(0.85)}`, rtfText(line))
        return
      case 'dedication':
        page.paragraphs.forEach((line, index) =>
          this.para(`${centre}\\i${index === 0 ? '\\sb2880' : ''}`, rtfText(line))
        )
        return
      case 'epigraph':
        page.paragraphs.forEach((line, index) =>
          this.para(`\\fi0\\li720\\ri720\\i${index === 0 ? '\\sb2160' : ''}`, rtfText(line))
        )
        if (page.source) this.para('\\fi0\\li720\\ri720\\qr', rtfText(`— ${page.source}`))
        return
      case 'toc':
        this.para(`${centre}\\sb1440\\sa480${big(1.4)}`, rtfText(page.title))
        for (const entry of page.entries)
          this.para(
            `\\fi0\\ql\\sa80${entry.level !== 'part' && entry.inPart ? '\\li360' : ''}`,
            rtfText(entry.label)
          )
        return
      case 'aboutAuthor':
        this.para(`${centre}\\sb1440\\sa480${big(1.4)}`, rtfText(page.title))
        for (const line of page.paragraphs) this.para(this.bodyProps(false, null), rtfText(line))
        return
      case 'alsoBy':
        this.para(`${centre}\\sb1440\\sa480${big(1.4)}`, rtfText(page.title))
        for (const title of page.titles)
          this.para(centre, this.runs([plainRun(title, { italic: true })]))
    }
  }
}

/** The compiled book as an RTF document. */
export function renderRtf(book: CompiledBook): string {
  return new RtfWriter(book).write()
}
