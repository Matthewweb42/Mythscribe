/**
 * Cutting text to a length for a prompt or a line (one owner, CLAUDE.md "reuse before you write"):
 * runs of white space made one, then cut at a word with `…`.
 */

/** `text` with every run of white space as one space, trimmed. */
export const flatText = (text: string): string => text.replace(/\s+/gu, ' ').trim()

/**
 * `text` flattened (`flatText`) and cut to `max` characters at the last word boundary past half of
 * it (else mid-word), with `…`; text within `max` comes back flattened only.
 */
export function clipAtWord(text: string, max: number): string {
  const flat = flatText(text)
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const at = cut.lastIndexOf(' ')
  return `${(at > max / 2 ? cut.slice(0, at) : cut).trimEnd()}…`
}
