import type { Separator } from '@shared/compileFormat'
import type {
  BookItem,
  CompiledBook,
  ContentBlock,
  GeneratedPage,
  Inline,
  Run
} from '@shared/compileModel'

/**
 * The Markdown writer (F-12.1, Compile v2): CommonMark with `~~strike~~`. Part headings are `#`,
 * chapter-level headings `##`, scene headings `###`, and an author's own headings move below them
 * (`####` and down); a two-line heading joins its lines with `: `. Paragraphs are separated by a
 * blank line, a hard break is two trailing spaces, underline and small caps print as plain text
 * (Markdown has neither), and alignment and page layout do not apply. A scene-break text sits on
 * its own line, a blank-line break is a non-breaking space paragraph, and a page break is a
 * thematic break (`---`). Generated pages print as plain paragraphs under their headings; notes
 * print after their text as a `> **Note**` quote.
 */

type Emphasis = 'bold' | 'italic' | 'strike'
const EMPHASIS_ORDER: readonly Emphasis[] = ['bold', 'italic', 'strike']
const DELIMITER: Record<Emphasis, string> = { bold: '**', italic: '*', strike: '~~' }

/** Characters that would read as Markdown anywhere in a line. */
function escapeInline(text: string): string {
  return text.replace(/[\\*_`[\]]/g, (char) => `\\${char}`)
}

/** Escapes what would make a line a heading, quote, list item, or rule. */
function escapeLineStart(line: string): string {
  const trimmed = line.replace(/^\s+/, '')
  if (/^[#>+-]/.test(trimmed)) return `\\${trimmed}`
  return trimmed.replace(/^(\d+)([.)])/, '$1\\$2')
}

/** A code span whose fence is longer than any backtick run inside it. */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(longest + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

/**
 * Runs as Markdown with emphasis that opens and closes around whole stretches: a delimiter never
 * sits against the inside of whitespace (CommonMark would print it literally), and closing one
 * mark closes and reopens the ones opened after it so the nesting stays valid.
 */
function inlineMarkdown(runs: readonly Inline[]): string {
  let out = ''
  const open: Emphasis[] = []
  // Whitespace held back until we know whether a delimiter closes before it.
  let pending = ''
  const closeFrom = (index: number): void => {
    for (const mark of open.slice(index).reverse()) out += DELIMITER[mark]
    open.length = index
  }
  const want = (run: Run): Emphasis[] => EMPHASIS_ORDER.filter((mark) => run[mark])
  for (const run of runs) {
    if (run.kind === 'hardBreak') {
      closeFrom(0)
      pending = ''
      out += '  \n'
      continue
    }
    const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(run.text)
    const [, lead = '', core = '', trail = ''] = match ?? []
    if (core.length === 0) {
      pending += run.text
      continue
    }
    const marks = want(run)
    const keep = open.findIndex((mark) => !marks.includes(mark))
    if (keep !== -1) closeFrom(keep)
    out += pending + lead
    pending = trail
    for (const mark of marks) {
      if (!open.includes(mark)) {
        out += DELIMITER[mark]
        open.push(mark)
      }
    }
    out += run.code ? codeSpan(core) : escapeInline(core)
  }
  closeFrom(0)
  return out + pending
}

/** Each line escaped at its start; trailing spaces of a hard break kept. */
function paragraphText(runs: readonly Inline[]): string {
  return inlineMarkdown(runs)
    .split('\n')
    .map((line) => escapeLineStart(line))
    .join('\n')
}

/**
 * The scene-break text on its own line, escaped so it never reads as a heading or list item.
 * Asterisks stay: `***` reads as a rule, which is what a scene break is.
 */
function sceneBreakLine(text: string): string {
  return escapeLineStart(text.trim().replace(/[\\_`[\]]/g, (char) => `\\${char}`))
}

/** A heading's text on one line, a trailing `#` run escaped so it is not a closing sequence. */
function headingLine(text: string): string {
  return text
    .replace(/\s*\n\s*/g, ' ')
    .trim()
    .replace(/(#+)$/, '\\$1')
}

function separatorMarkdown(separator: Separator): string {
  switch (separator.kind) {
    case 'text':
      return sceneBreakLine(separator.text)
    case 'blankLine':
      return '&nbsp;'
    case 'pageBreak':
      return '---'
  }
}

function blockMarkdown(block: ContentBlock): string {
  switch (block.kind) {
    case 'heading':
      return `${'#'.repeat(block.level + 3)} ${headingLine(inlineMarkdown(block.runs))}`
    case 'paragraph':
      return paragraphText(block.runs)
    case 'quote':
      return quoted(block.blocks.map(blockMarkdown).join('\n\n'))
    case 'separator':
      return separatorMarkdown(block.separator)
  }
}

function quoted(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n')
}

const plainLine = (text: string): string => escapeLineStart(escapeInline(text))

function generatedMarkdown(page: GeneratedPage): string[] {
  switch (page.kind) {
    case 'titlePage':
      return [
        `# ${headingLine(escapeInline(page.title))}`,
        page.subtitle ? `*${escapeInline(page.subtitle)}*` : '',
        page.series ? plainLine(page.series) : '',
        page.author ? plainLine(`by ${page.author}`) : '',
        page.publisher ? plainLine(page.publisher) : ''
      ].filter(Boolean)
    case 'manuscriptTitle':
      return [
        [...page.contact, page.wordCount].map(plainLine).join('  \n'),
        `# ${headingLine(escapeInline(page.title))}`,
        page.byline ? plainLine(page.byline) : ''
      ].filter(Boolean)
    case 'copyright':
      return [page.lines.map(plainLine).join('  \n')]
    case 'dedication':
      return page.paragraphs.map((p) => `*${escapeInline(p)}*`)
    case 'epigraph':
      return [
        quoted(
          [
            ...page.paragraphs.map(plainLine),
            ...(page.source ? [plainLine(`— ${page.source}`)] : [])
          ].join('\n\n')
        )
      ]
    case 'toc':
      return [
        `## ${headingLine(escapeInline(page.title))}`,
        page.entries
          .map((e) => `${e.level !== 'part' && e.inPart ? '  ' : ''}- ${escapeInline(e.label)}`)
          .join('\n')
      ]
    case 'aboutAuthor':
      return [`## ${headingLine(escapeInline(page.title))}`, ...page.paragraphs.map(plainLine)]
    case 'alsoBy':
      return [
        `## ${headingLine(escapeInline(page.title))}`,
        page.titles.map((t) => `- *${escapeInline(t)}*`).join('\n')
      ]
  }
}

const SECTION_HASHES = { part: '#', chapter: '##', chapterScene: '##', scene: '###' } as const

function itemMarkdown(item: BookItem): string[] {
  switch (item.kind) {
    case 'page':
      return generatedMarkdown(item.page)
    case 'matter':
    case 'text':
      return item.blocks.map(blockMarkdown)
    case 'section':
      return item.heading === null
        ? []
        : [
            `${SECTION_HASHES[item.level]} ${headingLine(escapeInline(item.heading.lines.join(': ')))}`
          ]
    case 'separator':
      return [separatorMarkdown(item.separator)]
    case 'synopsis':
      return [`*${escapeInline(item.text)}*`]
    case 'note':
      return [quoted(['**Note**', ...item.blocks.map(blockMarkdown)].join('\n\n'))]
  }
}

/** The compiled book as Markdown. */
export function renderMarkdown(book: CompiledBook): string {
  return `${book.items.flatMap(itemMarkdown).join('\n\n')}\n`
}
