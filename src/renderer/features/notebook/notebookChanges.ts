import type { DiffSegment } from '@shared/drafts'
import { diffWords } from '@shared/textDiff'

/** One line of a page as it is now, with the words Ms Scribe added or removed in it. */
export interface ChangedLine {
  pieces: DiffSegment[]
  /** True when the line holds an addition or a removal. */
  changed: boolean
}

/**
 * The lines of a page after Ms Scribe's edit, each with its word diff against the page before
 * (the drafts' word diff, F-8.5): a line is changed when words were added to it or removed from
 * it. Removed text that spanned lines shows on the line where it was cut, on one line. Lines with
 * no text are left out.
 */
export function changedLines(before: string, after: string): ChangedLine[] {
  const lines: ChangedLine[] = []
  let current: ChangedLine = { pieces: [], changed: false }
  const push = (piece: DiffSegment): void => {
    if (piece.text === '') return
    current.pieces.push(piece)
    if (piece.op !== 'same') current.changed = true
  }
  const newLine = (): void => {
    lines.push(current)
    current = { pieces: [], changed: false }
  }
  for (const segment of diffWords(before, after)) {
    if (segment.op === 'del') {
      push({ op: 'del', text: segment.text.replace(/\n+/g, ' ') })
      continue
    }
    const parts = segment.text.split('\n')
    parts.forEach((part, index) => {
      if (index > 0) {
        newLine()
        // A line break Ms Scribe added starts a line of hers.
        if (segment.op === 'add') current.changed = true
      }
      push({ op: segment.op, text: part })
    })
  }
  newLine()
  return lines.filter((line) => line.pieces.some((piece) => piece.text.trim() !== ''))
}
