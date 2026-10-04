import { z } from 'zod'
import { INLINE_TAG_NODE_TYPE } from './inlineTags'
import type { TiptapNodeT } from './tiptap'

/** The counts of a stretch of text (F-10.4): words, characters, and characters without whitespace. */
export const TextStats = z.object({
  words: z.number().int().nonnegative(),
  characters: z.number().int().nonnegative(),
  charactersNoSpaces: z.number().int().nonnegative()
})
export type TextStats = z.infer<typeof TextStats>

/**
 * What main counts for the word count dialog (F-10.4) from the stored documents: the chapter
 * around a node (null when it has none under the manuscript) and the whole manuscript.
 */
export const WordCountReport = z.object({
  chapter: z.object({ id: z.string(), title: z.string(), stats: TextStats }).nullable(),
  manuscript: TextStats
})
export type WordCountReport = z.infer<typeof WordCountReport>

export const EMPTY_TEXT_STATS: TextStats = { words: 0, characters: 0, charactersNoSpaces: 0 }

/** Words per estimated page (F-10.4): the standard manuscript page. */
export const WORDS_PER_PAGE = 250

/** Estimated pages of `words`, rounded up so any text is at least one page; 0 for none. */
export function estimatedPages(words: number): number {
  return Math.ceil(Math.max(0, words) / WORDS_PER_PAGE)
}

export function addTextStats(a: TextStats, b: TextStats): TextStats {
  return {
    words: a.words + b.words,
    characters: a.characters + b.characters,
    charactersNoSpaces: a.charactersNoSpaces + b.charactersNoSpaces
  }
}

function addText(stats: TextStats, text: string, words: number): void {
  stats.words += words
  stats.characters += text.length
  stats.charactersNoSpaces += text.replace(/\s+/g, '').length
}

/**
 * The counts of a Tiptap document (F-3.2, F-10.4): every `text` leaf is split on whitespace and
 * empty tokens are dropped, so marks, alignment, and block structure never change the count.
 * An inline tag token (F-4.6) counts as one word with its stored name's characters; atoms
 * without text (the scene break) count as 0. Characters are the text's own; block boundaries
 * add none.
 */
export function textStats(doc: TiptapNodeT): TextStats {
  const stats = { ...EMPTY_TEXT_STATS }
  const walk = (node: TiptapNodeT): void => {
    if (node.type === INLINE_TAG_NODE_TYPE) {
      const name = node.attrs?.name
      addText(stats, typeof name === 'string' ? name : '', 1)
    }
    if (node.text !== undefined) {
      let words = 0
      for (const token of node.text.split(/\s+/)) if (token.length > 0) words += 1
      addText(stats, node.text, words)
    }
    for (const child of node.content ?? []) walk(child)
  }
  walk(doc)
  return stats
}

/**
 * The words of a Tiptap document, by `textStats`. One owner, so the cached `node.word_count`,
 * any live count in the renderer, and the word count dialog agree.
 */
export function countWords(doc: TiptapNodeT): number {
  return textStats(doc).words
}
