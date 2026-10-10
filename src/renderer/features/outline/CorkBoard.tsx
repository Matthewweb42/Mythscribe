import { useEffect, useId, useRef, useState } from 'react'
import { GripVertical } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { NovelFormat } from '@shared/ipc/contract'
import type { SectionType } from '@shared/labels'
import { SCENE_SYNOPSIS_MAX, type SceneMeta } from '@shared/sceneMeta'
import { EmptyFolder } from '@renderer/features/editor/StackedEditor'
import { useSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import { useSummaryStore } from '@renderer/features/editor/summaryStore'
import { LevelIcon } from '@renderer/features/manuscript/LevelIcon'
import type { DropTarget } from '@renderer/features/manuscript/placement'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { cardDropTarget, cardStepTarget, type CardSide } from './cardMove'
import { FOLDER_VIEWS, FOLDER_VIEW_LABEL, useOutlineViewStore } from './outlineViewStore'
import { AiSummaryLine, StatusSelect } from './status'
import { STATUS_BG } from './statusColors'

const NO_CHILDREN: string[] = []

/** The half of the hovered card the pointer is in, split at its horizontal middle. */
function sideAt(event: React.DragEvent<HTMLElement>): CardSide {
  const rect = event.currentTarget.getBoundingClientRect()
  return rect.width > 0 && event.clientX - rect.left >= rect.width / 2 ? 'after' : 'before'
}

/** Runs a tree move and toasts a failure where the author sees it. */
function runMove(id: string, target: DropTarget, then?: () => void): void {
  useTreeStore
    .getState()
    .move(id, target.parentId, target.afterId)
    .then(then)
    .catch((err: unknown) => toast.error(describeError(err)))
}

/**
 * The folder view switch of the main pane's header (F-11.1): the documents stacked for writing
 * (F-3.8), or the folder's children as index cards. Two pressed-state buttons, like the entity
 * tabs' list/card switch (F-9.2).
 */
export function FolderViewToggle(): React.JSX.Element {
  const view = useOutlineViewStore((s) => s.folderView)
  const setView = useOutlineViewStore((s) => s.setFolderView)
  return (
    <div
      role="group"
      aria-label="Folder view"
      className="flex shrink-0 gap-0.5 rounded-md border border-line p-0.5"
    >
      {FOLDER_VIEWS.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === view}
          onClick={() => setView(option)}
          className="rounded px-2 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg aria-pressed:bg-surface-raised aria-pressed:text-fg"
        >
          {FOLDER_VIEW_LABEL[option]}
        </button>
      ))}
    </div>
  )
}

interface DragState {
  id: string
  over: { id: string; side: CardSide } | null
}

/**
 * The cork board (F-11.1): the selected folder's direct children, in tree order, as index cards
 * in a responsive grid. A part's board shows its chapters, a chapter's its scenes. Each card
 * carries the node's status as a coloured stripe, its level icon, title (opens the node), word
 * count, the author's synopsis (editable in place), and a status picker; both write the node's
 * scene metadata through `useSceneMetaStore`, the same record the metadata pane edits. With no
 * synopsis, a manuscript scene shows its AI summary (F-5.6) greyed with an AI mark, for display
 * only: it is never copied into the synopsis. Cards reorder by dragging one onto another (the
 * pointer's horizontal half picks before or after) or with Alt+ArrowLeft / Alt+ArrowRight, both
 * through the tree store's `move` (F-2.4), so the Manuscript tree follows at once. The folder's
 * own tags are in the tags column.
 */
export function CorkBoard({
  folderId,
  format
}: {
  folderId: string
  format: NovelFormat
}): React.JSX.Element {
  const childIds = useTreeStore(useShallow((s) => s.childrenOf[folderId] ?? NO_CHILDREN))
  const section = useTreeStore((s) => s.sectionOf[folderId] ?? 'manuscript')
  const [drag, setDrag] = useState<DragState | null>(null)
  const titles = useRef(new Map<string, HTMLButtonElement>())

  if (childIds.length === 0)
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <EmptyFolder folderId={folderId} format={format} section={section} />
      </div>
    )

  const setOver = (over: DragState['over']): void => {
    setDrag((current) => {
      if (!current) return current
      if (current.over?.id === over?.id && current.over?.side === over?.side) return current
      return { ...current, over }
    })
  }

  const handlers: CardHandlers = {
    onStart(id, event) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', id)
      setDrag({ id, over: null })
    },
    onOver(id, event) {
      const side = sideAt(event)
      const target = drag ? cardDropTarget(useTreeStore.getState(), drag.id, id, side) : null
      if (!target) {
        event.dataTransfer.dropEffect = 'none'
        setOver(null)
        return
      }
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setOver({ id, side })
    },
    onDrop(id, event) {
      event.preventDefault()
      const target = drag
        ? cardDropTarget(useTreeStore.getState(), drag.id, id, sideAt(event))
        : null
      setDrag(null)
      if (drag && target) runMove(drag.id, target)
    },
    onEnd() {
      setDrag(null)
    },
    onStep(id, step) {
      const target = cardStepTarget(useTreeStore.getState(), id, step)
      // The card's element moves in the DOM, which can drop the focus; give it back.
      if (target) runMove(id, target, () => titles.current.get(id)?.focus())
    },
    register(id, element) {
      if (element) titles.current.set(id, element)
      else titles.current.delete(id)
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ol
        aria-label="Cork board"
        className="m-0 grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4 overflow-y-auto bg-page p-4"
        onDragLeave={(event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          )
            setOver(null)
        }}
      >
        {childIds.map((id) => (
          <IndexCard
            key={id}
            id={id}
            section={section}
            dragging={drag?.id === id}
            dropSide={drag?.over?.id === id ? drag.over.side : null}
            handlers={handlers}
          />
        ))}
      </ol>
    </div>
  )
}

