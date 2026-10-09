import { useEffect, useId, useMemo } from 'react'
import { isFeatureAllowed } from '@shared/aiSettings'
import { planLinkKey, type PlanLinkSuggestion } from '@shared/planLinks'
import { SCENE_STATUSES, SCENE_STATUS_LABELS, type SceneStatus } from '@shared/sceneMeta'
import {
  SCENE_PROGRESS,
  SCENE_PROGRESS_LABEL,
  folderProgress,
  sceneProgress,
  type SceneProgress
} from '@shared/storyTime'
import { STRUCTURE_TEMPLATES, STRUCTURE_TEMPLATE_IDS, templateBeats } from '@shared/structure'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { AI_WAIT_CLASS } from '@renderer/features/ai/aiWaitPhrases'
import { SceneCardView } from '@renderer/features/editor/SceneCardView'
import { useSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import { useSummaryStore } from '@renderer/features/editor/summaryStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { BeatBoard } from './BeatsView'
import { listOutline } from './outlineRows'
import { useOutlineViewStore, type OutlineMode } from './outlineViewStore'
import { usePlanLinksStore } from './planLinksStore'
import { AiSummaryLine, StatusDot } from './status'
import { useStructureStore } from './structureStore'
import { ThreadBoard } from './ThreadsView'

/** F-11.1d: a planned row reads as a plan (dashed, muted); written rows are solid. */
const PROGRESS_CLASS: Record<SceneProgress, string> = {
  planned: 'border border-dashed border-line text-fg-subtle',
  drafted: 'border border-line text-fg-muted',
  revised: 'border border-line bg-surface-raised text-fg'
}

/** Indentation per outline depth, spelled out so Tailwind sees every class; deeper rows stay at the last step. */
const INDENT = ['pl-2', 'pl-5', 'pl-8', 'pl-11', 'pl-14', 'pl-17'] as const

const OUTLINE_MODES: readonly { mode: OutlineMode; label: string }[] = [
  { mode: 'outline', label: 'Outline' },
  { mode: 'threads', label: 'Threads' },
  { mode: 'beats', label: 'Beats' }
]

/** The view on screen: Beats needs a template, so without one the stored choice reads as Outline. */
function useShownMode(): OutlineMode {
  const template = useStructureStore((s) => s.template)
  const mode = useOutlineViewStore((s) => s.outlineMode)
  return mode === 'beats' && template === null ? 'outline' : mode
}

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
 *
 * F-11.1c: a Threads view shows which plot threads run through which documents (`ThreadBoard`).
 */
export function OutlineTab(): React.JSX.Element {
  const template = useStructureStore((s) => s.template)
  const mode = useShownMode()
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StructureHeader />
      {mode === 'beats' && template !== null ? (
        <BeatBoard template={template} />
      ) : mode === 'threads' ? (
        <ThreadBoard />
      ) : (
        <OutlineList />
      )}
    </div>
  )
}

/** The structure template picker and the view switch (Outline, Threads, and Beats while a template is chosen). */
function StructureHeader(): React.JSX.Element {
  const template = useStructureStore((s) => s.template)
  const loaded = useStructureStore((s) => s.loaded)
  const setTemplate = useStructureStore((s) => s.setTemplate)
  const mode = useShownMode()
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
      <div
        role="group"
        aria-label="Outline view"
        className="flex shrink-0 gap-0.5 rounded-md border border-line p-0.5"
      >
        {OUTLINE_MODES.filter((option) => option.mode !== 'beats' || template !== null).map(
          (option) => (
            <button
              key={option.mode}
              type="button"
              aria-pressed={option.mode === mode}
              onClick={() => setMode(option.mode)}
              className="rounded px-2 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg aria-pressed:bg-surface-raised aria-pressed:text-fg"
            >
              {option.label}
            </button>
          )
        )}
      </div>
    </div>
  )
}

