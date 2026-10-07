import { z } from 'zod'
import { bookSurname, bookTitle, isbnFor, type BookDetails } from './bookDetails'
import { CompiledEntry } from './compile'
import {
  FINAL_OUTPUTS,
  type CompileFormat,
  type CompileOutput,
  type CompileScope,
  type FirstParagraphStyle,
  type FurnitureToken,
  type NumberingStyle,
  type PageBreak,
  type Replacement,
  type SectionLayout,
  type SectionLevel,
  type Separator
} from './compileFormat'
import { INLINE_TAG_NODE_TYPE } from './inlineTags'
import { AI_ORIGIN_MARK } from './provenance'
import { TiptapNode, type TiptapNodeT } from './tiptap'
import { countWords } from './wordCount'

/**
 * The compile model (Compile v2, CV1): one pure function, `compileBook`, turns the project's
 * three sections (`CompileSource`, read once by main's `compileSource`), the include set, Book
 * details, and a `CompileFormat` into a `CompiledBook`: resolved metadata and a flat list of
 * typed `BookItem`s in reading order. Every writer (PDF, DOCX, EPUB, RTF, ODT, HTML, TXT, MD) and
 * the compile window's live preview render that list; none of them reads the tree, numbers a
 * chapter, applies a replacement, or decides what is included. Pure and synchronous, so the
 * renderer can re-run it on every settings change.
 *
 * The reading-order rules are the compiled preview's (`compiledBlocks`, F-3.12): a part or
 * chapter is a section; a scene directly under a part or the manuscript root is a chapter-level
 * section (`chapterScene`, e.g. a prologue); a scene separator sits between scenes that follow
 * one another with no section heading in between; a generic folder prints nothing.
 */

// ---------------------------------------------------------------------------------------------
// Source (crosses IPC as `compile:source`)

/** One node of a section in reading order: the preview's entry plus its synopsis and notes. */
export const CompileNode = CompiledEntry.extend({
  /** The index-card synopsis (F-11.1), '' when none. */
  synopsis: z.string(),
  /** The node's notes (F-3.7); null when none or unreadable. */
  notes: TiptapNode.nullable()
})
export type CompileNode = z.infer<typeof CompileNode>

/** Each section's nodes as a preorder walk, `depth` 0 for the section root's children. */
export const CompileSource = z.object({
  front: z.array(CompileNode),
  manuscript: z.array(CompileNode),
  end: z.array(CompileNode)
})
export type CompileSource = z.infer<typeof CompileSource>

// ---------------------------------------------------------------------------------------------
// Content blocks

/** A stretch of text with the marks a book can print. */
export interface Run {
  kind: 'text'
  text: string
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  code: boolean
  /** Set by the model for a `smallCapsWords` opening; never from the document. */
  smallCaps: boolean
  /** AI-written text (the aiOrigin mark), only when the format keeps AI marks on a non-final output. */
  ai: boolean
}

export interface HardBreak {
  kind: 'hardBreak'
}

export type Inline = Run | HardBreak

export const CONTENT_ALIGNS = ['left', 'center', 'right', 'justify'] as const
export type ContentAlign = (typeof CONTENT_ALIGNS)[number]

/**
 * How a paragraph opens: `none` is a normal body paragraph (indented by the typography);
 * `noIndent`, `dropCap`, and `smallCapsLine` are the first paragraph after a heading or a
 * separator. A `smallCapsWords` opening arrives as `noIndent` with its first words' runs
 * `smallCaps`.
 */
export type Opening = 'none' | 'noIndent' | 'dropCap' | 'smallCapsLine'

export type ContentBlock =
  | { kind: 'paragraph'; runs: Inline[]; align: ContentAlign | null; opening: Opening }
  /** A heading the author set inside a document, 1–3; prints below section headings. */
  | { kind: 'heading'; level: 1 | 2 | 3; runs: Inline[]; align: ContentAlign | null }
  | { kind: 'quote'; blocks: ContentBlock[] }
  /** A scene break the author put inside a document, printed as the format's separator. */
  | { kind: 'separator'; separator: Separator }

export interface ContentOptions {
  /** Tag tokens print as `#name` (else `name`, the token being a word of the sentence). */
  keepTags: boolean
  /** Runs carry `ai` from the aiOrigin mark. */
  keepAiMarks: boolean
  separator: Separator
  /** The format's find-and-replace, applied to every run (`compileReplacements`). */
  replace: (text: string) => string
}

