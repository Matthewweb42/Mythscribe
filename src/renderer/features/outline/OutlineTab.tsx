import { useEffect, useMemo } from 'react'
import { SCENE_STATUSES, SCENE_STATUS_LABELS, type SceneStatus } from '@shared/sceneMeta'
import { useSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import { useSummaryStore } from '@renderer/features/editor/summaryStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { AiSummaryLine, StatusDot } from './status'

/** Indentation per outline depth, spelled out so Tailwind sees every class; deeper rows stay at the last step. */
const INDENT = ['pl-2', 'pl-5', 'pl-8', 'pl-11', 'pl-14', 'pl-17'] as const

interface OutlineRowEntry {
  id: string
  depth: number
}

/** The manuscript section's nodes depth-first in tree order, the section root itself left out. */
function listOutline(
  rootIds: string[],
  childrenOf: Record<string, string[]>,
  sectionOf: Record<string, string>
): OutlineRowEntry[] {
  const root = rootIds.find((id) => sectionOf[id] === 'manuscript')
  if (root === undefined) return []
  const rows: OutlineRowEntry[] = []
  const walk = (ids: string[], depth: number): void => {
    for (const id of ids) {
      rows.push({ id, depth })
      walk(childrenOf[id] ?? [], depth + 1)
    }
  }
  walk(childrenOf[root] ?? [], 0)
  return rows
}

/**
 * The Outline tab of the sidebar (F-11.1): the Manuscript section as an always-expanded,
 * read-only outline, each row the node's status dot, its title (which opens it, like a click in
 * the Manuscript tree), and its synopsis clamped to two lines, or the scene summary (F-5.6)
 * greyed with an AI mark while the author has not written one. A header line counts the
 * manuscript documents per status. Editing, reordering, and drag live in the Manuscript tab and
 * the cork board; this tab only reads.
 */
export function OutlineTab(): React.JSX.Element {
  const rootIds = useTreeStore((s) => s.rootIds)
  const childrenOf = useTreeStore((s) => s.childrenOf)
  const sectionOf = useTreeStore((s) => s.sectionOf)
  const byId = useTreeStore((s) => s.byId)
  const metas = useSceneMetaStore((s) => s.docs)
  const rows = useMemo(
    () => listOutline(rootIds, childrenOf, sectionOf),
    [rootIds, childrenOf, sectionOf]
  )

  const documentIds = rows.filter((row) => byId[row.id]?.kind === 'document').map((row) => row.id)
  const counts = new Map<SceneStatus, number>()
  for (const id of documentIds) {
    const status = metas[id]?.content?.status ?? 'none'
    counts.set(status, (counts.get(status) ?? 0) + 1)
  }
  const summary = [
    `${documentIds.length} ${documentIds.length === 1 ? 'scene' : 'scenes'}`,
    ...SCENE_STATUSES.filter((status) => status !== 'none' && (counts.get(status) ?? 0) > 0).map(
      (status) => `${counts.get(status)} ${SCENE_STATUS_LABELS[status].toLowerCase()}`
    )
  ].join(' · ')

  if (rows.length === 0) {
    return <p className="m-0 p-3 text-sm text-fg-muted">The manuscript is empty.</p>
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <p data-testid="outline-counts" className="m-0 px-3 pt-2 pb-1 text-xs text-fg-muted">
        {summary}
      </p>
      <ul aria-label="Outline" className="m-0 flex list-none flex-col gap-0.5 p-0 pb-2">
        {rows.map((row) => (
          <OutlineRow key={row.id} id={row.id} depth={row.depth} />
        ))}
      </ul>
    </div>
  )
}

/** One outline row: holds the node's metadata (and a document's summary) while it is on screen. */
function OutlineRow({ id, depth }: { id: string; depth: number }): React.JSX.Element | null {
  const node = useTreeStore((s) => s.byId[id])
  const selected = useTreeStore((s) => s.selectedId === id)
  const select = useTreeStore((s) => s.select)
  const meta = useSceneMetaStore((s) => s.docs[id]?.content ?? null)
  const loadMeta = useSceneMetaStore((s) => s.load)
  const unloadMeta = useSceneMetaStore((s) => s.unload)
  const aiSummary = useSummaryStore((s) => s.byNode[id]?.summary?.summary ?? null)
  const loadSummary = useSummaryStore((s) => s.load)
  const isDocument = node?.kind === 'document'

  useEffect(() => {
    void loadMeta(id)
    return () => unloadMeta(id)
  }, [id, loadMeta, unloadMeta])

  useEffect(() => {
    // Only manuscript documents have summaries; a folder would only fetch "unavailable".
    if (isDocument) void loadSummary(id)
  }, [id, isDocument, loadSummary])

  if (!node) return null
  const synopsis = meta?.synopsis.trim() ?? ''

  return (
    <li
      data-testid="outline-row"
      data-depth={depth}
      className={`flex flex-col pr-2 ${INDENT[Math.min(depth, INDENT.length - 1)]}`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <StatusDot status={meta?.status ?? 'none'} />
        <button
          type="button"
          aria-current={selected ? 'true' : undefined}
          onClick={() => select(id)}
          className={`min-w-0 truncate rounded-md px-1 py-0.5 text-left text-sm hover:bg-surface-raised ${
            selected ? 'bg-accent/15 text-fg' : ''
          } ${isDocument ? '' : 'font-medium'}`}
        >
          {node.title}
        </button>
      </div>
      {synopsis.length > 0 ? (
        <p data-testid="outline-synopsis" className="m-0 line-clamp-2 pl-4 text-xs text-fg-muted">
          {synopsis}
        </p>
      ) : aiSummary !== null ? (
        <AiSummaryLine
          summary={aiSummary}
          testId="outline-ai-summary"
          className="line-clamp-2 pl-4"
        />
      ) : null}
    </li>
  )
}
