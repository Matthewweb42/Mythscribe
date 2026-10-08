import type { ContentBlock, Inline, Run } from '@shared/compileModel'

/**
 * Run helpers for the writers that cannot style a first line or a first letter with CSS (DOCX,
 * ODT, RTF): the drop cap's letter split off its paragraph, and an approximate small-caps first
 * line. Pure.
 */

/** About one printed line of a book page, for `smallCapsLine` where no format can measure it. */
export const SMALL_CAPS_LINE_CHARS = 40

/**
 * The runs with small caps up to the first word end at or after `chars` characters (the
 * `smallCapsLine` opening in a format with no first-line style; decided by Claude, unconfirmed).
 */
export function smallCapsLead(runs: readonly Inline[], chars = SMALL_CAPS_LINE_CHARS): Inline[] {
  const out: Inline[] = []
  let seen = 0
  let done = false
  for (const run of runs) {
    if (done || run.kind !== 'text') {
      if (run.kind === 'hardBreak') done = true
      out.push(run)
      continue
    }
    let cut = run.text.length
    for (let i = 0; i < run.text.length; i++) {
      if (seen + i >= chars && /\s/u.test(run.text[i] ?? '')) {
        cut = i
        break
      }
    }
    seen += run.text.length
    if (cut === run.text.length) {
      out.push({ ...run, smallCaps: true })
    } else {
      done = true
      if (cut > 0) out.push({ ...run, text: run.text.slice(0, cut), smallCaps: true })
      out.push({ ...run, text: run.text.slice(cut) })
    }
  }
  return out
}

/** Opening punctuation (quotes, brackets, dashes) then one letter or digit. */
const DROP_CAP = /^[\p{Pi}\p{Ps}\p{Pd}"'‘“]*[\p{L}\p{N}]/u

/**
 * The drop cap of a paragraph: its first letter (with any opening quote) in the first run's
 * marks, and the runs after it. Null when the paragraph does not start with a letter or digit.
 */
export function splitDropCap(runs: readonly Inline[]): { cap: Run; rest: Inline[] } | null {
  const first = runs[0]
  if (first?.kind !== 'text') return null
  const match = DROP_CAP.exec(first.text)
  if (match === null) return null
  const cap: Run = { ...first, text: match[0] }
  const tail = first.text.slice(match[0].length)
  const rest: Inline[] =
    tail.length > 0 ? [{ ...first, text: tail }, ...runs.slice(1)] : runs.slice(1)
  return { cap, rest }
}

/** The plain text of runs, a hard break as a newline. */
export function runsText(runs: readonly Inline[]): string {
  return runs.map((run) => (run.kind === 'text' ? run.text : '\n')).join('')
}

/**
 * Blocks as plain paragraphs of runs (comment bodies): headings and quoted paragraphs as
 * paragraphs, a separator as its text (a blank or page-break separator as an empty paragraph).
 */
export function flatParagraphs(blocks: readonly ContentBlock[]): Inline[][] {
  return blocks.flatMap((block): Inline[][] => {
    switch (block.kind) {
      case 'paragraph':
      case 'heading':
        return [block.runs]
      case 'quote':
        return flatParagraphs(block.blocks)
      case 'separator':
        return [block.separator.kind === 'text' ? [plainRun(block.separator.text)] : []]
    }
  })
}

/** A plain run. */
export function plainRun(text: string, marks: Partial<Run> = {}): Run {
  return {
    kind: 'text',
    text,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    code: false,
    smallCaps: false,
    ai: false,
    ...marks
  }
}
