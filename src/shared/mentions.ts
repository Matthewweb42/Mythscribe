import { z } from 'zod'
import { aliasKey } from './aliases'
import { INLINE_TAG_NODE_TYPE } from './inlineTags'
import type { TagCategory } from './tags'
import type { TiptapNodeT } from './tiptap'

/**
 * Automatic mentions (F-4.12): on every save, main scans a manuscript document for the names of
 * the bank's tags and records where each one occurs, silently. Nothing is inserted into the
 * text and no text leaves the machine: the scan is local, runs through its own index queue
 * (never paused by a missing key), and is skipped when the document and the candidate names
 * are unchanged by content hash. The tag detail view and the tag bar show the counts apart
 * from the explicit links of F-4.4, with a jump to the first occurrence.
 */

/** Quiet after the last save before a document's mention scan is queued. */
export const MENTION_DEBOUNCE_MS = 1500

/** One occurrence: a ProseMirror `[from, to]` range of the saved document, what `setTextSelection` takes. */
export const MentionRange = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative()
])
export type MentionRange = z.infer<typeof MentionRange>

/** Every occurrence of one tag's name in one document; a document without any has no row. */
export const TagMentions = z.object({
  tagId: z.string(),
  nodeId: z.string(),
  count: z.number().int().positive(),
  ranges: z.array(MentionRange)
})
export type TagMentions = z.infer<typeof TagMentions>

/** The words of a kebab-case tag name, the way they would appear in prose: "rose-marsh" → ["rose", "marsh"]. */
export function nameWords(name: string): string[] {
  return name.split('-').filter((word) => word.length > 0)
}

/**
 * A tag the scan looks for: its id, its kebab-case name, the category that decides the case
 * rule, and its aliases (F-4.14), each of which is looked for as well and counts for the tag.
 */
export interface MentionCandidate {
  id: string
  name: string
  category: TagCategory
  aliases?: readonly string[]
}

/**
 * The node types of the editor schema that are one position wide (ProseMirror leaves and atoms):
 * everything else without `text` is a block or an inline container, which costs an opening and a
 * closing token. Stored JSON cannot tell an empty paragraph from a leaf on its own, so the list
 * is explicit; it must match the schema `src/renderer/features/editor/extensions.ts` builds.
 */
const LEAF_TYPES: ReadonlySet<string> = new Set([
  INLINE_TAG_NODE_TYPE,
  'hardBreak',
  'horizontalRule',
  'sceneBreak',
  'image'
])

/** One text node of the document: its string and the ProseMirror position its first character sits at. */
export interface TextRun {
  text: string
  from: number
}

/** A half-open `[start, end)` slice of one run's string, kept so a longer name wins over a shorter one. */
interface Span {
  start: number
  end: number
}

/**
 * Every occurrence of the candidates' names in a stored document (F-4.12), as ProseMirror
 * ranges of that document: the `[from, to]` pairs `setTextSelection` takes, so a jump needs no
 * second search. The rules, in order:
 *
 * - a name is matched by its words (`nameWords`), separated in the prose by whitespace, inside
 *   one text node — a name split over a paragraph break or around an inline tag token is not a
 *   mention;
 * - a match must stand on word boundaries: no letter or digit of any script immediately before
 *   or after it, so "Rosemary" is not a mention of `rose`;
 * - a `character` tag must read as a proper noun — every matched word starts with an uppercase
 *   letter (a caseless script cannot say, so it counts as one), which is how "Rose" the person
 *   is told from "rose" the flower; every other category matches case-insensitively;
 * - the longest names go first (most words, then most characters, characters before the rest)
 *   and a matched range is consumed, so `rose-marsh` leaves no second hit for `rose` inside it;
 * - inline tag tokens are skipped: an explicit link (F-4.6) is not a mention;
 * - every alias of a tag (F-4.14) is looked for as a name of its own, under the same rules, and
 *   its occurrences count for the tag: one list per tag, in document order.
 *
 * Tags without a single occurrence are absent from the map, never present with an empty list.
 */
export function findMentions(
  doc: TiptapNodeT,
  candidates: MentionCandidate[]
): Map<string, MentionRange[]> {
  const runs = textRuns(doc)
  const found = new Map<string, MentionRange[]>()
  if (runs.length === 0) return found
  /** What is already spoken for, per run: a longer name's range is never matched again. */
  const taken = runs.map((): Span[] => [])
  for (const candidate of ordered(expandAliases(candidates))) {
    const pattern = patternFor(candidate.name)
    if (pattern === null) continue
    const ranges: MentionRange[] = []
    runs.forEach((run, index) => {
      const spans = taken[index]
      if (spans === undefined) return
      pattern.lastIndex = 0
      for (let match = pattern.exec(run.text); match !== null; match = pattern.exec(run.text)) {
        const start = match.index
        const end = start + match[0].length
        // A zero-width match would loop for ever; a name always has at least one character.
        if (end === start) break
        pattern.lastIndex = end
        if (spans.some((span) => start < span.end && span.start < end)) continue
        if (candidate.category === 'character' && !isProperNoun(match[0])) continue
        spans.push({ start, end })
        ranges.push([run.from + start, run.from + end])
      }
    })
    if (ranges.length === 0) continue
    const before = found.get(candidate.id)
    found.set(
      candidate.id,
      before === undefined ? ranges : [...before, ...ranges].sort((a, b) => a[0] - b[0])
    )
  }
  return found
}

