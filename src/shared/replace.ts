import { z } from 'zod'
import { straightenQuotes } from './critique'
import { SEARCH_QUERY_MAX, SearchRange, buildSnippet, foldCase } from './search'
import type { TiptapNodeT } from './tiptap'

/**
 * Project-wide find and replace (F-10.2): the one owner of the options, the limits, the shapes
 * of `replace:preview` / `replace:commit` / `replace:undo`, and the pure functions that find and
 * rewrite text in stored Tiptap JSON. Main previews and writes with the same functions, so what
 * the preview counts is what a commit replaces.
 *
 * Matching differs from search (F-10.1) on purpose: the text is taken as stored (no whitespace
 * collapsing) and a match lives inside one *run* — the adjacent text nodes of one parent. A block
 * boundary, a hard break, and an inline tag token all end a run, so a replacement never merges
 * paragraphs and never swallows a token.
 */
export const REPLACE_QUERY_MAX = SEARCH_QUERY_MAX
export const REPLACEMENT_MAX = 1000
/** How many documents one preview lists, and so how many one commit can change. */
export const REPLACE_MAX_DOCUMENTS = 500
/** How many sample lines a previewed document carries; `count` still counts every occurrence. */
export const REPLACE_SAMPLES = 5

export const ReplaceOptions = z.object({
  /** Literal text, matched as typed (not trimmed: two spaces are a fair thing to look for). Empty finds nothing. */
  query: z.string().max(REPLACE_QUERY_MAX),
  /** Literal text (no `$1`, no case preservation); empty deletes the match. */
  replacement: z.string().max(REPLACEMENT_MAX),
  matchCase: z.boolean(),
  /** The match is not preceded or followed by a letter, a digit, or an underscore of any script. */
  wholeWord: z.boolean()
})
export type ReplaceOptions = z.infer<typeof ReplaceOptions>

export const ReplaceRequest = ReplaceOptions.extend({
  /** A tree node: only it and everything in it. Null is every document of the project. */
  scopeId: z.string().nullable()
})
export type ReplaceRequest = z.infer<typeof ReplaceRequest>

/** A line of text and the one range in it that the sample is about. */
export const ReplaceSampleText = z.object({ text: z.string(), range: SearchRange })
export type ReplaceSampleText = z.infer<typeof ReplaceSampleText>

/** One occurrence in context: the text as it stands and as it would read once replaced. */
export const ReplaceSample = z.object({ before: ReplaceSampleText, after: ReplaceSampleText })
export type ReplaceSample = z.infer<typeof ReplaceSample>

export const ReplacePreviewItem = z.object({
  id: z.string(),
  title: z.string(),
  /** The parent's path, as in search results. */
  location: z.string(),
  /** Every occurrence in the document. */
  count: z.number().int().positive(),
  /** The first `REPLACE_SAMPLES` occurrences. */
  samples: z.array(ReplaceSample)
})
export type ReplacePreviewItem = z.infer<typeof ReplacePreviewItem>

export const ReplacePreview = z.object({
  items: z.array(ReplacePreviewItem),
  /** How many documents hold a match, before the cap. */
  total: z.number().int().nonnegative(),
  truncated: z.boolean()
})
export type ReplacePreview = z.infer<typeof ReplacePreview>

export const EMPTY_REPLACE_PREVIEW: ReplacePreview = { items: [], total: 0, truncated: false }

export const ReplaceCommitRequest = ReplaceRequest.extend({
  /** The documents the author left ticked; ids outside the scope are skipped. */
  ids: z.array(z.string()).max(REPLACE_MAX_DOCUMENTS)
})
export type ReplaceCommitRequest = z.infer<typeof ReplaceCommitRequest>

/** A document a commit or an undo wrote, with its new cached word count for the tree. */
export const ReplaceWrittenDocument = z.object({
  id: z.string(),
  wordCount: z.number().int().nonnegative()
})
export type ReplaceWrittenDocument = z.infer<typeof ReplaceWrittenDocument>

