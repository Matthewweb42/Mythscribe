import { useEffect, useMemo } from 'react'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useDocumentTagStore } from '@renderer/features/tags/documentTagStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { describeError } from '@renderer/lib/errors'
import { listOutline } from './outlineRows'
import { threadGrid, type ThreadCell } from './threadGrid'

/** Indentation per outline depth for the title column; deeper rows stay at the last step. */
const INDENT = ['pl-1', 'pl-3', 'pl-5', 'pl-7', 'pl-9', 'pl-11'] as const

const CELL_LABEL: Record<ThreadCell, string> = { on: 'Yes', gap: 'Gap', off: 'No' }

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`

/**
 * The Outline tab's thread board (F-11.1c): which plot threads (the bank's Plot Threads tags)
 * run through which manuscript documents, in reading order. One row per manuscript node (folders
 * as headings), one column per thread some document carries, ordered by first appearance; a
 * filled cell in the tag's colour where the document carries it, a dashed cell where it is
 * missing between the thread's first and last document (a gap). A summary per thread counts its
 * scenes and gaps, and the threads no document carries are named below. Links come from the
 * project-wide `documentTag:listAll`, read on mount and kept current by `documentTag:changed`;
 * the tag bar edits them. Read-only.
 */
export function ThreadBoard(): React.JSX.Element {
  const rootIds = useTreeStore((s) => s.rootIds)
  const childrenOf = useTreeStore((s) => s.childrenOf)
  const sectionOf = useTreeStore((s) => s.sectionOf)
  const byId = useTreeStore((s) => s.byId)
  const tagsById = useTagStore((s) => s.byId)
  const tagIds = useTagStore((s) => s.ids)
  const tagIdsByNode = useDocumentTagStore((s) => s.tagIdsByNode)

  useEffect(() => {
    useDocumentTagStore
      .getState()
      .loadAll()
      .catch((err: unknown) => toast.error(describeError(err)))
  }, [])

  const outline = useMemo(
    () => listOutline(rootIds, childrenOf, sectionOf),
    [rootIds, childrenOf, sectionOf]
  )
  const threadIds = useMemo(
    () => tagIds.filter((id) => tagsById[id]?.category === 'plotThread'),
    [tagIds, tagsById]
  )
  const grid = useMemo(
    () => threadGrid(outline, (id) => byId[id]?.kind === 'document', tagIdsByNode, threadIds),
    [outline, byId, tagIdsByNode, threadIds]
  )

  if (outline.length === 0) {
    return <p className="m-0 p-3 text-sm text-fg-muted">The manuscript is empty.</p>
  }
  if (threadIds.length === 0) {
    return (
      <p className="m-0 p-3 text-sm text-fg-muted">
        No plot threads yet. Create a tag in the Plot Threads category and add it to scenes to
        follow it here.
      </p>
    )
  }

  const totalGaps = grid.threads.reduce((sum, thread) => sum + thread.gaps, 0)

  return (
    <div className="min-h-0 flex-1 overflow-auto pb-2">
      <p data-testid="thread-counts" className="m-0 px-3 pt-2 pb-1 text-xs text-fg-muted">
        {grid.threads.length === 0
          ? 'No scene carries a plot thread yet.'
          : `${plural(grid.threads.length, 'thread', 'threads')} · ${plural(totalGaps, 'gap', 'gaps')}`}
      </p>
      {grid.threads.length > 0 ? (
        <table aria-label="Plot threads" className="border-separate border-spacing-0 px-2 text-sm">
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 bg-surface text-left align-bottom">
                <span className="sr-only">Scene</span>
              </th>
              {grid.threads.map((thread) => {
                const tag = tagsById[thread.id]
                return (
                  <th
                    key={thread.id}
                    scope="col"
                    title={`#${tag?.name ?? ''}: ${plural(thread.scenes, 'scene', 'scenes')}, ${plural(thread.gaps, 'gap', 'gaps')}`}
                    className="w-6 px-0.5 pb-1 align-bottom font-normal"
                  >
                    <span className="inline-block max-h-32 truncate text-xs text-fg-muted [writing-mode:vertical-rl] rotate-180">
                      {tag?.name ?? ''}
                    </span>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row) => (
              <ThreadGridRow
                key={row.id}
                id={row.id}
                depth={row.depth}
                cells={row.isDocument ? row.cells : null}
                colors={grid.threads.map((thread) => tagsById[thread.id]?.color ?? 'currentColor')}
              />
            ))}
          </tbody>
        </table>
      ) : null}
      <ul aria-label="Thread summary" className="m-0 flex list-none flex-col gap-0.5 px-3 pt-2">
        {grid.threads.map((thread) => (
          <li key={thread.id} data-testid="thread-summary" className="text-xs text-fg-muted">
            <span className="text-fg">#{tagsById[thread.id]?.name}</span>{' '}
            {plural(thread.scenes, 'scene', 'scenes')}, {plural(thread.gaps, 'gap', 'gaps')}
          </li>
        ))}
      </ul>
      {grid.unused.length > 0 ? (
        <p data-testid="thread-unused" className="m-0 px-3 pt-1 text-xs text-fg-muted">
          Not in any scene: {grid.unused.map((id) => `#${tagsById[id]?.name ?? ''}`).join(', ')}
        </p>
      ) : null}
    </div>
  )
}

/** One manuscript node: a folder as a heading row, a document as its title and one cell per thread. */
function ThreadGridRow({
  id,
  depth,
  cells,
  colors
}: {
  id: string
  depth: number
  cells: ThreadCell[] | null
  colors: string[]
}): React.JSX.Element | null {
  const node = useTreeStore((s) => s.byId[id])
  const selected = useTreeStore((s) => s.selectedId === id)
  const select = useTreeStore((s) => s.select)
  if (!node) return null
  return (
    <tr data-testid="thread-row" data-node={id}>
      <th
        scope="row"
        className={`sticky left-0 max-w-40 bg-surface pr-1 text-left font-normal ${INDENT[Math.min(depth, INDENT.length - 1)]}`}
      >
        <button
          type="button"
          aria-current={selected ? 'true' : undefined}
          onClick={() => select(id)}
          className={`block max-w-full truncate rounded-md px-1 py-0.5 text-left hover:bg-surface-raised ${
            selected ? 'bg-accent/15 text-fg' : ''
          } ${cells === null ? 'font-medium' : ''}`}
        >
          {node.title}
        </button>
      </th>
      {cells === null
        ? colors.map((_, column) => <td key={column} />)
        : cells.map((cell, column) => (
            <td key={column} data-state={cell} className="px-0.5 py-0.5 text-center">
              <span
                aria-hidden="true"
                className={`mx-auto block h-4 w-3 rounded-sm ${
                  cell === 'gap' ? 'border border-dashed border-fg-subtle' : ''
                }`}
                style={cell === 'on' ? { backgroundColor: colors[column] } : undefined}
              />
              <span className="sr-only">{CELL_LABEL[cell]}</span>
            </td>
          ))}
    </tr>
  )
}
