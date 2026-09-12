import { useEffect, useId, useState } from 'react'
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { TAG_BAR_MAX_FRACTION, TAG_BAR_MIN_HEIGHT } from '@shared/layout'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { resizeTagBarBy, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { ResizeHandle } from '@renderer/features/shell/ResizeHandle'
import { useDocumentTagStore } from '@renderer/features/tags/documentTagStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { describeError } from '@renderer/lib/errors'
import { TagPicker } from './TagPicker'

const BUTTON =
  'flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg aria-expanded:text-fg'

/**
 * The document tag bar (F-4.4) above the single-document editor: the linked tags as colored
 * chips with a remove button each, an "Add tag" picker of the unassigned tags, a collapse
 * toggle, and a draggable height (100 px to 60 % of the window), both kept in the app-wide
 * layout. Takes only `id`: it loads the document's links itself and reads the tag records from
 * the bank by id, so a rename or recolor in the Tags tab shows here at once. The inline-tag
 * occurrence list arrives with F-4.6 and the metadata pane with F-4.5.
 */
export function TagBar({ id }: { id: string }): React.JSX.Element {
  const tagBar = useLayoutStore((s) => s.layout.tagBar)
  const toggleTagBar = useLayoutStore((s) => s.toggleTagBar)
  const ids = useDocumentTagStore((s) => s.tagIdsByNode[id])
  const load = useDocumentTagStore((s) => s.load)
  const add = useDocumentTagStore((s) => s.add)
  const remove = useDocumentTagStore((s) => s.remove)
  /** The node id the picker is open for, so a document switch closes it without an effect. */
  const [pickingFor, setPickingFor] = useState<string | null>(null)
  const picking = pickingFor === id
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
          <div className="relative ml-auto">
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
        ) : null}
      </div>
      {tagBar.open ? (
        <div id={bodyId} className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">
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
