import { blockFromRuns, isBreakGlyph, textRun, type ImportBlock, type ImportRun } from './blocks'

/**
 * Manuscript import (F-12.2): the Markdown and plain-text readers. Both work line by line and
 * differ in two things only — Markdown knows `#` headings and `*`/`_` emphasis, plain text knows
 * neither — so the line loop is shared and the paragraph shape is decided per format.
 */

/** Written as a code point rather than a literal so the character never sits in this file. */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff)

/** Line endings are normalised once, here, so every later rule can assume `\n`. */
function lines(text: string): string[] {
  const body = text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text
  return body.replace(/\r\n?/g, '\n').split('\n')
}

const ATX_HEADING = /^(#{1,6})\s+(.*)$/

/**
 * Markdown: ATX headings become headings, a blank line ends a paragraph, and consecutive
 * non-blank lines join into one paragraph (CommonMark's soft line breaks), joined by a space.
 * Emphasis is read at one level (`**bold**`, `_italic_`); unmatched markers stay as typed.
 */
export function readMarkdown(text: string): ImportBlock[] {
  const blocks: ImportBlock[] = []
  let paragraph: string[] = []
  const flush = (): void => {
    if (paragraph.length === 0) return
    blocks.push(blockFromRuns(parseEmphasis(paragraph.join(' '))))
    paragraph = []
  }
  for (const line of lines(text)) {
    const trimmed = line.trim()
    const heading = ATX_HEADING.exec(trimmed)
    // `### Title ###` is the closed form; a heading with nothing left is a glyph line, not a title.
    const title = heading ? (heading[2] ?? '').replace(/\s*#*$/, '').trim() : ''
    if (heading && title.length > 0) {
      flush()
      blocks.push({ type: 'heading', level: (heading[1] ?? '#').length, text: title })
      continue
    }
    if (trimmed.length === 0) {
      flush()
      blocks.push({ type: 'blank' })
      continue
    }
    if (isBreakGlyph(trimmed) || (heading && title.length === 0)) {
      flush()
      blocks.push({ type: 'break' })
      continue
    }
    paragraph.push(trimmed)
  }
  flush()
  return blocks
}

/**
 * Plain text: a hard-wrapped file (every line wrapped at a fixed column, paragraphs separated by
 * blank lines) joins its lines back into paragraphs; a file with one long line per paragraph
 * keeps one paragraph per line. An indented line always starts a new paragraph either way. No
 * marks: a `.txt` has none to read.
 */
export function readPlainText(text: string): ImportBlock[] {
  const all = lines(text)
  const wrapped = looksHardWrapped(all)
  const blocks: ImportBlock[] = []
  let paragraph: string[] = []
  const flush = (): void => {
    if (paragraph.length === 0) return
    blocks.push(blockFromRuns([textRun(paragraph.join(' '))]))
    paragraph = []
  }
  for (const line of all) {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      flush()
      blocks.push({ type: 'blank' })
      continue
    }
    if (isBreakGlyph(trimmed)) {
      flush()
      blocks.push({ type: 'break' })
      continue
    }
    if (isIndented(line)) flush()
    paragraph.push(trimmed)
    if (!wrapped) flush()
  }
  flush()
  return blocks
}

/** A tab or two spaces at the start is the author's paragraph indent, so the line opens one. */
function isIndented(line: string): boolean {
  return line.startsWith('\t') || line.startsWith('  ')
}

/**
 * Whether the file was written with hard line wrapping: nearly every line is short enough to be a
 * wrap rather than a paragraph (90th percentile at most 100 characters) and the file uses blank
 * lines at all. The percentile, not the mean, so one long line does not decide the file.
 */
export function looksHardWrapped(all: readonly string[]): boolean {
  const lengths = all
    .map((line) => line.trim().length)
    .filter((length) => length > 0)
    .sort((a, b) => a - b)
  if (lengths.length === 0) return false
  if (!all.some((line) => line.trim().length === 0)) return false
  const index = Math.min(lengths.length - 1, Math.max(0, Math.ceil(lengths.length * 0.9) - 1))
  return (lengths[index] ?? 0) <= 100
}

const MARKERS = new Set(['*', '_'])

/**
 * Markdown emphasis, one level of nesting: `**bold**`, `__bold__`, `*italic*`, `_italic_`. A
 * marker only opens when text follows it and only closes when text precedes it, and `_` never
 * opens or closes inside a word, so `snake_case_names` survive. An unmatched marker is text.
 */
export function parseEmphasis(text: string): ImportRun[] {
  const runs: ImportRun[] = []
  let plain = ''
  const flush = (): void => {
    if (plain.length > 0) runs.push(textRun(plain))
    plain = ''
  }
  let index = 0
  while (index < text.length) {
    const char = text[index] ?? ''
    if (MARKERS.has(char)) {
      const marker = text[index + 1] === char ? char + char : char
      const from = index + marker.length
      const end = canOpen(text, index, marker) ? findCloser(text, from, marker) : -1
      if (end >= 0) {
        flush()
        const strong = marker.length === 2
        for (const run of parseEmphasis(text.slice(from, end))) {
          runs.push(
            run.kind === 'hardBreak'
              ? run
              : textRun(run.text, {
                  bold: run.bold || strong,
                  italic: run.italic || !strong
                })
          )
        }
        index = end + marker.length
        continue
      }
    }
    plain += char
    index += 1
  }
  flush()
  return runs
}

const WORD_CHARACTER = /[\p{L}\p{N}]/u

function canOpen(text: string, index: number, marker: string): boolean {
  const next = text[index + marker.length]
  if (next === undefined || /\s/.test(next)) return false
  if (marker.startsWith('_') && WORD_CHARACTER.test(text[index - 1] ?? ' ')) return false
  return true
}

function findCloser(text: string, from: number, marker: string): number {
  for (let index = from; index <= text.length - marker.length; index += 1) {
    if (!text.startsWith(marker, index)) continue
    if (index === from) continue
    // A doubled marker is never half a single one: `*a**b*` closes at the last `*`, not the pair.
    if (marker.length === 1 && text[index + 1] === marker) continue
    if (/\s/.test(text[index - 1] ?? ' ')) continue
    if (marker.startsWith('_') && WORD_CHARACTER.test(text[index + marker.length] ?? ' ')) continue
    return index
  }
  return -1
}
