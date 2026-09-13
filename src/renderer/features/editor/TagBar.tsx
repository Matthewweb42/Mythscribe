import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, Plus, Sparkles, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { TAGS_MIN_CHARS } from '@shared/ai'
import { docToText } from '@shared/docText'
import { countInlineTags } from '@shared/inlineTags'
import type { Tag } from '@shared/ipc/contract'
import { TAG_BAR_MAX_FRACTION, TAG_BAR_MIN_HEIGHT, TAG_BAR_SPLIT_LIMITS } from '@shared/layout'
import { formatRequestCost } from '@renderer/features/ai/usageFormat'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import {
  resizeTagBarBy,
  resizeTagBarSplitBy,
  useLayoutStore
} from '@renderer/features/shell/layoutStore'
import { ResizeHandle } from '@renderer/features/shell/ResizeHandle'
import { useDocumentTagStore } from '@renderer/features/tags/documentTagStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { useDocumentStore } from './documentStore'
import { MetadataPane } from './MetadataPane'
import { TagPicker } from './TagPicker'

const BUTTON =
  'flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg aria-expanded:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted'
const LINK_BUTTON = 'rounded px-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg'

/**
 * One Recommend request (F-4.7), keyed by the node it was made for so a document switch drops
 * it without an effect (the `pickingFor` idiom); the suggestions are bank tags, rendered live
 * from the bank by id, and leave the list only when accepted, so a failed link keeps its chip.
 */
type RecommendState =
  | { nodeId: string; status: 'pending' }
  | {
      nodeId: string
      status: 'done'
      suggestions: Tag[]
      model: string
      costUsd: number
      cached: boolean
    }
  | { nodeId: string; status: 'error'; message: string; nextStep: string }

/**
 * The tag bar (F-4.4) above the editor of a document and, in the stacked view, of the chapter or
 * part itself: the linked tags as colored chips with a remove button each, an "Add tag" picker
 * of the unassigned tags, a collapse toggle, and a draggable height (100 px to 60 % of the
 * window), both kept in the app-wide layout. For a node with a hierarchy level (scene, chapter,
 * part) the metadata pane (F-4.5) sits to the left of the tags, behind a draggable split of
 * 30–70 % of the bar's width, also in the layout. Takes only `id`: it loads the node's links
 * itself and reads the tag records from the bank by id, so a rename or recolor in the Tags tab
 * shows here at once. Below the chips, the inline tags used in the text (F-4.6) are listed with
 * their occurrence counts, taken from the document's live content, so they follow the typing
 * before any save; a folder is never loaded as a document, so its bar has no such list.
 * "Recommend" (F-4.7) asks main for bank tags that fit the live text once it has 50 characters
 * (a folder never does, so there it stays disabled) and shows them as chips the author accepts
 * one at a time, all at once, or dismisses; nothing is linked until accepted, and the note
 * under the chips says which model answered and what it cost.
 */