function alignOf(node: TiptapNodeT): ContentAlign | null {
  const value = node.attrs?.textAlign
  return CONTENT_ALIGNS.find((align) => align === value) ?? null
}

function runOf(text: string, node: TiptapNodeT, options: ContentOptions): Run {
  const marks = new Set((node.marks ?? []).map((mark) => mark.type))
  return {
    kind: 'text',
    text: options.replace(text),
    bold: marks.has('bold'),
    italic: marks.has('italic'),
    underline: marks.has('underline'),
    strike: marks.has('strike'),
    code: marks.has('code'),
    smallCaps: false,
    ai: options.keepAiMarks && marks.has(AI_ORIGIN_MARK)
  }
}

/**
 * The inline content of a paragraph or heading. Only bold, italic, underline, strike, and code
 * print; every other mark (the AI-origin mark, tag ranges, anything unknown) is dropped. Unknown
 * inline nodes give their content. A run the replacements empty is dropped.
 */
function inlines(nodes: readonly TiptapNodeT[], options: ContentOptions): Inline[] {
  const out: Inline[] = []
  for (const node of nodes) {
    if (node.type === 'text') {
      if (node.text !== undefined && node.text.length > 0) {
        const run = runOf(node.text, node, options)
        if (run.text.length > 0) out.push(run)
      }
    } else if (node.type === 'hardBreak') {
      out.push({ kind: 'hardBreak' })
    } else if (node.type === INLINE_TAG_NODE_TYPE) {
      const name = node.attrs?.name
      if (typeof name === 'string' && name.length > 0)
        out.push(runOf(options.keepTags ? `#${name}` : name, node, options))
    } else {
      out.push(...inlines(node.content ?? [], options))
    }
  }
  return out
}

const INLINE_TYPES = new Set(['text', 'hardBreak', INLINE_TAG_NODE_TYPE])

/**
 * The blocks of a stored document. An empty paragraph prints nothing (books space paragraphs by
 * style, not by blank lines); inline content found at block level reads as its own paragraph;
 * unknown block nodes give their content. Every paragraph opens `none`; `applyOpenings` sets the
 * first ones.
 */
export function contentBlocks(doc: TiptapNodeT, options: ContentOptions): ContentBlock[] {
  const out: ContentBlock[] = []
  const walk = (nodes: readonly TiptapNodeT[], into: ContentBlock[]): void => {
    let stray: TiptapNodeT[] = []
    const flush = (): void => {
      const runs = inlines(stray, options)
      if (runs.length > 0) into.push({ kind: 'paragraph', runs, align: null, opening: 'none' })
      stray = []
    }
    for (const node of nodes) {
      if (INLINE_TYPES.has(node.type)) {
        stray.push(node)
        continue
      }
      flush()
      if (node.type === 'paragraph') {
        const runs = inlines(node.content ?? [], options)
        if (runs.length > 0)
          into.push({ kind: 'paragraph', runs, align: alignOf(node), opening: 'none' })
      } else if (node.type === 'heading') {
        const runs = inlines(node.content ?? [], options)
        const raw = node.attrs?.level
        const level = raw === 2 || raw === 3 ? raw : 1
        if (runs.length > 0) into.push({ kind: 'heading', level, runs, align: alignOf(node) })
      } else if (node.type === 'blockquote') {
        const blocks: ContentBlock[] = []
        walk(node.content ?? [], blocks)
        if (blocks.length > 0) into.push({ kind: 'quote', blocks })
      } else if (node.type === 'sceneBreak') {
        into.push({ kind: 'separator', separator: options.separator })
      } else {
        walk(node.content ?? [], into)
      }
    }
    flush()
  }
  walk(doc.type === 'doc' ? (doc.content ?? []) : [doc], out)
  return out
}

/** Marks the first `count` words of a paragraph's runs as small caps, splitting a run mid-way. */
function smallCapsWords(runs: readonly Inline[], count: number): Inline[] {
  const out: Inline[] = []
  let words = 0
  let inWord = false
  let done = false
  for (const run of runs) {
    if (done || run.kind !== 'text') {
      if (run.kind === 'hardBreak') done = true
      out.push(run)
      continue
    }
    let cut = run.text.length
    for (let i = 0; i < run.text.length; i++) {
      const space = /\s/u.test(run.text[i] ?? '')
      if (!space && !inWord) {
        if (words === count) {
          cut = i
          break
        }
        words++
      }
      inWord = !space
    }
    if (cut === run.text.length) {
      out.push({ ...run, smallCaps: true })
    } else {
      done = true
      const head = run.text.slice(0, cut)
      if (head.length > 0) out.push({ ...run, text: head, smallCaps: true })
      out.push({ ...run, text: run.text.slice(cut) })
    }
  }
  return out
}