export const ReplaceCommitResult = z.object({
  /** Only the documents that actually changed, each with how many occurrences were replaced. */
  changed: z.array(ReplaceWrittenDocument.extend({ count: z.number().int().positive() })),
  /** Every occurrence replaced. */
  total: z.number().int().nonnegative()
})
export type ReplaceCommitResult = z.infer<typeof ReplaceCommitResult>

export const ReplaceUndoResult = z.object({
  /** The documents put back as they were before the last commit. */
  restored: z.array(ReplaceWrittenDocument),
  /** The documents left alone because they were edited (or deleted) after the commit. */
  skipped: z.array(z.string())
})
export type ReplaceUndoResult = z.infer<typeof ReplaceUndoResult>

/** The query as it is matched: NFC, otherwise exactly as typed. */
export function normalizeReplaceQuery(query: string): string {
  return query.normalize('NFC')
}

/** Whether the options can find anything at all. */
export function isReplaceable(options: Pick<ReplaceOptions, 'query'>): boolean {
  return normalizeReplaceQuery(options.query).length > 0
}

/** A letter, a mark, a digit, or an underscore of any script: what a whole word may not touch. */
const WORD_BEFORE = /[\p{L}\p{M}\p{N}_]$/u
const WORD_AFTER = /^[\p{L}\p{M}\p{N}_]/u

/** The form both sides are compared in; one character for one, so offsets hold. */
function comparable(text: string, matchCase: boolean): string {
  const straight = straightenQuotes(text)
  return matchCase ? straight : foldCase(straight)
}

/**
 * Every occurrence of the query in one run's text, left to right and never overlapping, as
 * offsets into `text`. Straight and curly quotes match each other, as in search. With
 * `wholeWord` a candidate touching a word character on either side is passed over and the scan
 * resumes one character later, so a later, valid candidate that overlaps it is still found.
 */
export function findInRun(
  text: string,
  options: Pick<ReplaceOptions, 'query' | 'matchCase' | 'wholeWord'>
): SearchRange[] {
  const needle = comparable(normalizeReplaceQuery(options.query), options.matchCase)
  if (needle.length === 0) return []
  const haystack = comparable(text, options.matchCase)
  const found: SearchRange[] = []
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    const end = at + needle.length
    const whole =
      !options.wholeWord ||
      (!WORD_BEFORE.test(text.slice(Math.max(0, at - 2), at)) &&
        !WORD_AFTER.test(text.slice(end, end + 2)))
    if (whole) found.push([at, end])
    at = haystack.indexOf(needle, whole ? end : at + 1)
  }
  return found
}

/** The adjacent text nodes of one parent, as `[start, end)` indexes into its `content`. */
function runsOf(content: readonly TiptapNodeT[]): [number, number][] {
  const runs: [number, number][] = []
  let start = -1
  content.forEach((child, index) => {
    const isText = child.text !== undefined
    if (isText && start === -1) start = index
    if (!isText && start !== -1) {
      runs.push([start, index])
      start = -1
    }
  })
  if (start !== -1) runs.push([start, content.length])
  return runs
}

const runText = (nodes: readonly TiptapNodeT[]): string =>
  nodes.map((node) => node.text ?? '').join('')

/** Calls `visit` with the text of every run of the document, in reading order. */
function eachRun(node: TiptapNodeT, visit: (text: string) => void): void {
  const content = node.content
  if (content === undefined) return
  const runs = runsOf(content)
  let next = 0
  content.forEach((child, index) => {
    const run = runs[next]
    if (run?.[0] === index) {
      visit(runText(content.slice(run[0], run[1])))
      next++
    }
    if (child.text === undefined) eachRun(child, visit)
  })
}

/** How many occurrences `replaceInDoc` would replace. */
export function countInDoc(doc: TiptapNodeT, options: ReplaceOptions): number {
  let count = 0
  eachRun(doc, (text) => {
    count += findInRun(text, options).length
  })
  return count
}

/**
 * The first `max` occurrences in context: the run's text cut around the match (`buildSnippet`),
 * and the same line with that one occurrence replaced.
 */
