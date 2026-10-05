import type { ExportFormatting } from '@shared/bookExport'
import { startsPage, type BookBlock, type BookUnit, type Inline } from './model'
import { escapeXml } from './xml'

/**
 * The HTML the export writes (F-12.1): the print page PDF is made from, and the XHTML fragments
 * the EPUB's chapter files hold. One writer for both, so a scene reads the same in each; the
 * XHTML flavour self-closes its line breaks.
 */

export const FONT_STACKS: Record<ExportFormatting['font'], string> = {
  serif: "Georgia, 'Times New Roman', serif",
  sans: 'Arial, Helvetica, sans-serif'
}

export interface HtmlFlavour {
  xhtml: boolean
  sceneBreak: string
  chapterNewPage: boolean
}

function inlineHtml(runs: readonly Inline[], xhtml: boolean): string {
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
    out += text
  }
  return out
}

/** The element's class attribute: alignment other than the default, and a page break. */
function classAttr(names: readonly string[]): string {
  return names.length > 0 ? ` class="${names.join(' ')}"` : ''
}

function blockHtml(block: BookBlock, flavour: HtmlFlavour, newPage: boolean): string {
  const classes = newPage ? ['page-break'] : []
  switch (block.kind) {
    case 'title': {
      const tag = block.level === 'part' ? 'h1' : 'h2'
      return `<${tag}${classAttr([block.level, ...classes])}>${escapeXml(block.text)}</${tag}>`
    }
    case 'heading': {
      const tag = `h${block.level + 2}`
      const align = block.align !== null && block.align !== 'left' ? [`align-${block.align}`] : []
      return `<${tag}${classAttr([...align, ...classes])}>${inlineHtml(block.runs, flavour.xhtml)}</${tag}>`
    }
    case 'paragraph': {
      const align = block.align !== null && block.align !== 'left' ? [`align-${block.align}`] : []
      return `<p${classAttr([...align, ...classes])}>${inlineHtml(block.runs, flavour.xhtml)}</p>`
    }
    case 'quote':
      return `<blockquote${classAttr(classes)}>${block.blocks
        .map((inner) => blockHtml(inner, flavour, false))
        .join('')}</blockquote>`
    case 'sceneBreak':
      return `<div${classAttr(['scene-break', ...classes])}>${escapeXml(flavour.sceneBreak)}</div>`
  }
}

/**
 * The units' blocks as HTML elements, one per line. Page breaks are classes (`page-break`) on the
 * element that starts a page, so the print page and an EPUB file share the markup.
 */
export function unitsHtml(units: readonly BookUnit[], flavour: HtmlFlavour): string {
  const lines: string[] = []
  units.forEach((unit, unitIndex) => {
    unit.blocks.forEach((block, blockIndex) => {
      const newPage = startsPage(unitIndex, blockIndex, block, flavour.chapterNewPage)
      lines.push(blockHtml(block, flavour, newPage))
    })
  })
  return lines.join('\n')
}

/**
 * The book's style: font, size, line height, first-line indents (none after a title, heading, or
 * scene break, and none on centred or right-aligned text), and centred scene breaks. `print`
 * adds the page size, margins, and page breaks; an EPUB leaves size and pages to the reader.
 */
export function bookCss(formatting: ExportFormatting, print: boolean): string {
  const rules = [
    `body { font-family: ${FONT_STACKS[formatting.font]};${print ? ` font-size: ${formatting.fontSize}pt;` : ''} line-height: ${formatting.lineSpacing}; margin: 0; }`,
    'p { margin: 0; }',
    formatting.indentParagraphs ? 'p + p { text-indent: 1.5em; }' : 'p + p { margin-top: 0.75em; }',
    '.align-center { text-align: center; text-indent: 0; }',
    '.align-right { text-align: right; text-indent: 0; }',
    '.align-justify { text-align: justify; }',
    'h1, h2, h3, h4, h5 { font-weight: bold; margin: 1.5em 0 1em; line-height: 1.2; }',
    'h1, h2 { text-align: center; }',
    'h1 { font-size: 1.8em; } h2 { font-size: 1.4em; } h3 { font-size: 1.2em; }',
    'h4 { font-size: 1.1em; } h5 { font-size: 1em; }',
    'blockquote { margin: 0.75em 2em; }',
    '.scene-break { text-align: center; margin: 1em 0; }',
    'code { font-family: "Courier New", Courier, monospace; }'
  ]
  if (print) {
    const size = formatting.pageSize === 'a4' ? 'A4' : 'letter'
    rules.push(
      `@page { size: ${size}; margin: 1in; }`,
      '.page-break { break-before: page; }',
      'h1, h2, h3, h4, h5 { break-after: avoid; }'
    )
  }
  return rules.join('\n')
}

/** The whole print page PDF is made from: one HTML document with its style inline. */
export function renderPrintHtml(
  units: readonly BookUnit[],
  formatting: ExportFormatting,
  title: string
): string {
  const body = unitsHtml(units, {
    xhtml: false,
    sceneBreak: formatting.sceneBreak,
    chapterNewPage: formatting.chapterNewPage
  })
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeXml(title)}</title>`,
    `<style>\n${bookCss(formatting, true)}\n</style>`,
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
    ''
  ].join('\n')
}