function openParagraph(
  block: Extract<ContentBlock, { kind: 'paragraph' }>,
  style: FirstParagraphStyle,
  firstWords: number
): ContentBlock {
  switch (style) {
    case 'indent':
      return block
    case 'noIndent':
    case 'dropCap':
    case 'smallCapsLine':
      return { ...block, opening: style }
    case 'smallCapsWords':
      return { ...block, opening: 'noIndent', runs: smallCapsWords(block.runs, firstWords) }
  }
}

/** What the next paragraph opens with, or null for a plain paragraph. */
export interface PendingOpening {
  style: FirstParagraphStyle
  firstWords: number
}

/**
 * Sets the opening of the first top-level paragraph (when `pending`) and of the first paragraph
 * after each in-document separator (the scene layout's). Returns the blocks and the opening
 * still pending (none of the blocks was a paragraph).
 */
export function applyOpenings(
  blocks: readonly ContentBlock[],
  pending: PendingOpening | null,
  afterSeparator: PendingOpening
): { blocks: ContentBlock[]; pending: PendingOpening | null } {
  let next = pending
  const out: ContentBlock[] = []
  for (const block of blocks) {
    if (block.kind === 'paragraph' && next !== null) {
      out.push(openParagraph(block, next.style, next.firstWords))
      next = null
    } else {
      out.push(block)
      if (block.kind === 'separator') next = afterSeparator
    }
  }
  return { blocks: out, pending: next }
}

// ---------------------------------------------------------------------------------------------
// Replacements

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The format's enabled find-and-replace rules as one function, applied in order. A plain rule
 * replaces its text literally; a regex rule uses JavaScript replacement syntax (`$1`). A rule
 * whose pattern does not compile (the schema refuses them, so only a hand-edited file) is
 * skipped.
 */
export function compileReplacements(rules: readonly Replacement[]): (text: string) => string {
  const compiled: { pattern: RegExp; replace: Replacement['replace']; literal: boolean }[] = []
  for (const rule of rules) {
    if (!rule.enabled) continue
    try {
      const source = rule.regex ? rule.find : escapeRegExp(rule.find)
      const flags = `gu${rule.caseSensitive ? '' : 'i'}`
      compiled.push({
        pattern: new RegExp(source, flags),
        replace: rule.replace,
        literal: !rule.regex
      })
    } catch {
      // Skipped: see above.
    }
  }
  if (compiled.length === 0) return (text) => text
  return (text) =>
    compiled.reduce(
      (acc, rule) =>
        rule.literal
          ? acc.replace(rule.pattern, () => rule.replace)
          : acc.replace(rule.pattern, rule.replace),
      text
    )
}

// ---------------------------------------------------------------------------------------------
// Numbering and headings

const ONES = [
  'Zero',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen'
]
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function wordsBelowThousand(n: number): string {
  const hundreds = Math.floor(n / 100)
  const rest = n % 100
  const parts: string[] = []
  if (hundreds > 0) parts.push(`${ONES[hundreds]} Hundred`)
  if (rest > 0 || hundreds === 0) {
    if (rest < 20) parts.push(ONES[rest] ?? '')
    else {
      const ten = TENS[Math.floor(rest / 10)] ?? ''
      parts.push(rest % 10 === 0 ? ten : `${ten}-${ONES[rest % 10]}`)
    }
  }
  return parts.join(' ')
}

/** A positive integer in title-case English words: 21 → "Twenty-One", 105 → "One Hundred Five". */
export function numberToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999_999) return String(n)
  if (n < 1000) return wordsBelowThousand(n)
  const thousands = Math.floor(n / 1000)
  const rest = n % 1000
  const head = `${wordsBelowThousand(thousands)} Thousand`
  return rest === 0 ? head : `${head} ${wordsBelowThousand(rest)}`
}

const ROMAN: [number, string][] = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I']
]

