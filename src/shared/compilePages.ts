import type { CompileFormat, PageBreak } from './compileFormat'
import type { BookItem, CompiledBook } from './compileModel'

/**
 * Page runs (Compile v2, CV2): where a compiled book's pages start and what their headers and
 * footers do, decided once for every paged writer (the print PDF, DOCX, ODT, RTF) and the
 * compile window's preview. A run starts at the first item and at every item that carries a page
 * break; a separator that is a page break only breaks the page inside its run.
 *
 * - `newRecto` is a right-hand page only when the book has sides (mirrored margins or facing
 *   headers); otherwise it is a new page.
 * - A run in the front division (generated front pages, the project's front matter) is bare: no
 *   header or footer on any of its pages.
 * - Every other run that starts a page is an opener: with `hideOnOpeners` its first page is bare.
 * - The body's first run restarts page numbering at 1 and, when the book has sides and something
 *   precedes it, starts on a right-hand page (decided by Claude, unconfirmed: a printed book's
 *   page 1 is a recto).
 */

export type RunStart = 'first' | 'newPage' | 'newRecto'

export interface PageRun {
  /** Index of the run's first item in `book.items`. */
  start: number
  /** Index after the run's last item. */
  end: number
  how: RunStart
  /** Every page bare: the front division. */
  front: boolean
  /** The first page is bare (an opener under `hideOnOpeners`). */
  bareFirst: boolean
  /** Page numbering restarts at 1 here (the body's first run). */
  restartNumbering: boolean
  /** The `{chapter}` header text as the run starts. */
  runningHead: string
}

/** The break an item carries; items without one flow. */
export function itemBreak(item: BookItem): PageBreak {
  return item.kind === 'page' || item.kind === 'matter' || item.kind === 'section'
    ? item.break
    : 'none'
}

/** Whether pages have sides: mirrored margins or facing headers. */
export function hasSides(format: CompileFormat): boolean {
  return format.pageSetup.mirrored || format.headersFooters.facing
}

/** The book's items split into page runs (see the module comment). */
export function pageRuns(book: CompiledBook): PageRun[] {
  const { items, format } = book
  const sides = hasSides(format)
  const runs: PageRun[] = []
  let runningHead = ''
  let bodySeen = false
  items.forEach((item, index) => {
    const brk = itemBreak(item)
    const firstBody = item.division === 'body' && !bodySeen
    if (item.division === 'body') bodySeen = true
    if (item.kind === 'section' && item.level !== 'scene') runningHead = item.runningHead
    const starts = index === 0 || brk !== 'none' || (firstBody && runs.length > 0)
    if (!starts) return
    const previous = runs[runs.length - 1]
    if (previous !== undefined) previous.end = index
    let how: RunStart = 'first'
    if (index > 0) {
      const recto = brk === 'newRecto' || (firstBody && sides)
      how = recto && sides ? 'newRecto' : 'newPage'
    }
    const front = item.division === 'front'
    const opener = item.kind === 'section' || item.kind === 'matter' || item.kind === 'page'
    runs.push({
      start: index,
      end: items.length,
      how,
      front,
      bareFirst: !front && opener && format.headersFooters.hideOnOpeners,
      restartNumbering: firstBody,
      runningHead
    })
  })
  return runs
}
