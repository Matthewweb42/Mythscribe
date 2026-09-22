import { IMPORTED_ORIGIN, PARAGRAPH_ORIGIN_ATTR } from '@shared/provenance'
import type { TiptapNodeT } from '@shared/tiptap'

/**
 * Manuscript import (F-12.2), the intermediate model. Every reader — DOCX, Markdown, plain text —
 * produces the same flat list of blocks, and `structure.ts` alone turns that list into the draft
 * the author reviews. One owner for what a paragraph, a blank line, and a scene-break glyph are,
 * so the three readers cannot disagree about them.
 *
 * Blanks survive the readers on purpose: a run of two or more empty lines is how a manuscript
 * written without glyphs marks a scene break, and only the whole list can tell a run from a
 * single stray empty line (`blankRunsToBreaks`).
 */
export type ImportBlock =
  | { type: 'heading'; level: number; text: string }
  /** A Tiptap `paragraph` node, marks and hard breaks included, already carrying the origin attr. */
  | { type: 'paragraph'; node: TiptapNodeT }
  | { type: 'blank' }
  | { type: 'break' }

/** One piece of a paragraph: a stretch of text with its marks, or a hard break inside the line. */
export type ImportRun =
  { kind: 'text'; text: string; bold: boolean; italic: boolean } | { kind: 'hardBreak' }

export function textRun(text: string, marks: { bold?: boolean; italic?: boolean } = {}): ImportRun {
  return { kind: 'text', text, bold: marks.bold === true, italic: marks.italic === true }
}

export const HARD_BREAK_RUN: ImportRun = { kind: 'hardBreak' }

/**
 * A Tiptap paragraph from runs: empty text runs are dropped, adjacent runs with equal marks are
 * merged (so `<em>a</em><em>b</em>` is one text node), and leading and trailing hard breaks go,
 * because a line that only ends in `<br/>` is not carrying a break into the manuscript. Every
 * paragraph the importer makes carries `attrs.origin = 'imported'` (F-12.2 provenance).
 */
export function paragraphNode(runs: readonly ImportRun[]): TiptapNodeT {
  const content: TiptapNodeT[] = []
  for (const run of trimHardBreaks(runs)) {
    if (run.kind === 'hardBreak') {
      content.push({ type: 'hardBreak' })
      continue
    }
    if (run.text.length === 0) continue
    const previous = content.at(-1)
    if (previous?.type === 'text' && sameMarks(previous, run)) {
      previous.text = `${previous.text ?? ''}${run.text}`
      continue
    }
    content.push(textNode(run))
  }
  return {
    type: 'paragraph',
    attrs: { [PARAGRAPH_ORIGIN_ATTR]: IMPORTED_ORIGIN },
    content
  }
}

function textNode(run: Extract<ImportRun, { kind: 'text' }>): TiptapNodeT {
  const marks = markList(run)
  return marks.length > 0
    ? { type: 'text', text: run.text, marks }
    : { type: 'text', text: run.text }
}

function markList(run: Extract<ImportRun, { kind: 'text' }>): { type: string }[] {
  const marks: { type: string }[] = []
  if (run.bold) marks.push({ type: 'bold' })
  if (run.italic) marks.push({ type: 'italic' })
  return marks
}

function sameMarks(node: TiptapNodeT, run: Extract<ImportRun, { kind: 'text' }>): boolean {
  const bold = node.marks?.some((mark) => mark.type === 'bold') === true
  const italic = node.marks?.some((mark) => mark.type === 'italic') === true
  return bold === run.bold && italic === run.italic
}

function trimHardBreaks(runs: readonly ImportRun[]): ImportRun[] {
  const kept = runs.filter((run) => run.kind === 'hardBreak' || run.text.length > 0)
  let start = 0
  let end = kept.length
  while (start < end && kept[start]?.kind === 'hardBreak') start += 1
  while (end > start && kept[end - 1]?.kind === 'hardBreak') end -= 1
  return kept.slice(start, end)
}

/** The plain text of a run list, a hard break counting as a newline. */
export function runsText(runs: readonly ImportRun[]): string {
  return runs.map((run) => (run.kind === 'hardBreak' ? '\n' : run.text)).join('')
}

const BREAK_CHARS = '*\\-_~#•⁂'
const BREAK_RUN = new RegExp(`^[${BREAK_CHARS}](?:[ \\t]*[${BREAK_CHARS}]){2,}$`)

/**
 * Whether a whole line is a scene-break glyph: `***`, `* * *`, `---`, `___`, `~~~`, `• • •`, any
 * other run of three or more of those characters with spaces between, or a lone `#` or `⁂`. The
 * trimmed line must match entirely, so `--- and then` is prose.
 */
export function isBreakGlyph(text: string): boolean {
  const line = text.trim()
  if (line.length === 0) return false
  if (line === '#' || line === '⁂') return true
  return BREAK_RUN.test(line)
}

/** The block a finished run list becomes: an empty line, a glyph line, or prose. */
export function blockFromRuns(runs: readonly ImportRun[]): ImportBlock {
  const text = runsText(runs)
  if (text.trim().length === 0) return { type: 'blank' }
  if (isBreakGlyph(text)) return { type: 'break' }
  return { type: 'paragraph', node: paragraphNode(runs) }
}

/**
 * Resolves the blank lines: two or more in a row become one scene break, a single one is dropped.
 * A manuscript typed with an empty line between every paragraph would otherwise turn every
 * paragraph into its own scene.
 */
export function blankRunsToBreaks(blocks: readonly ImportBlock[]): ImportBlock[] {
  const resolved: ImportBlock[] = []
  let blanks = 0
  const flush = (): void => {
    if (blanks >= 2) resolved.push({ type: 'break' })
    blanks = 0
  }
  for (const block of blocks) {
    if (block.type === 'blank') {
      blanks += 1
      continue
    }
    flush()
    resolved.push(block)
  }
  flush()
  return resolved
}