/** 1–3999 in upper-case Roman numerals; anything else as digits. */
export function numberToRoman(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 3999) return String(n)
  let rest = n
  let out = ''
  for (const [value, glyph] of ROMAN) {
    while (rest >= value) {
      out += glyph
      rest -= value
    }
  }
  return out
}

/** The number in a numbering style; '' for `none`. */
export function formatNumber(n: number, style: NumberingStyle): string {
  switch (style) {
    case 'none':
      return ''
    case 'words':
      return numberToWords(n)
    case 'digits':
      return String(n)
    case 'roman':
      return numberToRoman(n)
  }
}

/**
 * A section's heading as printed. `label` is prefix + number + suffix (null when unnumbered),
 * `title` the node's title after replacements (null when hidden or blank), `lines` what prints,
 * one or two lines, upper-cased for the `upper` case (small caps is the writer's style), and
 * `plain` the same text joined on one line without the case change (contents entries).
 */
export interface SectionHeading {
  label: string | null
  title: string | null
  lines: string[]
  plain: string
}

/** The heading for a section at `number` (null: not counted), or null when nothing prints. */
export function sectionHeading(
  layout: SectionLayout,
  number: number | null,
  rawTitle: string,
  replace: (text: string) => string = (text) => text
): SectionHeading | null {
  const label =
    layout.numbering !== 'none' && number !== null
      ? `${layout.prefix}${formatNumber(number, layout.numbering)}${layout.suffix}`.trim()
      : null
  const titled = layout.showTitle ? replace(rawTitle).trim() : ''
  const title = titled.length > 0 ? titled : null
  if (label === null && title === null) return null
  const parts = [label, title].filter((p): p is string => p !== null && p.length > 0)
  const plainLines = layout.titleOnNewLine ? parts : [parts.join(' ')]
  const lines = layout.case === 'upper' ? plainLines.map((l) => l.toLocaleUpperCase()) : plainLines
  return { label, title, lines, plain: parts.join(' ') }
}

// ---------------------------------------------------------------------------------------------
// Headers and footers

export type FurnitureSegment =
  { kind: 'text'; text: string } | { kind: 'token'; token: FurnitureToken }

const TOKEN_PATTERN = /\{(author|surname|title|TITLE|chapter|page|wordcount)\}/g

/** A header/footer slot split into text and tokens; an unknown `{word}` stays text. */
export function furnitureSegments(template: string): FurnitureSegment[] {
  const out: FurnitureSegment[] = []
  let last = 0
  for (const match of template.matchAll(TOKEN_PATTERN)) {
    const index = match.index
    if (index > last) out.push({ kind: 'text', text: template.slice(last, index) })
    out.push({ kind: 'token', token: match[1] as FurnitureToken })
    last = index + match[0].length
  }
  if (last < template.length) out.push({ kind: 'text', text: template.slice(last) })
  return out
}

/** A slot with every token filled from `values` (writers pass the page and chapter). */
export function fillFurniture(
  template: string,
  values: Readonly<Record<FurnitureToken, string>>
): string {
  return furnitureSegments(template)
    .map((s) => (s.kind === 'text' ? s.text : values[s.token]))
    .join('')
}

// ---------------------------------------------------------------------------------------------
// The compiled book

export interface BookMetadata {
  title: string
  subtitle: string
  author: string
  surname: string
  /** The contact block's name: the legal name, else the author. */
  legalName: string
  /** The contact block's lines (address, email, …), blank lines dropped. */
  contact: string[]
  series: string
  seriesNumber: string
  isbn: string
  publisher: string
  copyrightYear: string
  rights: string
  edition: string
  language: string
  description: string
  keywords: string[]
  /** The cover's file name under `assets/covers/` when the format includes it, else null. */
  cover: string | null
  /** The printed words of the body (the manuscript, or the one document). */
  bodyWords: number
  /** Standard Manuscript's rounded count: "about 85,000 words". */
  approximateWords: string
}

/** Where an item sits: generated and project front pages, the body, the back pages. */
export type Division = 'front' | 'body' | 'back'

export interface TocEntry {
  /** The section's node id (writers anchor it, e.g. `s-<id>`). */
  id: string
  level: Extract<SectionLevel, 'part' | 'chapter' | 'chapterScene'>
  label: string
  inPart: boolean
}

