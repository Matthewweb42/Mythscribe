import type { BookBlock, BookUnit, Inline, Run } from './model'

/**
 * The Markdown export (F-12.1): CommonMark with `~~strike~~`. Part titles are `#`, chapter titles
 * `##`, and an author's own headings move below them (`###` and down). Paragraphs are separated by
 * a blank line, a hard break is two trailing spaces, underline prints as plain text (Markdown has
 * none), alignment and formatting choices do not apply, and the scene-break text sits on its own
 * line. Matter units print their text only, a blank line apart like everything else.
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

function blockMarkdown(block: BookBlock, sceneBreak: string): string {
  switch (block.kind) {
    case 'title': {
      const text = headingLine(escapeInline(block.text))
      return `${block.level === 'part' ? '#' : '##'} ${text}`
    }
    case 'heading':
      return `${'#'.repeat(block.level + 2)} ${headingLine(inlineMarkdown(block.runs))}`
    case 'paragraph':
      return paragraphText(block.runs)
    case 'quote':
      return block.blocks
        .map((inner) => blockMarkdown(inner, sceneBreak))
        .join('\n\n')
        .split('\n')
        .map((line) => (line.length > 0 ? `> ${line}` : '>'))
        .join('\n')
    case 'sceneBreak':
      return sceneBreakLine(sceneBreak)
  }
}

export function renderMarkdown(units: readonly BookUnit[], sceneBreak: string): string {
  const parts: string[] = []
  for (const unit of units) {
    for (const block of unit.blocks) parts.push(blockMarkdown(block, sceneBreak))
  }
  return `${parts.join('\n\n')}\n`
}
