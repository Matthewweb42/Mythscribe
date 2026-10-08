import type { Separator } from '@shared/compileFormat'
import type { BookItem, CompiledBook, ContentBlock, GeneratedPage } from '@shared/compileModel'
import { itemBreak } from '@shared/compilePages'
import { runsText } from './inlines'

/**
 * The plain text writer (Compile v2, CV2): UTF-8, LF line endings. Paragraphs are separated by a
 * blank line, a hard break is a line break, headings print their lines as compiled (upper case
 * included; small caps and every other style drop away), a scene break prints its text (a blank
 * line or a page break prints an empty line), and anything that starts a page is set off by an
 * extra blank line. Notes print after their text as `[Note] …`; a quote is indented four spaces.
 */

function blockLines(block: ContentBlock): string[] {
  switch (block.kind) {
    case 'paragraph':
    case 'heading':
      return [runsText(block.runs)]
    case 'quote':
      return block.blocks.flatMap(blockLines).map((p) =>
        p
          .split('\n')
          .map((line) => `    ${line}`)
          .join('\n')
      )
    case 'separator':
      return [separatorText(block.separator)]
  }
}

function separatorText(separator: Separator): string {
  return separator.kind === 'text' ? separator.text : ''
}

function generatedLines(page: GeneratedPage): string[] {
  switch (page.kind) {
    case 'titlePage':
      return [
        page.title,
        page.subtitle,
        page.series,
        page.author ? `by ${page.author}` : '',
        page.publisher
      ].filter(Boolean)
    case 'manuscriptTitle':
      return [
        [...page.contact, page.wordCount].join('\n'),
        [page.title, page.byline].filter(Boolean).join('\n')
      ]
    case 'copyright':
      return [page.lines.join('\n')]
    case 'dedication':
      return page.paragraphs
    case 'epigraph':
      return [...page.paragraphs, ...(page.source ? [`— ${page.source}`] : [])]
    case 'toc':
      return [
        page.title,
        page.entries
          .map((e) => `${e.level !== 'part' && e.inPart ? '  ' : ''}${e.label}`)
          .join('\n')
      ]
    case 'aboutAuthor':
      return [page.title, ...page.paragraphs]
    case 'alsoBy':
      return [page.title, page.titles.join('\n')]
  }
}

function itemLines(item: BookItem): string[] {
  switch (item.kind) {
    case 'page':
      return generatedLines(item.page)
    case 'matter':
    case 'text':
      return item.blocks.flatMap(blockLines)
    case 'section':
      return item.heading === null ? [] : [item.heading.lines.join('\n')]
    case 'separator':
      return [separatorText(item.separator)]
    case 'synopsis':
      return [item.text]
    case 'note':
      return item.blocks.flatMap(blockLines).map((p, i) => (i === 0 ? `[Note] ${p}` : p))
  }
}

/** The compiled book as plain text. */
export function renderText(book: CompiledBook): string {
  const chunks: string[] = []
  book.items.forEach((item, index) => {
    const lines = itemLines(item)
    if (index > 0 && itemBreak(item) !== 'none') chunks.push('')
    chunks.push(...lines)
  })
  return `${chunks.join('\n\n').replace(/\n{4,}/g, '\n\n\n')}\n`
}
