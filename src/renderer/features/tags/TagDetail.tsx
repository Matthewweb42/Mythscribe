import { useRef, useState } from 'react'
import { ChevronLeft } from 'lucide-react'
import type { Tag } from '@shared/ipc/contract'
import { TAG_CATEGORIES, TAG_CATEGORY_LABEL, TAG_NAME_MAX, TagCategory } from '@shared/tags'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useTagStore } from './tagStore'

const FIELD = 'min-w-0 rounded-md border border-line bg-bg px-2 py-1 text-sm'
/** Label above control, so a long category label never fights the sidebar's minimum width. */
const ROW = 'flex flex-col gap-1 text-sm'

const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })

/** "Used in 3 documents" / "Used in 1 document". */
function usedInLabel(count: number): string {
  return count === 1 ? 'Used in 1 document' : `Used in ${count} documents`
}

interface TagDetailProps {
  tag: Tag
  onBack: () => void
  /** Called after a confirmed delete succeeded; the parent closes the view. */
  onDeleted: () => void
}

/**
 * The detail view of one tag (F-4.2): the name edits inline (Enter or blur commits, Escape
 * restores), the color and category write at once, and Delete asks first because it strips the
 * tag from every document. Every write goes through the tag store and merges what main returns
 * (the name comes back kebab-cased, so the field re-syncs from the stored row).
 */
export function TagDetail({ tag, onBack, onDeleted }: TagDetailProps): React.JSX.Element {
  const update = useTagStore((s) => s.update)
  const remove = useTagStore((s) => s.remove)
  const [busy, setBusy] = useState(false)
  /** The color as picked, shown until main confirms it; null when the field shows the stored color. */
  const [draftColor, setDraftColor] = useState<string | null>(null)
  // The native picker fires a change per drag step, so at most one write is on the wire and the
  // latest pick is sent when it lands: a slow write never floods main or reorders colors.
  const colorInflight = useRef(false)
  const colorQueued = useRef<string | null>(null)
  const renameInflight = useRef(false)

  const report = (err: unknown): void => {
    toast.error(describeError(err))
  }

  const commitName = async (value: string): Promise<void> => {
    const next = value.trim()
    if (renameInflight.current || next.length === 0 || next === tag.name) return
    renameInflight.current = true
    try {
      await update(tag.id, { name: next })
    } catch (err) {
      report(err)
    } finally {
      renameInflight.current = false
    }
  }

  const pushColor = async (color: string): Promise<void> => {
    if (colorInflight.current) {
      colorQueued.current = color
      return
    }
    colorInflight.current = true
    try {
      await update(tag.id, { color })
    } catch (err) {
      report(err)
    } finally {
      colorInflight.current = false
      const queued = colorQueued.current
      colorQueued.current = null
      if (queued !== null) void pushColor(queued)
      else setDraftColor(null)
    }
  }

  const changeCategory = async (category: TagCategory): Promise<void> => {
    if (category === tag.category) return
    try {
      await update(tag.id, { category })
    } catch (err) {
      report(err)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    const ok = await dialogs.confirm({
      title: `Delete "${tag.name}"?`,
      message: 'This removes the tag from every document. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    setBusy(true)
    try {
      await remove(tag.id)
      onDeleted()
    } catch (err) {
      report(err)
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto p-2">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 self-start rounded-md py-0.5 pr-2 pl-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg"
      >
        <ChevronLeft size={14} aria-hidden="true" />
        Back
      </button>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs text-fg-muted">Name</span>
        <input
          key={tag.name}
          aria-label="Tag name"
          defaultValue={tag.name}
          maxLength={TAG_NAME_MAX}
          onBlur={(event) => void commitName(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void commitName(event.currentTarget.value)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.currentTarget.value = tag.name
            }
          }}
          className={FIELD}
        />
      </label>
      <label className={ROW}>
        <span className="text-xs text-fg-muted">Color</span>
        <span className="flex items-center gap-2">
          <code className="text-xs text-fg-subtle">{draftColor ?? tag.color}</code>
          <input
            type="color"
            aria-label="Color"
            value={draftColor ?? tag.color}
            onChange={(event) => {
              setDraftColor(event.target.value)
              void pushColor(event.target.value)
            }}
            className="h-8 w-10 cursor-pointer rounded-md border border-line bg-bg p-0.5"
          />
        </span>
      </label>
      <label className={ROW}>
        <span className="text-xs text-fg-muted">Category</span>
        <select
          aria-label="Category"
          value={tag.category}
          onChange={(event) => void changeCategory(TagCategory.parse(event.target.value))}
          className={`${FIELD} w-full`}
        >
          {TAG_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {TAG_CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>
      </label>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-fg-muted">Usage</dt>
        <dd className="m-0">{usedInLabel(tag.usageCount)}</dd>
        <dt className="text-fg-muted">Created</dt>
        <dd className="m-0">{formatDate(tag.created)}</dd>
        <dt className="text-fg-muted">Modified</dt>
        <dd className="m-0">{formatDate(tag.modified)}</dd>
      </dl>
      <button
        type="button"
        disabled={busy}
        onClick={() => void confirmDelete()}
        className="mt-auto self-start rounded-md border border-danger px-2 py-1 text-xs text-danger hover:bg-danger hover:text-danger-fg disabled:opacity-50"
      >
        Delete tag
      </button>
    </div>
  )
}