export type GeneratedPage =
  | {
      kind: 'titlePage'
      title: string
      subtitle: string
      author: string
      series: string
      publisher: string
    }
  /** Standard Manuscript's first page: contact block top left, word count top right, title and byline centred. */
  | { kind: 'manuscriptTitle'; contact: string[]; wordCount: string; title: string; byline: string }
  | { kind: 'copyright'; lines: string[] }
  | { kind: 'dedication'; paragraphs: string[] }
  | { kind: 'epigraph'; paragraphs: string[]; source: string }
  | { kind: 'toc'; title: string; entries: TocEntry[] }
  | { kind: 'aboutAuthor'; title: string; paragraphs: string[] }
  | { kind: 'alsoBy'; title: string; titles: string[] }

/**
 * One item of the book in reading order. `break` says where an item starts (only generated
 * pages, matter units, and sections carry one); writers ignore a break on the very first item
 * and treat `newRecto` as `newPage` where pages have no sides. A section with a break is a
 * chapter opener for `HeadersFooters.hideOnOpeners`; the front division carries no headers or
 * footers.
 */
export type BookItem =
  | { kind: 'page'; division: Division; page: GeneratedPage; break: PageBreak }
  /** One top-level item of the project's front or end matter: its documents' text, no heading. */
  | {
      kind: 'matter'
      division: 'front' | 'back'
      id: string
      title: string
      blocks: ContentBlock[]
      break: PageBreak
    }
  | {
      kind: 'section'
      division: 'body'
      id: string
      level: SectionLevel
      heading: SectionHeading | null
      layout: SectionLayout
      break: PageBreak
      /** A chapter-level section directly inside a part (contents nesting). */
      inPart: boolean
      /** The `{chapter}` header text from here on (the latest chapter-level section's). */
      runningHead: string
    }
  | { kind: 'separator'; division: Division; separator: Separator }
  | { kind: 'text'; division: Division; id: string; blocks: ContentBlock[] }
  | { kind: 'synopsis'; division: 'body'; id: string; text: string }
  /** A node's notes: printed after its text (`inline`) or as a comment on it (`comments`). */
  | {
      kind: 'note'
      division: Division
      id: string
      mode: 'inline' | 'comments'
      blocks: ContentBlock[]
    }

export interface CompiledBook {
  output: CompileOutput
  format: CompileFormat
  metadata: BookMetadata
  items: BookItem[]
  /** Every part and chapter-level section with a heading, in order (also inside the `toc` page). */
  toc: TocEntry[]
  /** Printed words: the body's and the project matter's documents. */
  words: number
}

export interface CompileInput {
  source: CompileSource
  format: CompileFormat
  output: CompileOutput
  details: BookDetails
  projectName: string
  scope: CompileScope
  /** Node ids unticked "Include in compile"; each leaves out its whole subtree. */
  excluded: readonly string[]
}

// ---------------------------------------------------------------------------------------------
// Selection

/**
 * A preorder walk's entries without the excluded subtrees, and (with `only`) kept to the chosen
 * nodes, their descendants, and their ancestors (a chosen chapter keeps its part as a heading).
 */
export function selectEntries<T extends { id: string; depth: number }>(
  entries: readonly T[],
  excluded: ReadonlySet<string>,
  only: ReadonlySet<string> | null = null
): T[] {
  const kept: T[] = []
  let skipBelow: number | null = null
  for (const entry of entries) {
    if (skipBelow !== null && entry.depth > skipBelow) continue
    skipBelow = null
    if (excluded.has(entry.id)) {
      skipBelow = entry.depth
      continue
    }
    kept.push(entry)
  }
  if (only === null) return kept
  const keep = new Array<boolean>(kept.length).fill(false)
  const stack: number[] = []
  let insideDepth: number | null = null
  kept.forEach((entry, index) => {
    while (stack.length > 0 && (kept[stack[stack.length - 1] ?? 0]?.depth ?? 0) >= entry.depth)
      stack.pop()
    if (insideDepth !== null && entry.depth <= insideDepth) insideDepth = null
    if (insideDepth !== null) keep[index] = true
    else if (only.has(entry.id)) {
      keep[index] = true
      insideDepth = entry.depth
      for (const ancestor of stack) keep[ancestor] = true
    }
    stack.push(index)
  })
  return kept.filter((_, index) => keep[index])
}

function printable(node: CompileNode): node is CompileNode & { content: TiptapNodeT } {
  return node.kind === 'document' && node.content !== null && countWords(node.content) > 0
}