/**
 * The read-only outline of the manuscript section (F-11.1). It mirrors the binder: the rows come
 * from the tree store, so a chapter or scene shows (and moves, renames, or goes) the moment the
 * Manuscript tab, the cork board, the chat, or an import changes it. F-11.1d: each row shows
 * Planned, Drafted, or Revised (`sceneProgress`, a folder rolls up its documents), a header line
 * counts them, and the plan links show on their rows: what a planned scene was fulfilled by,
 * what a written scene fulfils, and the AI's suggestions to confirm or dismiss.
 */
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

  useEffect(() => {
    void usePlanLinksStore.getState().load()
  }, [])

  // F-11.1d: planned / drafted / revised per row, folders rolled up from the documents under them.
  const progressOf = new Map<string, SceneProgress | null>()
  rows.forEach((row, index) => {
    const node = byId[row.id]
    if (node?.kind === 'document') {
      progressOf.set(
        row.id,
        sceneProgress(node.wordCount, metas[row.id]?.content?.status ?? 'none')
      )
      return
    }
    const inside: SceneProgress[] = []
    for (let i = index + 1; i < rows.length && (rows[i]?.depth ?? 0) > row.depth; i++) {
      const id = rows[i]?.id ?? ''
      const child = byId[id]
      if (child?.kind === 'document') {
        inside.push(sceneProgress(child.wordCount, metas[id]?.content?.status ?? 'none'))
      }
    }
    progressOf.set(row.id, folderProgress(inside))
  })
  // Which planned scenes each written scene fulfils.
  const fulfils = new Map<string, string[]>()
  for (const row of rows) {
    const by = metas[row.id]?.content?.fulfilledBy
    if (by !== undefined && byId[by] !== undefined)
      fulfils.set(by, [...(fulfils.get(by) ?? []), row.id])
  }

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

  const progressCounts = SCENE_PROGRESS.map((progress) => ({
    progress,
    n: documentIds.filter((id) => progressOf.get(id) === progress).length
  }))
    .filter(({ n }) => n > 0)
    .map(({ progress, n }) => `${n} ${SCENE_PROGRESS_LABEL[progress].toLowerCase()}`)
    .join(' · ')

  if (rows.length === 0) {
    return <p className="m-0 p-3 text-sm text-fg-muted">The manuscript is empty.</p>
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <p data-testid="outline-counts" className="m-0 px-3 pt-2 pb-1 text-xs text-fg-muted">
        {summary}
      </p>
      <div className="flex items-center gap-2 px-3 pb-1">
        <p data-testid="outline-progress" className="m-0 min-w-0 flex-1 text-xs text-fg-muted">
          {progressCounts}
        </p>
        <FindLinksButton />
      </div>
      <ul aria-label="Outline" className="m-0 flex list-none flex-col gap-0.5 p-0 pb-2">
        {rows.map((row) => (
          <OutlineRow
            key={row.id}
            id={row.id}
            depth={row.depth}
            progress={progressOf.get(row.id) ?? null}
            fulfils={fulfils.get(row.id) ?? []}
          />
        ))}
      </ul>
    </div>
  )
}

/** F-11.1d: runs the plan-link job now; shown only while Plan links may run. */
function FindLinksButton(): React.JSX.Element | null {
  const settings = useAiSettingsStore((s) => s.settings)
  const running = usePlanLinksStore((s) => s.running)
  const run = usePlanLinksStore((s) => s.run)
  if (settings === null || !isFeatureAllowed(settings, 'planLinks')) return null
  return (
    <button
      type="button"
      data-testid="outline-find-links"
      disabled={running}
      onClick={() => void run()}
      title="Ask the AI which written scene fulfils each planned scene and empty beat"
      className="shrink-0 rounded-md border border-line px-2 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-50"
    >
      {running ? <span className={AI_WAIT_CLASS}>Finding links…</span> : 'Find links'}
    </button>
  )
}

/** A beat's name in its template, or its id when the template no longer has it. */
function beatName(link: PlanLinkSuggestion): string {
  if (link.plan.kind !== 'beat') return ''
  const { template, beatId } = link.plan
  return templateBeats(template).find((beat) => beat.id === beatId)?.name ?? beatId
}

/** The small "AI" mark on a link the job applied itself (CLAUDE.md, AI rule 1). */
function AiMark({ title }: { title: string }): React.JSX.Element {
  return (
    <span title={title} className="rounded border border-line px-0.5 text-[10px] font-medium">
      AI
    </span>
  )
}

/**
 * F-11.1d: a row's plan links. A planned scene shows the scene that fulfils it (with Unlink) or
 * the AI's suggestion for it; a written scene shows the planned scenes it fulfils and the beat
 * the AI suggests for it. Suggestions carry Confirm and Dismiss.
 */
