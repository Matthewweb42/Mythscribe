import type { OutlineRowEntry } from './outlineRows'

/** Whether a document carries a thread, sits in a gap of it (inside its span, without it), or neither. */
export type ThreadCell = 'on' | 'gap' | 'off'

export interface ThreadColumn {
  id: string
  /** How many manuscript documents carry the thread. */
  scenes: number
  /** How many documents between its first and last scene do not. */
  gaps: number
}

export interface ThreadRow {
  id: string
  depth: number
  /** Folders are headings; only documents carry links, so only they have cells. */
  isDocument: boolean
  /** One cell per thread column, in column order; empty for a folder. */
  cells: ThreadCell[]
}

export interface ThreadGrid {
  /** The threads some manuscript document carries, by first appearance in reading order. */
  threads: ThreadColumn[]
  /** The threads no manuscript document carries, in the order given. */
  unused: string[]
  rows: ThreadRow[]
}

/**
 * The plot-thread grid (F-11.1c): which threads run through which manuscript documents, in
 * reading order. `rows` is the outline (`listOutline`), `threadIds` the bank's plot-thread tags
 * (by name), `tagIdsByNode` the document-tag links. A cell between a thread's first and last
 * document that lacks the thread is a gap, so a thread that drops out for a stretch shows at once.
 */
export function threadGrid(
  rows: OutlineRowEntry[],
  isDocument: (id: string) => boolean,
  tagIdsByNode: Record<string, string[] | undefined>,
  threadIds: string[]
): ThreadGrid {
  const docs = rows.filter((row) => isDocument(row.id)).map((row) => row.id)
  const carried = new Map<string, Set<string>>()
  for (const id of docs) carried.set(id, new Set(tagIdsByNode[id] ?? []))

  const first = new Map<string, number>()
  const last = new Map<string, number>()
  docs.forEach((id, index) => {
    for (const thread of threadIds) {
      if (!carried.get(id)?.has(thread)) continue
      if (!first.has(thread)) first.set(thread, index)
      last.set(thread, index)
    }
  })

  const used = threadIds
    .filter((thread) => first.has(thread))
    .sort((a, b) => (first.get(a) ?? 0) - (first.get(b) ?? 0))
  const unused = threadIds.filter((thread) => !first.has(thread))

  const cellOf = (id: string, index: number, thread: string): ThreadCell => {
    if (carried.get(id)?.has(thread)) return 'on'
    const start = first.get(thread) ?? 0
    const end = last.get(thread) ?? 0
    return index > start && index < end ? 'gap' : 'off'
  }

  const threads: ThreadColumn[] = used.map((thread) => ({ id: thread, scenes: 0, gaps: 0 }))
  const docIndex = new Map(docs.map((id, index) => [id, index]))
  const gridRows = rows.map((row): ThreadRow => {
    const index = docIndex.get(row.id)
    if (index === undefined) return { id: row.id, depth: row.depth, isDocument: false, cells: [] }
    const cells = used.map((thread) => cellOf(row.id, index, thread))
    cells.forEach((cell, column) => {
      const counts = threads[column]
      if (counts === undefined) return
      if (cell === 'on') counts.scenes++
      else if (cell === 'gap') counts.gaps++
    })
    return { id: row.id, depth: row.depth, isDocument: true, cells }
  })

  return { threads, unused, rows: gridRows }
}
