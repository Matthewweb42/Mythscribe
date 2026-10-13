import { sourceLabelWords, type ScribeCitation, type ScribeTurn, type TextSpan } from '@shared/scribe'

/**
 * Ms Scribe's answer in words for the chat (F-16.25, plan P3 §5): how `ScribeAnswer` cuts the
 * answer into text, marked sentences and chips, and how it names a source. Pure.
 */

/** One piece of an answer as the chat draws it. */
export type AnswerSegment =
  | { kind: 'text' | 'notChecked' | 'unsupported'; text: string }
  | { kind: 'cite'; n: number }

const MARKER = /\[(\d{1,2})\]/g

/**
 * The answer cut into what the chat draws (F-16.25): plain text, the sentences marked "not
 * checked" or unsupported (`ScribeTurn`'s spans, character ranges of `text` as main stored it,
 * clamped and in order; one that overlaps the last is dropped), and each `[n]` marker that names a
 * kept citation as a chip. A marker naming none stays plain text. Pure.
 */
export function answerSegments(
  text: string,
  turn: Pick<ScribeTurn, 'citations' | 'notChecked' | 'unsupported'>
): AnswerSegment[] {
  const kept = new Set(turn.citations.map((citation) => citation.n))
  const marks: { span: TextSpan; kind: 'notChecked' | 'unsupported' }[] = [
    ...turn.notChecked.map((span) => ({ span, kind: 'notChecked' as const })),
    ...turn.unsupported.map((span) => ({ span, kind: 'unsupported' as const }))
  ]
    .filter(({ span: [start, end] }) => start < end && end <= text.length)
    .sort((a, b) => a.span[0] - b.span[0])
  const segments: AnswerSegment[] = []
  const plain = (piece: string, kind: 'text' | 'notChecked' | 'unsupported'): void => {
    let cut = 0
    for (const match of piece.matchAll(MARKER)) {
      const n = Number(match[1])
      if (!kept.has(n)) continue
      const at = match.index ?? 0
      if (at > cut) segments.push({ kind, text: piece.slice(cut, at) })
      segments.push({ kind: 'cite', n })
      cut = at + match[0].length
    }
    if (cut < piece.length) segments.push({ kind, text: piece.slice(cut) })
  }
  let at = 0
  for (const { span, kind } of marks) {
    const [start, end] = span
    if (start < at) continue
    plain(text.slice(at, start), 'text')
    plain(text.slice(start, end), kind)
    at = end
  }
  plain(text.slice(at), 'text')
  return segments
}

/** A reference as the author reads it: paragraphs counted from 1 ("1.1 ¶0" → "1.1 ¶1"), as ⓘ does. */
export function shownRef(ref: string): string {
  return ref.replace(/¶(\d+)(?:–(\d+))?/g, (_, from: string, to: string | undefined) =>
    to === undefined ? `¶${Number(from) + 1}` : `¶${Number(from) + 1}–${Number(to) + 1}`
  )
}

/** "happened, 1.1 ¶1": a source's label in words and where it is. */
export function citationWhere(citation: ScribeCitation): string {
  const where = shownRef(citation.ref)
  const words = sourceLabelWords(citation.label, citation.doc)
  return where === '' ? words : `${words}, ${where}`
}