/** Shunn's rounded count: to the nearest 100 below 10,000 words, the nearest 1,000 above. */
export function approximateWords(words: number): string {
  if (words <= 0) return 'about 0 words'
  const step = words < 10_000 ? 100 : 1000
  const rounded = Math.max(step, Math.round(words / step) * step)
  return `about ${rounded.toLocaleString('en-US')} words`
}

function paragraphsOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

// ---------------------------------------------------------------------------------------------
// compileBook

interface Builder {
  format: CompileFormat
  content: ContentOptions
  items: BookItem[]
  words: number
}

function pushNotes(b: Builder, node: CompileNode, division: Division): void {
  const mode = b.format.contents.notes
  if (mode === 'none' || node.notes === null) return
  const blocks = contentBlocks(node.notes, b.content)
  if (blocks.length > 0) b.items.push({ kind: 'note', division, id: node.id, mode, blocks })
}

/** The project's front or end matter: one item per top-level child, text only, empty dropped. */
function matterItems(b: Builder, nodes: readonly CompileNode[], division: 'front' | 'back'): void {
  let current: { node: CompileNode; docs: CompileNode[] } | null = null
  const close = (): void => {
    if (current === null) return
    const blocks = current.docs.flatMap((doc) =>
      contentBlocks(doc.content ?? { type: 'doc' }, b.content)
    )
    if (blocks.length > 0) {
      b.items.push({
        kind: 'matter',
        division,
        id: current.node.id,
        title: current.node.title,
        blocks,
        break: 'newPage'
      })
      for (const doc of current.docs) if (doc.content !== null) b.words += countWords(doc.content)
    }
    for (const node of [current.node, ...current.docs]) pushNotes(b, node, division)
  }
  for (const node of nodes) {
    if (node.depth === 0) {
      close()
      current = { node, docs: [] }
    }
    if (printable(node)) current?.docs.push(node)
  }
  close()
}

/** The body: sections, separators, text, synopses, and notes. Returns the body's word count. */
function bodyItems(b: Builder, nodes: readonly CompileNode[]): number {
  const { format, items } = b
  const { sections, contents } = format
  const withText = contents.body !== 'synopsis'
  const withSynopsis = contents.body !== 'text'
  const sceneOpening: PendingOpening = {
    style: sections.scene.firstParagraph,
    firstWords: sections.scene.firstWords
  }
  let words = 0
  let chapterNumber = 0
  let partNumber = 0
  let sceneNumber = 0
  let runningHead = ''
  // True once body text has printed since the last section heading.
  let afterBody = false
  let pendingSeparator = false
  let pending: PendingOpening | null = null
  const levelAt: CompileNode['level'][] = []

  const flushSeparator = (): void => {
    if (!pendingSeparator) return
    pendingSeparator = false
    items.push({ kind: 'separator', division: 'body', separator: format.sceneSeparator })
    pending = sceneOpening
  }

  const pushSection = (
    node: CompileNode,
    level: SectionLevel,
    number: number | null,
    inPart: boolean
  ): void => {
    const layout = sections[level]
    const heading = sectionHeading(layout, number, node.title, b.content.replace)
    if (level === 'chapter' || level === 'chapterScene')
      runningHead = heading?.title ?? heading?.label ?? node.title
    else if (level === 'scene' && heading === null && layout.pageBreak === 'none') return
    if (level === 'scene') {
      if (layout.pageBreak === 'none') flushSeparator()
      else pendingSeparator = false
    }
    items.push({
      kind: 'section',
      division: 'body',
      id: node.id,
      level,
      heading,
      layout,
      break: layout.pageBreak,
      inPart,
      runningHead
    })
    pending = { style: layout.firstParagraph, firstWords: layout.firstWords }
  }

  for (const node of nodes) {
    levelAt[node.depth] = node.level
    const parentLevel = node.depth === 0 ? 'root' : levelAt[node.depth - 1]
    const chapterLevelScene =
      node.level === 'scene' && (parentLevel === 'root' || parentLevel === 'part')
    if (node.level === 'part') {
      partNumber++
      pendingSeparator = false
      afterBody = false
      pushSection(node, 'part', partNumber, false)
    } else if (node.level === 'chapter' || chapterLevelScene) {
      const level: SectionLevel = node.level === 'chapter' ? 'chapter' : 'chapterScene'
      const counted = level === 'chapter' || sections.chapterScene.numbering !== 'none'
      if (counted) chapterNumber++
      pendingSeparator = false
      afterBody = false
      pushSection(node, level, counted ? chapterNumber : null, parentLevel === 'part')
    } else if (node.level === 'scene' || node.kind === 'document') {
      if (afterBody) pendingSeparator = true
      afterBody = false
      if (node.level === 'scene') {
        sceneNumber++
        pushSection(node, 'scene', sceneNumber, false)
      }
    } else {
      // A generic folder prints nothing of its own.
      continue
    }

    if (withSynopsis && node.synopsis.trim().length > 0) {
      flushSeparator()
      items.push({
        kind: 'synopsis',
        division: 'body',
        id: node.id,
        text: b.content.replace(node.synopsis.trim())
      })
    }
    if (withText && printable(node)) {
      flushSeparator()
      const opened = applyOpenings(contentBlocks(node.content, b.content), pending, sceneOpening)
      pending = opened.pending
      items.push({ kind: 'text', division: 'body', id: node.id, blocks: opened.blocks })
      words += countWords(node.content)
      // Only text calls for a separator; synopses (the outline) sit under their headings.
      afterBody = true
    }
    pushNotes(b, node, 'body')
  }
  return words
}

