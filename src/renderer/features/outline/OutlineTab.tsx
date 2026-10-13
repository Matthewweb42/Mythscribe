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
import { LabelFilterBar } from '@renderer/features/labels/LabelFilterBar'
import { useLabelFilterView } from '@renderer/features/labels/labelFilter'
import { useMemoryStore } from '@renderer/features/memory/memoryStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useStoryMemory } from '@renderer/features/project/storyMemory'
import { BeatBoard } from './BeatsView'
import { listOutline } from './outlineRows'
import { useOutlineViewStore, type OutlineMode } from './outlineViewStore'
import { usePlanLinksStore } from './planLinksStore'
import { AiSummaryLine, StatusDot } from './status'
import { useStructureStore } from './structureStore'
import { ThreadBoard } from './ThreadsView'
import { AiMark } from '@renderer/features/ai/AiMark'

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

/**
 * The view on screen: Beats needs a template, so without one the stored choice reads as Outline.
 * Story memory v2 has no Threads view until P2b brings threads back as claims (decision P1-D8):
 * there the stored choice reads as Outline too.
 */
function useShownMode(): OutlineMode {
  const template = useStructureStore((s) => s.template)
  const mode = useOutlineViewStore((s) => s.outlineMode)
  const memory = useStoryMemory()
  if (mode === 'beats' && template === null) return 'outline'
  if (mode === 'threads' && memory === 'v2') return 'outline'
  return mode
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
  const memory = useStoryMemory()
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
        {OUTLINE_MODES.filter(
          (option) =>
            (option.mode !== 'beats' || template !== null) &&
            (option.mode !== 'threads' || memory === 'v1')
        ).map((option) => (
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
  const memory = useStoryMemory()
  const index = useMemo(() => ({ rootIds, childrenOf }), [rootIds, childrenOf])
  // F-16.7: story memory v2's label filter keeps the scenes carrying the label and their folders.
  const labelView = useLabelFilterView('outline', index)
  const rows = useMemo(() => {
    const all = listOutline(rootIds, childrenOf, sectionOf)
    return labelView === null ? all : all.filter((row) => labelView.visible.has(row.id))
  }, [rootIds, childrenOf, sectionOf, labelView])

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
  // Which planned scenes each written scene fulfils (F-16.21: in v2 the automatic links too).
  const aiLinks = usePlanLinksStore((s) => s.aiLinks)
  const fulfils = new Map<string, string[]>()
  for (const row of rows) {
    const by = metas[row.id]?.content?.fulfilledBy
    if (by !== undefined && byId[by] !== undefined)
      fulfils.set(by, [...(fulfils.get(by) ?? []), row.id])
  }
  if (memory === 'v2') {
    for (const link of aiLinks) {
      if (byId[link.sceneId] === undefined || byId[link.planId] === undefined) continue
      fulfils.set(link.sceneId, [...(fulfils.get(link.sceneId) ?? []), link.planId])
    }
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

  const filterBar = memory === 'v2' ? <LabelFilterBar surface="outline" /> : null
  if (rows.length === 0) {
    return (
      <>
        {filterBar}
        <p className="m-0 p-3 text-sm text-fg-muted">
          {labelView === null ? 'The manuscript is empty.' : 'No scene carries this label.'}
        </p>
      </>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {filterBar}
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

/**
 * F-11.1d: runs the plan-link job now; shown only while Plan links may run. F-16.21: never in
 * story memory v2, where plans are linked after each reading.
 */
function FindLinksButton(): React.JSX.Element | null {
  const settings = useAiSettingsStore((s) => s.settings)
  const running = usePlanLinksStore((s) => s.running)
  const run = usePlanLinksStore((s) => s.run)
  const memory = useStoryMemory()
  if (memory === 'v2') return null
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

/**
 * F-11.1d: a row's plan links. A planned scene shows the scene that fulfils it (with Unlink) or
 * the AI's suggestion for it; a written scene shows the planned scenes it fulfils and the beat
 * the AI suggests for it. Suggestions carry Confirm and Dismiss. Story memory v2 has its own
 * lines (`PlanLinkLinesV2`).
 */
function PlanLinkLines({
  id,
  fulfils,
  progress
}: {
  id: string
  fulfils: string[]
  progress: SceneProgress | null
}): React.JSX.Element {
  const memory = useStoryMemory()
  return memory === 'v2' ? (
    <PlanLinkLinesV2 id={id} fulfils={fulfils} progress={progress} />
  ) : (
    <PlanLinkLinesV1 id={id} fulfils={fulfils} />
  )
}

/**
 * F-16.21 (story memory v2, decision 2): a planned scene shows the scene that fulfils it: the
 * author's link with *Unlink*, or a link applied automatically with an AI mark, why, *Keep* and
 * *Unlink*; with neither it reads *Not yet drafted*. A written scene shows the plans it fulfils.
 */
function PlanLinkLinesV2({
  id,
  fulfils,
  progress
}: {
  id: string
  fulfils: string[]
  progress: SceneProgress | null
}): React.JSX.Element {
  const byId = useTreeStore((s) => s.byId)
  const select = useTreeStore((s) => s.select)
  const fulfilledBy = useSceneMetaStore((s) => s.docs[id]?.content?.fulfilledBy)
  const aiLink = usePlanLinksStore((s) => s.aiLinks.find((link) => link.planId === id))
  const aiLinks = usePlanLinksStore((s) => s.aiLinks)
  const keep = usePlanLinksStore((s) => s.keep)
  const unlink = usePlanLinksStore((s) => s.unlink)
  const linkClass = 'rounded px-0.5 text-left underline-offset-2 hover:underline'
  const actionClass =
    'rounded border border-line px-1 text-[11px] text-fg-muted hover:bg-surface-raised hover:text-fg'
  const linkedByAuthor = fulfilledBy !== undefined ? byId[fulfilledBy] : undefined
  // Design §2.7: Not yet drafted is no link to a drafted scene. The author's link to a scene with
  // no words yet is kept as a note under it, and the plan stays on the story map.
  const mine =
    linkedByAuthor !== undefined && linkedByAuthor.wordCount > 0 ? linkedByAuthor : undefined
  const pending = linkedByAuthor !== undefined && mine === undefined ? linkedByAuthor : undefined
  const auto =
    aiLink !== undefined && linkedByAuthor === undefined ? byId[aiLink.sceneId] : undefined
  const by = mine ?? auto
  const linkedId =
    mine !== undefined ? fulfilledBy : auto !== undefined ? aiLink?.sceneId : undefined
  return (
    <>
      {by !== undefined && linkedId !== undefined ? (
        <p
          data-testid="outline-fulfilled"
          data-origin={mine !== undefined ? 'author' : aiLink?.origin}
          className="m-0 flex flex-wrap items-center gap-1 pl-4 text-xs text-fg-muted"
        >
          Fulfilled by{' '}
          <button type="button" className={linkClass} onClick={() => select(linkedId)}>
            {by.title}
          </button>
          {mine === undefined ? (
            <AiMark
              title={
                aiLink?.origin === 'ai'
                  ? 'Linked by the AI (it chose between two close scenes)'
                  : 'Linked by the app: the scene’s card matches this plan'
              }
            />
          ) : null}
          {mine === undefined && aiLink?.reason ? (
            <span className="min-w-0 italic">{aiLink.reason}</span>
          ) : null}
          {mine === undefined ? (
            <button type="button" className={actionClass} onClick={() => void keep(id)}>
              Keep
            </button>
          ) : null}
          <button
            type="button"
            className={actionClass}
            onClick={() => void unlink({ kind: 'scene', nodeId: id })}
          >
            Unlink
          </button>
        </p>
      ) : progress === 'planned' ? (
        <p
          data-testid="outline-not-drafted"
          className="m-0 flex flex-wrap items-center gap-1 pl-4 text-xs text-fg-subtle"
        >
          Not yet drafted
          {pending !== undefined && fulfilledBy !== undefined ? (
            <span data-testid="outline-linked-unwritten" className="flex items-center gap-1">
              · linked to{' '}
              <button type="button" className={linkClass} onClick={() => select(fulfilledBy)}>
                {pending.title}
              </button>{' '}
              (no words yet)
              <button
                type="button"
                className={actionClass}
                onClick={() => void unlink({ kind: 'scene', nodeId: id })}
              >
                Unlink
              </button>
            </span>
          ) : null}
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
          {aiLinks.some((link) => link.planId === planId && link.sceneId === id) ? (
            <AiMark title="Linked automatically" />
          ) : null}
        </p>
      ))}
    </>
  )
}

function PlanLinkLinesV1({ id, fulfils }: { id: string; fulfils: string[] }): React.JSX.Element {
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
  const memory = useStoryMemory()
  const aiSummary = useSummaryStore((s) => s.byNode[id]?.summary?.summary ?? null)
  // F-9.14: the scene card under the synopsis or summary (v1's knowledge card).
  const card = useSummaryStore((s) => s.byNode[id]?.card ?? null)
  const loadSummary = useSummaryStore((s) => s.load)
  // F-16.20: in v2 the card line of the reader's card stands in for an empty synopsis.
  const cardLine = useMemoryStore((s) => s.cardLines[id] ?? null)
  const isDocument = node?.kind === 'document'

  useEffect(() => {
    void loadMeta(id)
    return () => unloadMeta(id)
  }, [id, loadMeta, unloadMeta])

  useEffect(() => {
    // Only manuscript documents have summaries; a folder would only fetch "unavailable". A v2
    // project has none to read (`summary:get` is v1's).
    if (isDocument && memory === 'v1') void loadSummary(id)
  }, [id, isDocument, loadSummary, memory])

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
      ) : memory === 'v2' ? (
        cardLine !== null ? (
          <AiSummaryLine
            summary={cardLine}
            kind="card"
            testId="outline-card-line"
            className="line-clamp-2 pl-4"
          />
        ) : null
      ) : aiSummary !== null ? (
        <AiSummaryLine
          summary={aiSummary}
          testId="outline-ai-summary"
          className="line-clamp-2 pl-4"
        />
      ) : null}
      {card !== null && memory === 'v1' ? <SceneCardView card={card} compact /> : null}
      {isDocument ? <PlanLinkLines id={id} fulfils={fulfils} progress={progress} /> : null}
    </li>
  )
}
