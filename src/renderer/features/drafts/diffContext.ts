import type { DiffSegment } from '@shared/drafts'

/** How much unchanged text stays visible on each side of a change. */
export const DIFF_CONTEXT_CHARS = 120

/** One piece of a diff as the compare view shows it: a run of text, or a gap of hidden text. */
export type ShownSegment = DiffSegment | { op: 'gap'; chars: number }

/** Cuts `text` to about `max` characters from its start, ending on a word boundary when it can. */
function head(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.lastIndexOf(' ', max)
  return text.slice(0, cut > max / 2 ? cut + 1 : max)
}

/** Cuts `text` to about `max` characters from its end, starting on a word boundary when it can. */
function tail(text: string, max: number): string {
  if (text.length <= max) return text
  const from = text.length - max
  const cut = text.indexOf(' ', from)
  return text.slice(cut !== -1 && cut < from + max / 2 ? cut + 1 : from)
}

/**
 * Collapses the long unchanged runs of a document diff (F-8.5) so a changed sentence in a long
 * scene shows with some context instead of the whole scene: an unchanged run keeps
 * `context` characters next to each change it touches and the rest becomes a `gap` that says
 * how much was hidden. Changed runs are always shown whole.
 */
export function collapseUnchanged(
  segments: readonly DiffSegment[],
  context: number = DIFF_CONTEXT_CHARS
): ShownSegment[] {
  const shown: ShownSegment[] = []
  segments.forEach((segment, index) => {
    if (segment.op !== 'same') {
      shown.push(segment)
      return
    }
    const before = index > 0 // a change precedes this run
    const after = index < segments.length - 1 // a change follows it
    const keep = (before ? context : 0) + (after ? context : 0)
    // Hiding less than one context's worth is not worth the gap marker.
    if (segment.text.length <= keep + context) {
      shown.push(segment)
      return
    }
    const start = before ? head(segment.text, context) : ''
    const end = after ? tail(segment.text, context) : ''
    if (start !== '') shown.push({ op: 'same', text: start })
    shown.push({ op: 'gap', chars: segment.text.length - start.length - end.length })
    if (end !== '') shown.push({ op: 'same', text: end })
  })
  return shown
}
