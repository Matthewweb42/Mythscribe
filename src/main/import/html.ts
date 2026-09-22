import {
  blockFromRuns,
  HARD_BREAK_RUN,
  runsText,
  textRun,
  type ImportBlock,
  type ImportRun
} from './blocks'

/**
 * Manuscript import (F-12.2): mammoth's HTML to import blocks. Mammoth emits a small, predictable
 * tag set (headings, paragraphs, list items, table cells, `strong`/`em`, `br`, links, images), so
 * a tokenizer over that set is enough and the app stays free of a DOM or an HTML parser in main.
 * Anything unexpected is forgiven rather than dropped: an unknown tag is ignored and its text
 * kept, because losing a sentence of the author's manuscript is the one unacceptable outcome.
 */

/** Tags that start a block of prose. Everything else is inline, ignored, or a mark. */
const BLOCK_TAGS: ReadonlySet<string> = new Set(['p', 'li', 'td', 'th'])

const HEADING = /^h([1-6])$/

interface BlockState {
  /** The heading level, or null for a paragraph-like block. */
  level: number | null
  runs: ImportRun[]
}

export function htmlToBlocks(html: string): ImportBlock[] {
  const blocks: ImportBlock[] = []
  let current: BlockState | null = null
  let bold = 0
  let italic = 0

  const emit = (state: BlockState): void => {
    if (state.level === null) {
      blocks.push(blockFromRuns(state.runs))
      return
    }
    const text = runsText(state.runs).replace(/\s+/g, ' ').trim()
    if (text.length > 0) blocks.push({ type: 'heading', level: state.level, text })
  }
  // `emitEmpty` separates the two ways a block ends: its own closing tag (an empty `<p></p>` is
  // the blank line mammoth is asked to keep) and another block opening inside it (`<td><p>…`,
  // which must not invent a blank line between the cells).
  const close = (emitEmpty: boolean): void => {
    if (current === null) return
    if (emitEmpty || current.runs.length > 0) emit(current)
    current = null
  }
  const open = (level: number | null): BlockState => {
    close(false)
    const started: BlockState = { level, runs: [] }
    current = started
    return started
  }
  // Text outside any block still belongs to the manuscript, so it opens a paragraph of its own;
  // only whitespace between tags is dropped.
  const addText = (text: string): void => {
    if (current === null && text.trim().length === 0) return
    const target = current ?? open(null)
    target.runs.push(textRun(text, { bold: bold > 0, italic: italic > 0 }))
  }

  for (const token of tokenize(html)) {
    if (token.kind === 'text') {
      addText(decodeEntities(token.text))
      continue
    }
    const name = token.name
    const heading = HEADING.exec(name)
    if (heading) {
      if (token.closing) close(true)
      else open(Number(heading[1]))
      continue
    }
    if (BLOCK_TAGS.has(name)) {
      if (token.closing) close(true)
      else open(null)
      continue
    }
    if (name === 'br') {
      const target = current ?? open(null)
      target.runs.push(HARD_BREAK_RUN)
      continue
    }
    if (name === 'strong' || name === 'b') bold += token.closing ? -1 : 1
    else if (name === 'em' || name === 'i') italic += token.closing ? -1 : 1
    if (bold < 0) bold = 0
    if (italic < 0) italic = 0
  }
  close(true)
  return blocks
}

type HtmlToken = { kind: 'text'; text: string } | { kind: 'tag'; name: string; closing: boolean }

/** `<` that starts a tag name or a closing tag; anything else is literal text. */
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g

function tokenize(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = []
  let index = 0
  TAG.lastIndex = 0
  for (let match = TAG.exec(html); match !== null; match = TAG.exec(html)) {
    if (match.index > index) tokens.push({ kind: 'text', text: html.slice(index, match.index) })
    tokens.push({ kind: 'tag', name: (match[2] ?? '').toLowerCase(), closing: match[1] === '/' })
    index = match.index + match[0].length
  }
  if (index < html.length) tokens.push({ kind: 'text', text: html.slice(index) })
  return tokens
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

/** The entities mammoth writes plus numeric references; an unknown one stays as it was typed. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}