/** One candidate per name a tag answers to: its own, then each alias as a kebab-case name. */
function expandAliases(candidates: MentionCandidate[]): MentionCandidate[] {
  return candidates.flatMap((candidate) => [
    candidate,
    ...(candidate.aliases ?? [])
      .map((alias) => aliasKey(alias))
      .filter((name) => name !== '' && name !== candidate.name)
      .map((name) => ({ id: candidate.id, name, category: candidate.category }))
  ])
}

/**
 * The document's text nodes with the position each one starts at. The walk is ProseMirror's own
 * arithmetic over the stored JSON: the root's children start at 0, a container costs 1 before
 * its content and 1 after it, a text node costs its length, and a leaf costs 1.
 */
export function textRuns(doc: TiptapNodeT): TextRun[] {
  const runs: TextRun[] = []
  let offset = 0
  for (const child of doc.content ?? []) offset += walk(child, offset, runs)
  return runs
}

/** Collects `node`'s text runs and answers how many positions it takes up. */
function walk(node: TiptapNodeT, pos: number, runs: TextRun[]): number {
  if (typeof node.text === 'string') {
    if (node.text.length > 0) runs.push({ text: node.text, from: pos })
    return node.text.length
  }
  if (LEAF_TYPES.has(node.type)) return 1
  let inner = 0
  for (const child of node.content ?? []) inner += walk(child, pos + 1 + inner, runs)
  return inner + 2
}

/**
 * One paragraph of a stored document (F-9.12, the local knowledge index): a text block (a node
 * with text among its children: a paragraph, a heading, a list item's paragraph) that has text,
 * numbered from 0 in document order. Empty blocks are not numbered. `[from, to)` is the block's
 * content in ProseMirror positions, so a mention range is placed by its start. The text joins
 * the block's text nodes; a hard break reads as a line break and other inline leaves (an inline
 * tag token, an image) as a space, so words on either side never run together.
 */
export interface Paragraph {
  index: number
  text: string
  from: number
  to: number
}

/** The document's paragraphs, by the same position arithmetic as `textRuns`. */
export function passageParagraphs(doc: TiptapNodeT): Paragraph[] {
  const found: Paragraph[] = []
  let offset = 0
  for (const child of doc.content ?? []) offset += collectParagraphs(child, offset, found)
  return found
}

/** Collects `node`'s paragraphs and answers how many positions it takes up (as `walk` does). */
function collectParagraphs(node: TiptapNodeT, pos: number, found: Paragraph[]): number {
  if (typeof node.text === 'string') return node.text.length
  if (LEAF_TYPES.has(node.type)) return 1
  const children = node.content ?? []
  const start = pos + 1
  let inner = 0
  if (children.some((child) => typeof child.text === 'string')) {
    let text = ''
    for (const child of children) {
      if (typeof child.text === 'string') text += child.text
      else text += child.type === 'hardBreak' ? '\n' : ' '
      inner += walk(child, start + inner, [])
    }
    if (text.trim() !== '')
      found.push({ index: found.length, text, from: start, to: start + inner })
    return inner + 2
  }
  for (const child of children) inner += collectParagraphs(child, start + inner, found)
  return inner + 2
}

/**
 * The paragraph each range starts in (F-9.12: `tag_mention.paragraphs`), one per range, in the
 * ranges' order; -1 for a range outside every paragraph, which a mention never is.
 */
export function paragraphIndexes(
  paragraphs: readonly Paragraph[],
  ranges: readonly MentionRange[]
): number[] {
  return ranges.map(([from]) => {
    const hit = paragraphs.find((paragraph) => paragraph.from <= from && from < paragraph.to)
    return hit === undefined ? -1 : hit.index
  })
}

/** Longest first — most words, then most characters — and character tags ahead of the rest. */
function ordered(candidates: MentionCandidate[]): MentionCandidate[] {
  return [...candidates].sort((a, b) => {
    const words = nameWords(b.name).length - nameWords(a.name).length
    if (words !== 0) return words
    if (b.name.length !== a.name.length) return b.name.length - a.name.length
    const category = Number(b.category === 'character') - Number(a.category === 'character')
    if (category !== 0) return category
    return a.name.localeCompare(b.name)
  })
}

/**
 * The regular expression one name is matched by: its words separated by whitespace, between
 * Unicode word boundaries. Case is ignored here — the proper-noun rule reads the match itself.
 * null for a name with no words left (a hand-edited row).
 */
function patternFor(name: string): RegExp | null {
  const words = nameWords(name)
  if (words.length === 0) return null
  const body = words.map(escapeRegExp).join('\\s+')
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu')
}

function escapeRegExp(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether every word of the matched text opens with a capital, which is what a character tag
 * must look like in prose. A script without upper and lower case (Japanese, Hebrew) cannot
 * answer the question, so its words are accepted rather than silently never matched.
 */
export function isProperNoun(matched: string): boolean {
  return matched
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .every((word) => {
      const first = [...word][0] ?? ''
      if (first.toLowerCase() === first.toUpperCase()) return true
      return /\p{Lu}/u.test(first)
    })
}
