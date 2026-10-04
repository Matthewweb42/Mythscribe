import { useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useTagStore } from './tagStore'

const FIELD = 'min-w-0 rounded-md border border-line bg-bg px-2 py-1 text-sm'
const BUTTON =
  'shrink-0 rounded-md border border-line px-2 py-1 text-xs hover:bg-surface-raised disabled:opacity-50 disabled:hover:bg-transparent'

/** "3 tags" / "1 tag". */
function tagsLabel(count: number): string {
  return count === 1 ? '1 tag' : `${count} tags`
}

interface TagBulkBarProps {
  /** The checked tags still visible, in list order; every action applies to exactly these. */
  ids: string[]
  /** The visible tags, for "All". */
  visibleIds: string[]
  onChange: (ids: string[]) => void
  /** Leaves select mode. */
  onDone: () => void
}

/**
 * The bulk bar of the Tags tab's select mode (F-4.9), in place of the create form: recolor,
 * merge, or delete the checked tags. The color applies on pick, coalesced like the detail view's
 * (one write in flight plus the latest pick). Merge keeps the chosen tag and folds the others
 * into it; merge and delete ask first because neither can be undone. Rows wrap so the bar fits
 * the sidebar minimum.
 */
export function TagBulkBar({
  ids,
  visibleIds,
  onChange,
  onDone
}: TagBulkBarProps): React.JSX.Element {
  const recolorMany = useTagStore((s) => s.recolorMany)
  const removeMany = useTagStore((s) => s.removeMany)
  const mergeInto = useTagStore((s) => s.mergeInto)
  const tags = useTagStore(useShallow((s) => ids.flatMap((id) => s.byId[id] ?? [])))
  const [busy, setBusy] = useState(false)
  /** The chosen merge target; the first checked tag when unset or no longer checked. */
  const [chosenTarget, setChosenTarget] = useState<string | null>(null)
  const target = tags.find((tag) => tag.id === chosenTarget) ?? tags[0]
  /** The color as picked, shown until main confirms it; null shows the first checked tag's. */
  const [draftColor, setDraftColor] = useState<string | null>(null)
  const colorInflight = useRef(false)
  const colorQueued = useRef<{ ids: string[]; color: string } | null>(null)
  const count = tags.length

  const pushColor = async (targets: string[], color: string): Promise<void> => {
    if (colorInflight.current) {
      colorQueued.current = { ids: targets, color }
      return
    }
    colorInflight.current = true
    try {
      await recolorMany(targets, color)
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      colorInflight.current = false
      const queued = colorQueued.current
      colorQueued.current = null
      if (queued !== null) void pushColor(queued.ids, queued.color)
      else setDraftColor(null)
    }
  }

  const merge = async (): Promise<void> => {
    if (!target || count < 2 || busy) return
    const sourceIds = ids.filter((id) => id !== target.id)
    const ok = await dialogs.confirm({
      title: `Merge ${tagsLabel(sourceIds.length)} into "${target.name}"?`,
      message: `Their documents move to "${target.name}" and the merged tags are deleted. This cannot be undone.`,
      confirmLabel: 'Merge',
      danger: true
    })
    if (!ok) return
    setBusy(true)
    try {
      await mergeInto(target.id, sourceIds)
      toast.success(`Merged ${tagsLabel(sourceIds.length)} into "${target.name}"`)
      onChange([target.id])
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (count === 0 || busy) return
    const ok = await dialogs.confirm({
      title: `Delete ${tagsLabel(count)}?`,
      message: 'This removes them from every document. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    setBusy(true)
    try {
      await removeMany(ids)
      toast.success(`Deleted ${tagsLabel(count)}`)
      onChange([])
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="group"
      aria-label="Selected tags"
      className="flex shrink-0 flex-col gap-1.5 border-t border-line p-2"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-auto text-xs text-fg-muted" aria-live="polite">
          {count} selected
        </span>
        <button
          type="button"
          onClick={() => onChange(visibleIds)}
          disabled={visibleIds.length === 0}
          className={BUTTON}
        >
          All
        </button>
        <button
          type="button"
          onClick={() => onChange([])}
          disabled={count === 0}
          className={BUTTON}
        >
          None
        </button>
        <button type="button" onClick={onDone} className={BUTTON}>
          Done
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          type="color"
          aria-label="Color for selected tags"
          disabled={count === 0 || busy}
          value={draftColor ?? tags[0]?.color ?? '#000000'}
          onChange={(event) => {
            setDraftColor(event.target.value)
            void pushColor(ids, event.target.value)
          }}
          className="h-8 w-10 shrink-0 cursor-pointer rounded-md border border-line bg-bg p-0.5 disabled:cursor-default disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void remove()}
          disabled={count === 0 || busy}
          className="ml-auto shrink-0 rounded-md border border-danger px-2 py-1 text-xs text-danger hover:bg-danger hover:text-danger-fg disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-danger"
        >
          Delete
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <select
          aria-label="Merge into"
          value={target?.id ?? ''}
          disabled={count < 2 || busy}
          onChange={(event) => setChosenTarget(event.target.value)}
          className={`${FIELD} min-w-24 flex-1`}
        >
          {tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void merge()}
          disabled={count < 2 || busy}
          className={BUTTON}
        >
          Merge
        </button>
      </div>
    </div>
  )
}