export function TagBar({ id }: { id: string }): React.JSX.Element {
  const tagBar = useLayoutStore((s) => s.layout.tagBar)
  const toggleTagBar = useLayoutStore((s) => s.toggleTagBar)
  const withMetadata = useTreeStore((s) => (s.byId[id]?.hierarchyLevel ?? null) !== null)
  /** The row holding both panes; the split drag is measured against its width. */
  const panes = useRef<HTMLDivElement>(null)
  const ids = useDocumentTagStore((s) => s.tagIdsByNode[id])
  const load = useDocumentTagStore((s) => s.load)
  const add = useDocumentTagStore((s) => s.add)
  const remove = useDocumentTagStore((s) => s.remove)
  const merge = useTagStore((s) => s.merge)
  const content = useDocumentStore((s) => s.docs[id]?.content ?? null)
  const flush = useDocumentStore((s) => s.flush)
  const inlineCounts = useMemo(() => (content ? countInlineTags(content) : {}), [content])
  const inlineIds = Object.keys(inlineCounts)
  const textLength = useMemo(() => (content ? docToText(content).length : 0), [content])
  const canRecommend = textLength >= TAGS_MIN_CHARS
  /** The node id the picker is open for, so a document switch closes it without an effect. */
  const [pickingFor, setPickingFor] = useState<string | null>(null)
  const picking = pickingFor === id
  const [recommend, setRecommend] = useState<RecommendState | null>(null)
  const mine = recommend?.nodeId === id ? recommend : null
  const pending = mine?.status === 'pending'
  const bodyId = useId()

  useEffect(() => {
    load(id).catch((err: unknown) => toast.error(describeError(err)))
  }, [id, load])

  const linked = ids ?? []
  const report = (err: unknown): void => {
    toast.error(describeError(err))
  }
  const maxHeight = Math.max(
    TAG_BAR_MIN_HEIGHT,
    Math.round(window.innerHeight * TAG_BAR_MAX_FRACTION)
  )

  // Main reads the saved row, so unsaved typing is flushed first: the request carries what
  // the author sees, and the 50-character gate here and in main agree.
  const askForTags = (): void => {
    const nodeId = id
    setRecommend({ nodeId, status: 'pending' })
    flush()
      .then(() => ipc().invoke('ai:recommendTags', { nodeId }))
      .then((result) => {
        if (result.ok) {
          for (const tag of result.suggestions) merge(tag)
          setRecommend({
            nodeId,
            status: 'done',
            suggestions: result.suggestions,
            model: result.model,
            costUsd: result.costUsd,
            cached: result.cached
          })
        } else {
          setRecommend({
            nodeId,
            status: 'error',
            message: result.message,
            nextStep: result.nextStep
          })
        }
      })
      .catch((err: unknown) => {
        setRecommend((current) => (current?.nodeId === nodeId ? null : current))
        report(err)
      })
  }
  /** Drops accepted suggestions from the result; the result goes with the last one. */
  const settle = (nodeId: string, acceptedIds: string[]): void => {
    setRecommend((current) => {
      if (current?.nodeId !== nodeId || current.status !== 'done') return current
      const suggestions = current.suggestions.filter((tag) => !acceptedIds.includes(tag.id))
      return suggestions.length === 0 ? null : { ...current, suggestions }
    })
  }
  const accept = (tagId: string): void => {
    const nodeId = id
    add(nodeId, tagId).then(() => settle(nodeId, [tagId]), report)
  }
  const acceptAll = (): void => {
    if (mine?.status !== 'done') return
    const nodeId = id
    void Promise.allSettled(
      mine.suggestions.map((tag) => add(nodeId, tag.id).then(() => tag.id))
    ).then((outcomes) => {
      const accepted: string[] = []
      let failure: unknown = null
      for (const outcome of outcomes) {
        if (outcome.status === 'fulfilled') accepted.push(outcome.value)
        else failure ??= outcome.reason
      }
      settle(nodeId, accepted)
      if (failure !== null) report(failure)
    })
  }

  return (
    <div
      role="region"
      aria-label="Tags"
      data-testid="tag-bar"
      className={`relative flex shrink-0 flex-col border-b border-line bg-surface ${tagBar.open ? 'max-h-[60vh]' : ''}`}
      style={tagBar.open ? { height: tagBar.height } : undefined}
    >
      <div className="flex shrink-0 items-center gap-2 px-4 py-1">
        <button
          type="button"
          aria-expanded={tagBar.open}
          aria-controls={tagBar.open ? bodyId : undefined}
          onClick={toggleTagBar}
          className={BUTTON}
        >
          {tagBar.open ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )}
          <span className="font-medium">Tags</span>
          <span className="text-fg-subtle tabular-nums">{linked.length}</span>
        </button>
        {tagBar.open ? (
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={askForTags}
              disabled={!canRecommend || pending}
              title={
                canRecommend
                  ? undefined
                  : `Add at least ${TAGS_MIN_CHARS} characters to get tag suggestions`
              }
              className={BUTTON}
            >
              {pending ? (
                <Loader2 size={14} aria-hidden="true" className="animate-spin" />
              ) : (
                <Sparkles size={14} aria-hidden="true" />
              )}
              Recommend
            </button>
            <div className="relative">
              <button
                type="button"
                aria-expanded={picking}
                onClick={() => setPickingFor(picking ? null : id)}
                className={BUTTON}
              >
                <Plus size={14} aria-hidden="true" />
                Add tag
              </button>
              {picking ? (
                <TagPicker
                  excludeIds={linked}
                  onPick={(tagId) => {
                    setPickingFor(null)
                    add(id, tagId).catch(report)
                  }}
                  onClose={() => setPickingFor(null)}
                />
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      {tagBar.open ? (
        <div id={bodyId} ref={panes} className="flex min-h-0 flex-1">
          {withMetadata ? (
            <div
              className="relative shrink-0 pr-3 pl-4"
              style={{ width: `${tagBar.split * 100}%` }}
            >
              <MetadataPane id={id} />
              <ResizeHandle
                side="right"
                value={tagBar.split}
                min={TAG_BAR_SPLIT_LIMITS[0]}
                max={TAG_BAR_SPLIT_LIMITS[1]}
                ariaLabel="Resize metadata pane"
                onChange={(deltaPx) =>
                  resizeTagBarSplitBy(deltaPx, panes.current?.clientWidth ?? 0)
                }
              />
            </div>
          ) : null}
          <div className="min-w-0 flex-1 overflow-y-auto px-4 pb-2">
            {mine ? (
              <div role="group" aria-label="Tag suggestions" className="mb-2">
                {mine.status === 'pending' ? (
                  <p role="status" className="m-0 text-xs text-fg-muted">
                    Asking for tag suggestions…
                  </p>
                ) : null}
                {mine.status === 'error' ? (
                  <p
                    role="status"
                    data-testid="tag-recommend-result"
                    className="m-0 text-xs text-danger"
                  >
                    {mine.message} {mine.nextStep}
                  </p>
                ) : null}
                {mine.status === 'done' ? (
                  <>
                    {mine.suggestions.length === 0 ? (
                      <p
                        role="status"
                        data-testid="tag-recommend-result"
                        className="m-0 text-xs text-fg-muted"
                      >
                        No new tags fit.
                      </p>
                    ) : (
                      <ul
                        role="list"
                        aria-label="Suggested tags"
                        className="m-0 flex list-none flex-wrap gap-1.5 p-0"
                      >
                        {mine.suggestions.map((tag) => (
                          <SuggestionChip
                            key={tag.id}
                            id={tag.id}
                            onAccept={() => accept(tag.id)}
                          />
                        ))}
                      </ul>
                    )}
                    <p className="mt-1 mb-0 flex items-center gap-2 text-xs text-fg-subtle">
                      <span data-testid="tag-recommend-cost">
                        {`${mine.model} · ${formatRequestCost(mine.costUsd)}${mine.cached ? ' · cached' : ''}`}
                      </span>
                      {mine.suggestions.length > 0 ? (
                        <button type="button" onClick={acceptAll} className={LINK_BUTTON}>
                          Accept all
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => setRecommend(null)}
                        className={LINK_BUTTON}
                      >
                        Dismiss
                      </button>
                    </p>
                  </>
                ) : null}
              </div>
            ) : null}
            {linked.length === 0 ? (
              <p className="m-0 text-xs text-fg-muted">No tags on this document.</p>
            ) : (
              <ul
                role="list"
                aria-label="Document tags"
                className="m-0 flex list-none flex-wrap gap-1.5 p-0"
              >
                {linked.map((tagId) => (
                  <TagChip
                    key={tagId}
                    id={tagId}
                    onRemove={() => {
                      remove(id, tagId).catch(report)
                    }}
                  />
                ))}
              </ul>
            )}
            {inlineIds.length > 0 ? (
              <>
                <p className="mt-2 mb-1 text-xs text-fg-subtle">Inline tags</p>
                <ul
                  role="list"
                  aria-label="Inline tags"
                  className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0"
                >
                  {inlineIds.map((tagId) => (
                    <InlineTagRow key={tagId} id={tagId} count={inlineCounts[tagId] ?? 0} />
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      {tagBar.open ? (
        <ResizeHandle
          side="bottom"
          value={tagBar.height}
          min={TAG_BAR_MIN_HEIGHT}
          max={maxHeight}
          ariaLabel="Resize tag bar"
          ariaValue={Math.round}
          onChange={resizeTagBarBy}
        />
      ) : null}
    </div>
  )
}

/** One chip: the tag's color dot and name from the bank, and its remove button. Nothing if the tag is gone. */
function TagChip({ id, onRemove }: { id: string; onRemove: () => void }): React.JSX.Element | null {
  const tag = useTagStore(useShallow((s) => s.byId[id]))
  if (!tag) return null
  return (
    <li
      role="listitem"
      className="flex items-center gap-1.5 rounded-full border border-line bg-surface-raised py-0.5 pr-1 pl-2 text-xs"
    >
      <span
        aria-hidden="true"
        style={{ backgroundColor: tag.color }}
        className="size-2.5 shrink-0 rounded-full"
      />
      <span className="max-w-48 truncate">{tag.name}</span>
      <button
        type="button"
        aria-label={`Remove ${tag.name}`}
        title="Remove"
        onClick={onRemove}
        className="rounded-full p-0.5 text-fg-muted hover:bg-surface hover:text-fg"
      >
        <X size={12} aria-hidden="true" />
      </button>
    </li>
  )
}

/** One suggested tag (F-4.7): the bank's color dot and name, and an accept button. Nothing if the tag left the bank. */
function SuggestionChip({
  id,
  onAccept
}: {
  id: string
  onAccept: () => void
}): React.JSX.Element | null {
  const tag = useTagStore(useShallow((s) => s.byId[id]))
  if (!tag) return null
  return (
    <li
      role="listitem"
      className="flex items-center gap-1.5 rounded-full border border-dashed border-line py-0.5 pr-1 pl-2 text-xs"
    >
      <span
        aria-hidden="true"
        style={{ backgroundColor: tag.color }}
        className="size-2.5 shrink-0 rounded-full"
      />
      <span className="max-w-48 truncate">{tag.name}</span>
      <button
        type="button"
        aria-label={`Accept ${tag.name}`}
        title="Add to this document"
        onClick={onAccept}
        className="rounded-full p-0.5 text-fg-muted hover:bg-surface-raised hover:text-fg"
      >
        <Plus size={12} aria-hidden="true" />
      </button>
    </li>
  )
}

/** One inline tag of the text (F-4.6): the bank's color dot and name, and how often it occurs. Nothing if the tag is gone. */
function InlineTagRow({ id, count }: { id: string; count: number }): React.JSX.Element | null {
  const tag = useTagStore(useShallow((s) => s.byId[id]))
  if (!tag) return null
  return (
    <li role="listitem" className="flex items-center gap-1.5 text-xs">
      <span
        aria-hidden="true"
        style={{ backgroundColor: tag.color }}
        className="size-2.5 shrink-0 rounded-full"
      />
      <span className="max-w-48 truncate">{tag.name}</span>{' '}
      <span className="text-fg-subtle tabular-nums">×{count}</span>
    </li>
  )
}