function generatedFront(
  format: CompileFormat,
  meta: BookMetadata,
  details: BookDetails
): BookItem[] {
  const { matter, pageSetup } = format
  const recto: PageBreak = pageSetup.mirrored ? 'newRecto' : 'newPage'
  const pages: BookItem[] = []
  const page = (p: GeneratedPage, brk: PageBreak): void => {
    pages.push({ kind: 'page', division: 'front', page: p, break: brk })
  }
  if (matter.titlePage === 'page') {
    const series = meta.series
      ? meta.seriesNumber
        ? `${meta.series}, Book ${meta.seriesNumber}`
        : meta.series
      : ''
    page(
      {
        kind: 'titlePage',
        title: meta.title,
        subtitle: meta.subtitle,
        author: meta.author,
        series,
        publisher: meta.publisher
      },
      recto
    )
  } else if (matter.titlePage === 'manuscript') {
    page(
      {
        kind: 'manuscriptTitle',
        contact: [meta.legalName, ...meta.contact].filter((l) => l.length > 0),
        wordCount: meta.approximateWords,
        title: meta.title,
        byline: meta.author ? `by ${meta.author}` : ''
      },
      'newPage'
    )
  }
  if (matter.copyrightPage) {
    const holder = meta.author || meta.legalName
    const lines = [
      meta.copyrightYear || holder
        ? `Copyright © ${[meta.copyrightYear, holder].filter(Boolean).join(' ')}`
        : '',
      ...paragraphsOf(meta.rights),
      meta.edition,
      meta.isbn ? `ISBN ${meta.isbn}` : '',
      meta.publisher
    ].filter((l) => l.length > 0)
    if (lines.length > 0) page({ kind: 'copyright', lines }, 'newPage')
  }
  if (matter.dedication) {
    const paragraphs = paragraphsOf(details.dedication)
    if (paragraphs.length > 0) page({ kind: 'dedication', paragraphs }, recto)
  }
  if (matter.epigraph) {
    const paragraphs = paragraphsOf(details.epigraph)
    if (paragraphs.length > 0)
      page({ kind: 'epigraph', paragraphs, source: details.epigraphSource.trim() }, recto)
  }
  return pages
}

function generatedBack(
  format: CompileFormat,
  meta: BookMetadata,
  details: BookDetails
): BookItem[] {
  const pages: BookItem[] = []
  if (format.matter.aboutAuthor) {
    const paragraphs = paragraphsOf(details.aboutAuthor)
    if (paragraphs.length > 0)
      pages.push({
        kind: 'page',
        division: 'back',
        page: { kind: 'aboutAuthor', title: 'About the Author', paragraphs },
        break: 'newPage'
      })
  }
  if (format.matter.alsoBy) {
    const titles = details.alsoBy.map((t) => t.trim()).filter((t) => t.length > 0)
    if (titles.length > 0)
      pages.push({
        kind: 'page',
        division: 'back',
        page: {
          kind: 'alsoBy',
          title: meta.author ? `Also by ${meta.author}` : 'Also by the Author',
          titles
        },
        break: 'newPage'
      })
  }
  return pages
}

