import type { Node as PmNode } from '@tiptap/pm/model'
import { normalizeForMatch, straightenQuotes } from '@shared/critique'
import { INLINE_TAG_NODE_TYPE } from '@shared/inlineTags'
import { foldCase } from '@shared/search'

/** A character of the document as it is matched, with the position it lives at (−1 for a boundary space). */
interface Entry {
  char: string
  pos: number
}

/** A range of the document, the way the editor's commands take it. */
export interface TextRange {
  from: number
  to: number
}

/**
 * The document as one normalized string with a position per character: straight quotes,
 * whitespace runs (block boundaries and hard breaks included) as one space, an inline tag
 * token as `#name` (the way `rangeText` reads it). Exactly `normalizeForMatch`'s rules, so a
 * quote main found in the text it sent is found here too.
 */
function scan(doc: PmNode): Entry[] {
  const entries: Entry[] = []
  const push = (char: string, pos: number): void => {
    if (/\s/.test(char)) {
      if (entries.length === 0 || entries[entries.length - 1]?.char === ' ') return
      entries.push({ char: ' ', pos: -1 })
      return
    }
    entries.push({ char: straightenQuotes(char), pos })
  }
  doc.descendants((node, pos) => {
    if (node.isText) {
      const text = node.text ?? ''
      for (let i = 0; i < text.length; i++) push(text[i] ?? '', pos + i)
      return false
    }
    if (node.type.name === INLINE_TAG_NODE_TYPE && typeof node.attrs.name === 'string') {
      const token = `#${node.attrs.name}`
      // An atom is one position: every character of the token maps to the node itself.
      for (const char of token) push(char, pos)
      return false
    }
    if (node.type.name === 'hardBreak' || node.isBlock) push(' ', -1)
    return true
  })
  return entries
}

/**
 * Where `quote` sits in the document, or null when it is not there (F-14.8). Both sides are
 * normalized the way `normalizeForMatch` does, so a quote that crosses a paragraph break (one
 * space once normalized) still resolves to the range holding it; the range runs from the first
 * matched character to just past the last, which is what `setRewriteTarget` and a selection
 * take. The needle is trimmed, so a match never begins or ends on a boundary space.
 * `ignoreCase` is for a needle whose casing is not the prose's: a tag name against the proper
 * noun it was found as (F-4.12). A cited quote never asks for it.
 */
export function locateText(
  doc: PmNode,
  quote: string,
  options?: { ignoreCase?: boolean }
): TextRange | null {
  const fold = options?.ignoreCase === true
  const needle = fold ? foldCase(normalizeForMatch(quote)) : normalizeForMatch(quote)
  if (needle === '') return null
  const entries = scan(doc)
  const haystack = entries.map((entry) => entry.char).join('')
  const at = (fold ? foldCase(haystack) : haystack).indexOf(needle)
  if (at === -1) return null
  const first = entries[at]
  const last = entries[at + needle.length - 1]
  if (!first || !last || first.pos < 0 || last.pos < 0) return null
  return { from: first.pos, to: last.pos + 1 }
}

/**
 * `locateText` for many quotes over one scan of the document (F-14.15: every tracked change of a
 * scene is found again whenever the changes are set): one range per quote, null where it is not
 * found, with the same normalization and the same first-match rule.
 */
export function locateAll(doc: PmNode, quotes: readonly string[]): (TextRange | null)[] {
  const entries = scan(doc)
  const haystack = entries.map((entry) => entry.char).join('')
  return quotes.map((quote) => {
    const needle = normalizeForMatch(quote)
    if (needle === '') return null
    const at = haystack.indexOf(needle)
    if (at === -1) return null
    const first = entries[at]
    const last = entries[at + needle.length - 1]
    if (!first || !last || first.pos < 0 || last.pos < 0) return null
    return { from: first.pos, to: last.pos + 1 }
  })
}

/**
 * Where `passage` sits when the document holds it exactly once (F-5.22: an edit the chat agent
 * proposes names its passage by its text); `missing` or `ambiguous` otherwise. The same
 * normalization as `locateText`.
 */
export function locateUniqueText(
  doc: PmNode,
  passage: string
): TextRange | 'missing' | 'ambiguous' {
  const needle = normalizeForMatch(passage)
  if (needle === '') return 'missing'
  const entries = scan(doc)
  const haystack = entries.map((entry) => entry.char).join('')
  const at = haystack.indexOf(needle)
  if (at === -1) return 'missing'
  if (haystack.includes(needle, at + 1)) return 'ambiguous'
  const first = entries[at]
  const last = entries[at + needle.length - 1]
  if (!first || !last || first.pos < 0 || last.pos < 0) return 'missing'
  return { from: first.pos, to: last.pos + 1 }
}