export function samplesInDoc(
  doc: TiptapNodeT,
  options: ReplaceOptions,
  max: number = REPLACE_SAMPLES
): ReplaceSample[] {
  const samples: ReplaceSample[] = []
  eachRun(doc, (text) => {
    if (samples.length >= max) return
    for (const match of findInRun(text, options)) {
      if (samples.length >= max) return
      const snippet = buildSnippet(text, [match])
      const range = snippet.highlights[0]
      if (range === undefined) continue
      const [from, to] = range
      samples.push({
        before: { text: snippet.text, range },
        after: {
          text: `${snippet.text.slice(0, from)}${options.replacement}${snippet.text.slice(to)}`,
          range: [from, from + options.replacement.length]
        }
      })
    }
  })
  return samples
}

/**
 * One run rewritten. Text outside a match stays in a node carrying everything its source node
 * carried (marks included, so a provenance mark rides along); the replacement takes the marks of
 * the node holding the match's first character. Empty nodes are dropped and pieces that come
 * from the same source node are joined, so a match inside one node leaves one node.
 */
function replaceInRun(
  nodes: readonly TiptapNodeT[],
  matches: readonly SearchRange[],
  replacement: string
): TiptapNodeT[] {
  const pieces: { source: TiptapNodeT; text: string }[] = []
  const push = (source: TiptapNodeT, text: string): void => {
    if (text === '') return
    const last = pieces[pieces.length - 1]
    if (last?.source === source) last.text += text
    else pieces.push({ source, text })
  }
  let offset = 0
  let next = 0
  /** True while the cursor is inside a match whose replacement has already been written. */
  let inMatch = false
  for (const source of nodes) {
    const text = source.text ?? ''
    const end = offset + text.length
    let cursor = offset
    while (cursor < end) {
      const match = matches[next]
      if (match === undefined || match[0] >= end) {
        push(source, text.slice(cursor - offset))
        cursor = end
      } else if (cursor < match[0]) {
        push(source, text.slice(cursor - offset, match[0] - offset))
        cursor = match[0]
      } else {
        if (!inMatch) {
          push(source, replacement)
          inMatch = true
        }
        cursor = Math.min(end, match[1])
        if (cursor === match[1]) {
          inMatch = false
          next++
        }
      }
    }
    offset = end
  }
  return pieces.map(({ source, text }) => ({ ...source, text }))
}

/**
 * The document with every occurrence replaced, and how many there were. Never mutates its
 * input: a changed node is a new object and everything untouched is shared, so a document with
 * no match comes back as the very same object. The replacement is literal and is never scanned
 * again (replacing `a` with `aa` terminates).
 */
export function replaceInDoc(
  doc: TiptapNodeT,
  options: ReplaceOptions
): { doc: TiptapNodeT; count: number } {
  let count = 0
  const rewrite = (node: TiptapNodeT): TiptapNodeT => {
    const content = node.content
    if (content === undefined) return node
    const runs = runsOf(content)
    const out: TiptapNodeT[] = []
    let changed = false
    let next = 0
    for (let index = 0; index < content.length; index++) {
      const child = content[index]
      if (child === undefined) continue
      const run = runs[next]
      if (run?.[0] === index) {
        next++
        const nodes = content.slice(run[0], run[1])
        const matches = findInRun(runText(nodes), options)
        if (matches.length === 0) {
          out.push(...nodes)
        } else {
          count += matches.length
          changed = true
          out.push(...replaceInRun(nodes, matches, options.replacement))
        }
        index = run[1] - 1
        continue
      }
      const rewritten = rewrite(child)
      if (rewritten !== child) changed = true
      out.push(rewritten)
    }
    if (!changed) return node
    if (out.length > 0) return { ...node, content: out }
    // A block emptied by the replacement is stored the way the editor stores an empty block.
    const emptied = { ...node }
    delete emptied.content
    return emptied
  }
  return { doc: rewrite(doc), count }
}