function metadataOf(input: CompileInput, bodyWords: number): BookMetadata {
  const { details, format } = input
  const author = details.author.trim()
  return {
    title: bookTitle(details, input.projectName),
    subtitle: details.subtitle.trim(),
    author,
    surname: bookSurname(details),
    legalName: details.legalName.trim() || author,
    contact: paragraphsOf(details.contact),
    series: details.series.trim(),
    seriesNumber: details.seriesNumber.trim(),
    isbn: isbnFor(details, format.metadata.isbnEdition),
    publisher: details.publisher.trim(),
    copyrightYear: details.copyrightYear.trim(),
    rights: details.rights.trim(),
    edition: details.edition.trim(),
    language: details.language,
    description: details.description.trim(),
    keywords: details.keywords.map((k) => k.trim()).filter((k) => k.length > 0),
    cover: format.metadata.includeCover ? details.cover : null,
    bodyWords,
    approximateWords: approximateWords(bodyWords)
  }
}

/** The static token values of a book (writers add `page` and `chapter` per page). */
export function furnitureValues(
  metadata: BookMetadata,
  page: string,
  chapter: string
): Record<FurnitureToken, string> {
  return {
    author: metadata.author,
    surname: metadata.surname,
    title: metadata.title,
    TITLE: metadata.title.toLocaleUpperCase(),
    chapter,
    page,
    wordcount: metadata.approximateWords
  }
}

/**
 * Compiles the book (see the module comment). Scopes: `manuscript` (the whole manuscript),
 * `chapters` (the chosen nodes with their ancestors and descendants), `document` (one document
 * from any section, its text alone: no heading, no generated pages, no matter; an id that is not
 * a document gives an empty book, main refuses it before compiling). Excluded nodes leave their
 * subtree out of every section.
 */
export function compileBook(input: CompileInput): CompiledBook {
  const { format, source, scope } = input
  const final = FINAL_OUTPUTS.includes(input.output)
  const b: Builder = {
    format,
    content: {
      keepTags: format.contents.keepTags && !final,
      keepAiMarks: format.contents.keepAiMarks && !final,
      separator: format.sceneSeparator,
      replace: compileReplacements(format.replacements)
    },
    items: [],
    words: 0
  }
  const excluded = new Set(input.excluded)

  if (scope.kind === 'document') {
    const node = [...source.front, ...source.manuscript, ...source.end].find(
      (n) => n.id === scope.id && n.kind === 'document'
    )
    let bodyWords = 0
    if (node !== undefined && printable(node)) {
      b.items.push({
        kind: 'text',
        division: 'body',
        id: node.id,
        blocks: contentBlocks(node.content, b.content)
      })
      bodyWords = countWords(node.content)
    }
    if (node !== undefined) pushNotes(b, node, 'body')
    return {
      output: input.output,
      format,
      metadata: metadataOf(input, bodyWords),
      items: b.items,
      toc: [],
      words: bodyWords
    }
  }

  const only = scope.kind === 'chapters' ? new Set(scope.ids) : null
  // The body is built first, in its own list, so the contents page can precede it.
  const body: Builder = { ...b, items: [] }
  const bodyWords = bodyItems(body, selectEntries(source.manuscript, excluded, only))
  const bodyList = body.items
  const toc: TocEntry[] = []
  for (const item of bodyList) {
    if (item.kind === 'section' && item.level !== 'scene' && item.heading !== null)
      toc.push({ id: item.id, level: item.level, label: item.heading.plain, inPart: item.inPart })
  }
  const metadata = metadataOf(input, bodyWords)

  const items: BookItem[] = generatedFront(format, metadata, input.details)
  if (format.matter.toc && toc.length > 0) {
    items.push({
      kind: 'page',
      division: 'front',
      page: { kind: 'toc', title: 'Contents', entries: toc },
      break: format.pageSetup.mirrored ? 'newRecto' : 'newPage'
    })
  }
  if (format.matter.frontMatter) {
    matterItems(b, selectEntries(source.front, excluded), 'front')
    items.push(...b.items.splice(0))
  }
  items.push(...bodyList)
  if (format.matter.endMatter) {
    matterItems(b, selectEntries(source.end, excluded), 'back')
    items.push(...b.items.splice(0))
  }
  items.push(...generatedBack(format, metadata, input.details))
  return { output: input.output, format, metadata, items, toc, words: b.words + bodyWords }
}
