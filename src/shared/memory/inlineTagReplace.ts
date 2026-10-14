import { INLINE_TAG_NODE_TYPE } from '../inlineTags'
import type { TiptapMarkT, TiptapNodeT } from '../tiptap'

/**
 * The switch-over's one change to the author's prose (F-16.15, story memory P1 slice 6): every
 * inline `#tag` token becomes plain words, with the replacement she consented to per tag. Pure, so
 * main runs it over `node.content`, `node.notes` and `draft_text` inside the conversion's
 * transaction and the renderer's corpus test loads what it writes. Snapshots are never passed
 * here. Range-tag marks (`tagRange`) are not text and stay as they are, inert (decision P1-D11).
 */

/** What a token reads as when nothing says otherwise: its stored name, hyphens as spaces. */
export function tagNameAsWords(name: string): string {
  return name.replace(/-+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** One inline tag token as stored: the tag id it carries and the name written at insertion. */
export interface InlineTagToken {
  id: string
  name: string
}

/** A token's id and name, or null for a node that is not a well-formed token. */
export function inlineTagTokenOf(node: TiptapNodeT): InlineTagToken | null {
  if (node.type !== INLINE_TAG_NODE_TYPE) return null
  const id = node.attrs?.id
  if (typeof id !== 'string' || id === '') return null
  const name = node.attrs?.name
  return { id, name: typeof name === 'string' ? name : '' }
}

/** Every token of a document in document order (one entry per occurrence). */
export function inlineTagTokens(doc: TiptapNodeT): InlineTagToken[] {
  const found: InlineTagToken[] = []
  const walk = (node: TiptapNodeT): void => {
    const token = inlineTagTokenOf(node)
    if (token !== null) found.push(token)
    for (const child of node.content ?? []) walk(child)
  }
  walk(doc)
  return found
}

/**
 * Whether any node of `doc` is an inline tag, well formed or not (F-16.31: the switch-over's own
 * check that none is left once it has converted).
 */
export function containsInlineTag(doc: TiptapNodeT): boolean {
  if (doc.type === INLINE_TAG_NODE_TYPE) return true
  return (doc.content ?? []).some(containsInlineTag)
}

/** The longest sample the consent screen shows around a token. */
export const INLINE_TAG_SAMPLE_MAX = 160

/**
 * A sample of the text around each token of a document, by token id (the first occurrence only):
 * its paragraph with every token written `#name`, cut to about `INLINE_TAG_SAMPLE_MAX` characters
 * around it at word boundaries.
 */
export function inlineTagSamples(doc: TiptapNodeT): Map<string, string> {
  const samples = new Map<string, string>()
  const blockText = (block: TiptapNodeT, marks: { id: string; at: number }[]): string => {
    let text = ''
    const walk = (node: TiptapNodeT): void => {
      const token = inlineTagTokenOf(node)
      if (token !== null) {
        marks.push({ id: token.id, at: text.length })
        text += `#${token.name}`
        return
      }
      if (node.type === 'text') text += node.text ?? ''
      else if (node.type === 'hardBreak') text += ' '
      for (const child of node.content ?? []) walk(child)
    }
    walk(block)
    return text
  }
  const visit = (node: TiptapNodeT): void => {
    const textblock = (node.content ?? []).some(
      (child) => child.type === 'text' || inlineTagTokenOf(child) !== null
    )
    if (!textblock) {
      for (const child of node.content ?? []) visit(child)
      return
    }
    const marks: { id: string; at: number }[] = []
    const text = blockText(node, marks)
    for (const mark of marks) {
      if (samples.has(mark.id)) continue
      samples.set(mark.id, cutAround(text, mark.at))
    }
  }
  visit(doc)
  return samples
}

/** `text` cut to about `INLINE_TAG_SAMPLE_MAX` characters around `at`, at word boundaries. */
function cutAround(text: string, at: number): string {
  const flat = text.replace(/\s+/g, ' ')
  if (flat.length <= INLINE_TAG_SAMPLE_MAX) return flat.trim()
  const half = Math.floor(INLINE_TAG_SAMPLE_MAX / 2)
  let start = Math.max(0, at - half)
  let end = Math.min(flat.length, start + INLINE_TAG_SAMPLE_MAX)
  start = Math.max(0, end - INLINE_TAG_SAMPLE_MAX)
  if (start > 0) {
    const space = flat.indexOf(' ', start)
    if (space !== -1 && space < at) start = space + 1
  }
  if (end < flat.length) {
    const space = flat.lastIndexOf(' ', end)
    if (space > at) end = space
  }
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`
}

const sameMarks = (a: TiptapMarkT[] | undefined, b: TiptapMarkT[] | undefined): boolean =>
  JSON.stringify(a ?? []) === JSON.stringify(b ?? [])

/** Adjacent text nodes with the same marks joined, as ProseMirror keeps them. */
function joinText(nodes: readonly TiptapNodeT[]): TiptapNodeT[] {
  const out: TiptapNodeT[] = []
  for (const node of nodes) {
    const last = out[out.length - 1]
    if (last?.type === 'text' && node.type === 'text' && sameMarks(last.marks, node.marks)) {
      out[out.length - 1] = { ...last, text: `${last.text ?? ''}${node.text ?? ''}` }
    } else {
      out.push(node)
    }
  }
  return out
}

export interface ReplacedInlineTags {
  /** The document with every token replaced; the very same object when it held none. */
  doc: TiptapNodeT
  /** Tokens replaced. */
  replaced: number
}

/**
 * Every inline tag token of `doc` as plain text: `replacements` by the token's stored id (the
 * consent screen's words), else the token's own name with hyphens as spaces. The text keeps the
 * token's marks (a bold token stays bold) and joins its neighbours when their marks match. A
 * replacement that is empty after trimming falls back to the name, so no token disappears.
 */
export function replaceInlineTags(
  doc: TiptapNodeT,
  replacements: ReadonlyMap<string, string>
): ReplacedInlineTags {
  let replaced = 0
  const rewrite = (node: TiptapNodeT): TiptapNodeT => {
    if (node.content === undefined) return node
    let changed = false
    const next = node.content.map((child): TiptapNodeT => {
      const token = inlineTagTokenOf(child)
      if (token !== null || child.type === INLINE_TAG_NODE_TYPE) {
        changed = true
        replaced += 1
        const chosen = token === null ? '' : (replacements.get(token.id) ?? '').trim()
        const text = chosen !== '' ? chosen : tagNameAsWords(token?.name ?? '')
        return child.marks === undefined || child.marks.length === 0
          ? { type: 'text', text }
          : { type: 'text', text, marks: child.marks }
      }
      const rewritten = rewrite(child)
      if (rewritten !== child) changed = true
      return rewritten
    })
    if (!changed) return node
    // A token with no name and no replacement leaves no text: an empty text node is invalid.
    const content = joinText(next.filter((child) => child.type !== 'text' || child.text !== ''))
    return { ...node, content }
  }
  const out = rewrite(doc)
  return { doc: out, replaced }
}
