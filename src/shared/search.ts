import { straightenQuotes } from './critique'
import { z } from 'zod'

/**
 * Global search (F-10.1): the one owner of what can be searched, the limits, the request and
 * result shapes of `search:query`, and the pure text functions both sides rely on. Main scans the
 * stored text per query (no index table); the renderer only renders what comes back, so the
 * offsets in a result always refer to the strings in that same result.
 */
export const SEARCH_TYPES = ['document', 'notes', 'character', 'setting', 'world'] as const
export const SearchType = z.enum(SEARCH_TYPES)
export type SearchType = z.infer<typeof SearchType>

/** The filter chip of each type, in `SEARCH_TYPES` order. */
export const SEARCH_TYPE_LABEL: Record<SearchType, string> = {
  document: 'Documents',
  notes: 'Notes',
  character: 'Characters',
  setting: 'Settings',
  world: 'World'
}

/** The shortest query that is searched; anything shorter answers nothing. */
export const SEARCH_QUERY_MIN = 2
export const SEARCH_QUERY_MAX = 200
/** How many rows one answer carries; `total` still counts every matching source. */
export const SEARCH_MAX_RESULTS = 200
/** How many characters a snippet keeps on each side of the first match, before the word cut. */
export const SEARCH_SNIPPET_RADIUS = 60

/** A half-open `[from, to)` range of UTF-16 offsets into the string it travels with. */
export const SearchRange = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
export type SearchRange = z.infer<typeof SearchRange>

export const SearchRequest = z.object({
  /** As typed; main normalizes it. Shorter than `SEARCH_QUERY_MIN` once normalized answers empty. */
  query: z.string().max(SEARCH_QUERY_MAX),
  /** The types to search; none answers nothing. */
  types: z.array(SearchType),
  /** Only sources carrying this tag (linked or mentioned for a node, `tagId` for an entity). */
  tagId: z.string().nullable()
})
export type SearchRequest = z.infer<typeof SearchRequest>

export const SearchSnippet = z.object({
  text: z.string(),
  /** Every occurrence that lies inside `text`, as offsets into it. */
  highlights: z.array(SearchRange)
})
export type SearchSnippet = z.infer<typeof SearchSnippet>

/** One matching source: a document, a node's notes, or an entity. Never one row per occurrence. */
export const SearchResult = z.object({
  type: SearchType,
  /** The node id (`document`, `notes`) or the entity id. */
  id: z.string(),
  title: z.string(),
  /** The parent's title for a node; the kind's noun for an entity. */
  location: z.string(),
  /** The label of the template field the snippet comes from; null for anything else. */
  field: z.string().nullable(),
  snippet: SearchSnippet,
  /** The occurrences inside `title`. */
  titleHighlights: z.array(SearchRange),
  /** Every occurrence in the source: its title and all of its text. */
  count: z.number().int().positive()
})
export type SearchResult = z.infer<typeof SearchResult>

export const SearchResponse = z.object({
  results: z.array(SearchResult),
  /** How many sources matched, before the cap. */
  total: z.number().int().nonnegative(),
  truncated: z.boolean()
})
export type SearchResponse = z.infer<typeof SearchResponse>

export const EMPTY_SEARCH_RESPONSE: SearchResponse = { results: [], total: 0, truncated: false }

/** A query as it is matched: NFC, whitespace runs as one space, trimmed. Case is folded at match time. */
export function normalizeQuery(query: string): string {
  return searchableText(query)
}

/**
 * A text as it is searched and quoted: NFC, whitespace runs (paragraph breaks included) as one
 * space, trimmed — the same shape `normalizeQuery` gives the query, so a phrase that crosses a
 * paragraph break is found and a snippet never carries a line break.
 */
export function searchableText(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim()
}

/** Whether the normalized query is long enough to search. */
export function isSearchable(normalizedQuery: string): boolean {
  return normalizedQuery.length >= SEARCH_QUERY_MIN
}

/**
 * Lowercase code point by code point, keeping any character whose lowercase form has another
 * length (`İ` becomes two code units), so the folded string has exactly the offsets of the
 * original and a range found in one is a range of the other.
 */
export function foldCase(text: string): string {
  let folded = ''
  for (const char of text) {
    const lower = char.toLowerCase()
    folded += lower.length === char.length ? lower : char
  }
  return folded
}

/**
 * Every non-overlapping occurrence of `query` in `text`, case-insensitively, as offsets into
 * `text` itself. `query` is expected normalized (`normalizeQuery`); an empty one finds nothing.
 */
export function findOccurrences(text: string, query: string): SearchRange[] {
  // Quotes are straightened on both sides (one character for one, so offsets hold): a typed
  // `don't` finds the prose's `don’t`, the way `locateText` resolves the jump.
  const needle = foldCase(straightenQuotes(query))
  if (needle.length === 0) return []
  const haystack = foldCase(straightenQuotes(text))
  const found: SearchRange[] = []
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    found.push([at, at + needle.length])
  }
  return found
}

const ELLIPSIS = '…'

/**
 * The part of `text` shown for a result: `radius` characters on each side of the first
 * occurrence, each cut pulled in to a word boundary when it lands inside a word, with an ellipsis
 * wherever text was left out. Every occurrence that fits inside the cut is highlighted, with
 * offsets into the snippet's own text. With no occurrence (a title-only hit) the snippet is the
 * start of the text and highlights nothing.
 */
export function buildSnippet(
  text: string,
  occurrences: readonly SearchRange[],
  radius: number = SEARCH_SNIPPET_RADIUS
): SearchSnippet {
  const first = occurrences[0]
  const [from, to] = first ?? [0, 0]
  let start = Math.max(0, from - radius)
  if (start > 0 && text[start - 1] !== ' ') {
    // Mid-word: drop the partial word, unless the match itself begins inside it.
    const space = text.indexOf(' ', start)
    if (space !== -1 && space < from) start = space + 1
  }
  let end = Math.min(text.length, to + (first ? radius : radius * 2))
  if (end < text.length && text[end] !== ' ') {
    const space = text.lastIndexOf(' ', end)
    if (space > to) end = space
  }
  while (end > to && text[end - 1] === ' ') end--
  const prefix = start > 0 ? ELLIPSIS : ''
  const suffix = end < text.length ? ELLIPSIS : ''
  const shift = prefix.length - start
  return {
    text: `${prefix}${text.slice(start, end)}${suffix}`,
    highlights: occurrences
      .filter(([a, b]) => a >= start && b <= end)
      .map(([a, b]): SearchRange => [a + shift, b + shift])
  }
}
