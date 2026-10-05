import { useEffect, useId, useMemo } from 'react'
import { SCENE_STATUSES, SCENE_STATUS_LABELS, type SceneStatus } from '@shared/sceneMeta'
import { STRUCTURE_TEMPLATES, STRUCTURE_TEMPLATE_IDS } from '@shared/structure'
import { useSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import { useSummaryStore } from '@renderer/features/editor/summaryStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { BeatBoard } from './BeatsView'
import { listOutline } from './outlineRows'
import { useOutlineViewStore, type OutlineMode } from './outlineViewStore'
import { AiSummaryLine, StatusDot } from './status'
import { useStructureStore } from './structureStore'

/** Indentation per outline depth, spelled out so Tailwind sees every class; deeper rows stay at the last step. */
const INDENT = ['pl-2', 'pl-5', 'pl-8', 'pl-11', 'pl-14', 'pl-17'] as const

const OUTLINE_MODES: readonly { mode: OutlineMode; label: string }[] = [
  { mode: 'outline', label: 'Outline' },
  { mode: 'beats', label: 'Beats' }
]

/**
 * The Outline tab of the sidebar (F-11.1): the Manuscript section as an always-expanded,
 * read-only outline, each row the node's status dot, its title (which opens it, like a click in
 * the Manuscript tree), and its synopsis clamped to two lines, or the scene summary (F-5.6)
 * greyed with an AI mark while the author has not written one. A header line counts the
 * manuscript documents per status. Editing, reordering, and drag live in the Manuscript tab and
 * the cork board; this tab only reads.
 *
 * F-11.1b: a header picks the project's structure template (or none). With one chosen, an
 * Outline/Beats switch shows the manuscript laid against the template's beats instead
 * (`BeatBoard`); the beat itself is set per node in the metadata pane.
 */
export function OutlineTab(): React.JSX.Element {
  const template = useStructureStore((s) => s.template)
  const mode = useOutlineViewStore((s) => s.outlineMode)
  const showBeats = template !== null && mode === 'beats'
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StructureHeader />
      {showBeats ? <BeatBoard template={template} /> : <OutlineList />}
    </div>
  )
}

/** The structure template picker and, while a template is chosen, the Outline/Beats switch. */
function StructureHeader(): React.JSX.Element {
  const template = useStructureStore((s) => s.template)
  const loaded = useStructureStore((s) => s.loaded)
  const setTemplate = useStructureStore((s) => s.setTemplate)
  const mode = useOutlineViewStore((s) => s.outlineMode)
  const setMode = useOutlineViewStore((s) => s.setOutlineMode)
  const selectId = useId()
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
      <label htmlFor={selectId} className="text-xs text-fg-muted">
        Structure
      </label>
      <select
        id={selectId}
        value={template ?? ''}
        disabled={!loaded}
        onChange={(event) => {
          const next = STRUCTURE_TEMPLATE_IDS.find((id) => id === event.target.value) ?? null
          void setTemplate(next)
        }}
        className="min-w-0 flex-1 basis-36 rounded-md border border-line bg-bg px-1 py-px text-xs leading-5 disabled:opacity-50"
      >
        <option value="">None</option>
        {STRUCTURE_TEMPLATE_IDS.map((id) => (
          <option key={id} value={id}>
            {STRUCTURE_TEMPLATES[id].name}
          </option>
        ))}
      </select>
      {template !== null ? (
        <div
          role="group"
          aria-label="Outline view"
          className="flex shrink-0 gap-0.5 rounded-md border border-line p-0.5"
        >
          {OUTLINE_MODES.map((option) => (
            <button
              key={option.mode}
              type="button"
              aria-pressed={option.mode === mode}
              onClick={() => setMode(option.mode)}
              className="rounded px-2 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg aria-pressed:bg-surface-raised aria-pressed:text-fg"
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** The read-only outline of the manuscript section (F-11.1). */
function OutlineList(): React.JSX.Element {
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