interface CardHandlers {
  onStart: (id: string, event: React.DragEvent<HTMLElement>) => void
  onOver: (id: string, event: React.DragEvent<HTMLElement>) => void
  onDrop: (id: string, event: React.DragEvent<HTMLElement>) => void
  onEnd: () => void
  onStep: (id: string, step: -1 | 1) => void
  register: (id: string, element: HTMLButtonElement | null) => void
}

/**
 * One index card. It holds the node's scene metadata for as long as it is on the board (the
 * store counts holders, so the metadata pane may hold the same node), and fetches the summary
 * of a manuscript document for the AI fallback.
 */
function IndexCard({
  id,
  section,
  dragging,
  dropSide,
  handlers
}: {
  id: string
  section: SectionType
  dragging: boolean
  dropSide: CardSide | null
  handlers: CardHandlers
}): React.JSX.Element | null {
  const node = useTreeStore((s) => s.byId[id])
  const words = useTreeStore((s) => s.wordCountRollup[id] ?? 0)
  const busy = useTreeStore((s) => s.busy)
  const select = useTreeStore((s) => s.select)
  const meta = useSceneMetaStore((s) => s.docs[id]?.content ?? null)
  const load = useSceneMetaStore((s) => s.load)
  const unload = useSceneMetaStore((s) => s.unload)
  const edit = useSceneMetaStore((s) => s.edit)
  const summary = useSummaryStore((s) => s.byNode[id]?.summary?.summary ?? null)
  const loadSummary = useSummaryStore((s) => s.load)
  const synopsisId = useId()
  const hasSummary = node?.kind === 'document' && section === 'manuscript'

  useEffect(() => {
    load(id).catch((err: unknown) => toast.error(describeError(err)))
    return () => unload(id)
  }, [id, load, unload])

  useEffect(() => {
    if (hasSummary) void loadSummary(id)
  }, [id, hasSummary, loadSummary])

  if (!node) return null

  const status = meta?.status ?? 'none'
  const synopsis = meta?.synopsis ?? ''
  const set = (patch: Partial<SceneMeta>): void => {
    if (meta !== null) edit(id, { ...meta, ...patch })
  }

  return (
    <li
      aria-label={node.title}
      data-card-id={id}
      data-drop={dropSide ?? undefined}
      onDragOver={(event) => handlers.onOver(id, event)}
      onDrop={(event) => handlers.onDrop(id, event)}
      onKeyDown={(event) => {
        if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
        // Inside the synopsis or the picker the keys keep their usual meaning.
        if (
          event.target instanceof HTMLTextAreaElement ||
          event.target instanceof HTMLSelectElement
        )
          return
        event.preventDefault()
        handlers.onStep(id, event.key === 'ArrowLeft' ? -1 : 1)
      }}
      className={`relative flex min-w-0 list-none flex-col overflow-visible rounded-md border border-line bg-bg shadow-sm ${
        dragging ? 'opacity-50' : ''
      }`}
    >
      {dropSide !== null ? (
        <span
          aria-hidden="true"
          className={`absolute inset-y-0 w-1 rounded-full bg-accent ${
            dropSide === 'before' ? '-left-2.5' : '-right-2.5'
          }`}
        />
      ) : null}
      <span
        aria-hidden="true"
        data-testid="card-status-stripe"
        className={`h-1.5 shrink-0 rounded-t-md ${status === 'none' ? 'bg-line' : STATUS_BG[status]}`}
      />
      <div
        draggable={!busy}
        onDragStart={(event) => handlers.onStart(id, event)}
        onDragEnd={handlers.onEnd}
        title="Drag to reorder, or Alt+Left / Alt+Right"
        className="flex min-w-0 cursor-grab items-center gap-1.5 px-2 pt-2"
      >
        <GripVertical size={14} aria-hidden="true" className="shrink-0 text-fg-subtle" />
        <LevelIcon node={node} section={section} expanded={false} />
        <button
          ref={(element) => handlers.register(id, element)}
          type="button"
          onClick={() => select(id)}
          aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
          className="min-w-0 flex-1 truncate rounded-md px-1 py-0.5 text-left text-sm font-medium hover:bg-surface-raised"
        >
          {node.title}
        </button>
        <span data-testid="card-words" className="shrink-0 text-xs text-fg-subtle">
          {`${words.toLocaleString()} words`}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-1 px-2 pt-1 pb-2">
        <label htmlFor={synopsisId} className="sr-only">
          Synopsis
        </label>
        <textarea
          id={synopsisId}
          rows={3}
          value={synopsis}
          placeholder="Write a synopsis"
          maxLength={SCENE_SYNOPSIS_MAX}
          disabled={meta === null}
          onChange={(event) => set({ synopsis: event.target.value })}
          className="w-full resize-none rounded-md border border-transparent bg-transparent px-1 py-0.5 text-sm hover:border-line focus:border-line disabled:opacity-50"
        />
        {synopsis.length === 0 && summary !== null ? (
          <AiSummaryLine summary={summary} testId="card-ai-summary" className="line-clamp-4 px-1" />
        ) : null}
        <StatusSelect
          value={status}
          onChange={(next) => set({ status: next })}
          disabled={meta === null}
          labelClassName="sr-only"
          className="mt-auto"
        />
      </div>
    </li>
  )
}
