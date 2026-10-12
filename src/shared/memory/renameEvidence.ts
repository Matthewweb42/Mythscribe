import { normalizeForMatch } from '../critique'
import type { Paragraph } from '../mentions'
import { NAMING_MARK, sceneSentences } from './anchor'
import { locateInText } from './quote'
import type { RenameEdit } from './rename'

/**
 * Rename in book over the reading's evidence (F-16.13, F-16.17; plan P2a §1.4): the rewrite that
 * renames a scene's prose renames what was read from it in the same transaction, so a claim's
 * quote still sits word for word in the text, its anchor still holds, and the scene does not read
 * as changed. Pure: the edits (ProseMirror ranges of the stored scene) in, rewritten text out.
 * Gate hashes need nothing: names are out of them (`gate.ts`).
 */

/** One edit as offsets into its paragraph's text. */
export interface TextEdit {
  start: number
  end: number
  /** The words that were there. */
  text: string
  replacement: string
}

/** The edits by paragraph index, as offsets into each paragraph's text, in order. */
export function textEdits(
  paragraphs: readonly Paragraph[],
  edits: readonly RenameEdit[]
): Map<number, TextEdit[]> {
  const byPara = new Map<number, TextEdit[]>()
  for (const edit of edits) {
    const paragraph = paragraphs.find((each) => each.from <= edit.from && edit.to <= each.to)
    if (paragraph === undefined) continue
    const list = byPara.get(paragraph.index) ?? []
    list.push({
      start: edit.from - paragraph.from,
      end: edit.to - paragraph.from,
      text: edit.text,
      replacement: edit.replacement
    })
    byPara.set(
      paragraph.index,
      list.sort((a, b) => a.start - b.start)
    )
  }
  return byPara
}

/** `text` with the edits that lie wholly inside `[from, to)` applied (offsets into `text`'s source). */
function applyWithin(text: string, from: number, to: number, edits: readonly TextEdit[]): string {
  let out = ''
  let at = from
  for (const edit of edits) {
    if (edit.start < from || edit.end > to) continue
    out += text.slice(at, edit.start) + edit.replacement
    at = edit.end
  }
  return out + text.slice(at, to)
}

/**
 * A quote of `paragraph` as the rename rewrites it, or null when the quote does not sit in the
 * paragraph exactly once (left as it is). A rewritten name the quote only partly covers is taken
 * in whole.
 */
export function rewriteQuote(
  paragraph: string,
  quote: string,
  edits: readonly TextEdit[]
): string | null {
  const at = locateInText(paragraph, quote)
  if (at === null) return null
  let { start, end } = at
  for (const edit of edits) {
    if (edit.start < start && edit.end > start) start = edit.start
    if (edit.start < end && edit.end > end) end = edit.end
  }
  return applyWithin(paragraph, start, end, edits)
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Derived text with every renamed name replaced, on word boundaries and in its case (a card's
 * line, a value that names someone): the edits' own words, each by its replacement.
 */
export function rewriteWords(text: string, edits: readonly TextEdit[]): string {
  let out = text
  const pairs = new Map(edits.map((edit) => [edit.text, edit.replacement]))
  for (const [from, to] of [...pairs].sort((a, b) => b[0].length - a[0].length)) {
    if (from === '' || from === to) continue
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escape(from)}(?![\\p{L}\\p{N}])`, 'gu')
    out = out.replace(pattern, to)
  }
  return out
}

/**
 * The scene's sentences before and after the rewrite, paired by position: each old hash and each
 * old normalised text to its new one. Null when the rewrite changed how the scene splits into
 * sentences (a name with a full stop), so nothing is paired wrongly.
 */
export function sentencePairs(
  before: readonly string[],
  after: readonly string[]
): { hashes: Map<string, string>; texts: Map<string, string> } | null {
  const old = sceneSentences(before)
  const fresh = sceneSentences(after)
  if (old.length !== fresh.length) return null
  const hashes = new Map<string, string>()
  const texts = new Map<string, string>()
  old.forEach((sentence, i) => {
    const next = fresh[i]
    if (next === undefined) return
    if (!hashes.has(sentence.hash)) hashes.set(sentence.hash, next.hash)
    const key = normalizeForMatch(sentence.text)
    if (!texts.has(key)) texts.set(key, normalizeForMatch(next.text))
  })
  return { hashes, texts }
}

/**
 * An anchor with each hash moved to its sentence's new one (a hash not in the scene stays; a
 * naming sentence keeps its mark).
 */
export function rewriteAnchor(
  anchor: readonly string[],
  pairs: { hashes: ReadonlyMap<string, string> } | null
): string[] {
  if (pairs === null) return [...anchor]
  return anchor.map((entry) => {
    const naming = entry.startsWith(NAMING_MARK)
    const hash = naming ? entry.slice(NAMING_MARK.length) : entry
    const next = pairs.hashes.get(hash) ?? hash
    return naming ? `${NAMING_MARK}${next}` : next
  })
}