function PlanLinkLines({ id, fulfils }: { id: string; fulfils: string[] }): React.JSX.Element {
  const byId = useTreeStore((s) => s.byId)
  const select = useTreeStore((s) => s.select)
  const fulfilledBy = useSceneMetaStore((s) => s.docs[id]?.content?.fulfilledBy)
  const suggestions = usePlanLinksStore((s) => s.suggestions)
  const aiApplied = usePlanLinksStore((s) => s.aiApplied)
  const confirm = usePlanLinksStore((s) => s.confirm)
  const dismiss = usePlanLinksStore((s) => s.dismiss)
  const unlink = usePlanLinksStore((s) => s.unlink)
  const mine = suggestions.filter((link) =>
    link.plan.kind === 'scene' ? link.plan.nodeId === id : link.sceneId === id
  )
  const by = fulfilledBy !== undefined ? byId[fulfilledBy] : undefined
  const linkClass = 'rounded px-0.5 text-left underline-offset-2 hover:underline'
  const actionClass =
    'rounded border border-line px-1 text-[11px] text-fg-muted hover:bg-surface-raised hover:text-fg'
  return (
    <>
      {by !== undefined && fulfilledBy !== undefined ? (
        <p
          data-testid="outline-fulfilled"
          className="m-0 flex flex-wrap items-center gap-1 pl-4 text-xs text-fg-muted"
        >
          Fulfilled by{' '}
          <button type="button" className={linkClass} onClick={() => select(fulfilledBy)}>
            {by.title}
          </button>
          {aiApplied.includes(
            planLinkKey({ plan: { kind: 'scene', nodeId: id }, sceneId: fulfilledBy })
          ) ? (
            <AiMark title="Linked by the AI" />
          ) : null}
          <button
            type="button"
            className={actionClass}
            onClick={() => void unlink({ kind: 'scene', nodeId: id })}
          >
            Unlink
          </button>
        </p>
      ) : null}
      {fulfils.map((planId) => (
        <p
          key={planId}
          data-testid="outline-fulfils"
          className="m-0 flex flex-wrap items-center gap-1 pl-4 text-xs text-fg-muted"
        >
          Fulfils plan{' '}
          <button type="button" className={linkClass} onClick={() => select(planId)}>
            {byId[planId]?.title ?? ''}
          </button>
        </p>
      ))}
      {mine.map((link) => {
        const key = planLinkKey(link)
        const what =
          link.plan.kind === 'scene'
            ? `Fulfilled by ${byId[link.sceneId]?.title ?? ''}?`
            : `On the beat ${beatName(link)}?`
        return (
          <div
            key={key}
            role="group"
            aria-label="Suggested link"
            data-testid="plan-suggestion"
            className="flex flex-wrap items-center gap-1 pl-4 text-xs text-fg-subtle"
          >
            <AiMark title="Suggested by the AI" />
            <span className="min-w-0">{what}</span>
            {link.reason ? <span className="min-w-0 italic">{link.reason}</span> : null}
            <button type="button" className={actionClass} onClick={() => void confirm(key)}>
              Confirm
            </button>
            <button type="button" className={actionClass} onClick={() => void dismiss(key)}>
              Dismiss
            </button>
          </div>
        )
      })}
    </>
  )
}

/** One outline row: holds the node's metadata (and a document's summary) while it is on screen. */
function OutlineRow({
  id,
  depth,
  progress,
  fulfils
}: {
  id: string
  depth: number
  progress: SceneProgress | null
  fulfils: string[]
}): React.JSX.Element | null {
  const node = useTreeStore((s) => s.byId[id])
  const selected = useTreeStore((s) => s.selectedId === id)
  const select = useTreeStore((s) => s.select)
  const meta = useSceneMetaStore((s) => s.docs[id]?.content ?? null)
  const loadMeta = useSceneMetaStore((s) => s.load)
  const unloadMeta = useSceneMetaStore((s) => s.unload)
  const aiSummary = useSummaryStore((s) => s.byNode[id]?.summary?.summary ?? null)
  // F-9.14: the scene card under the synopsis or summary.
  const card = useSummaryStore((s) => s.byNode[id]?.card ?? null)
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
      data-progress={progress ?? undefined}
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
        {progress !== null ? (
          <span
            data-testid="outline-progress-badge"
            className={`ml-auto shrink-0 rounded px-1 text-[10px] ${PROGRESS_CLASS[progress]}`}
          >
            {SCENE_PROGRESS_LABEL[progress]}
          </span>
        ) : null}
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
      {card !== null ? <SceneCardView card={card} compact /> : null}
      {isDocument ? <PlanLinkLines id={id} fulfils={fulfils} /> : null}
    </li>
  )
}
