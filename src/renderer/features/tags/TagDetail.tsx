import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { Tag } from '@shared/ipc/contract'
import { TAG_CATEGORIES, TAG_CATEGORY_LABEL, TAG_NAME_MAX, TagCategory } from '@shared/tags'
import { openMention } from '@renderer/features/editor/openPassage'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import { describeError } from '@renderer/lib/errors'
import { useDocumentTagStore } from './documentTagStore'
import { useMentionStore } from './mentionStore'
import { useTagStore } from './tagStore'
import { sceneRowsForTag } from './tagUsage'

const FIELD = 'min-w-0 rounded-md border border-line bg-bg px-2 py-1 text-sm'
/** Label above control, so a long category label never fights the sidebar's minimum width. */
const ROW = 'flex flex-col gap-1 text-sm'

const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })

/** "Used in 3 documents" / "Used in 1 document". */
function usedInLabel(count: number): string {
  return count === 1 ? 'Used in 1 document' : `Used in ${count} documents`
}

/** "Mentioned in 3 documents" / "Mentioned in 1 document" / "Not mentioned" (F-4.12). */
function mentionedInLabel(count: number): string {
  if (count === 0) return 'Not mentioned'
  return count === 1 ? 'Mentioned in 1 document' : `Mentioned in ${count} documents`
}

interface TagDetailProps {
  tag: Tag
  onBack: () => void
  /** Called after a confirmed delete succeeded; the parent closes the view. */
  onDeleted: () => void
  /** Bumped to focus and select the name field (a double-click or F2 on the tag's row, 2026-10-07). */
  focusName?: number
}

/**
 * The detail view of one tag (F-4.2): the name edits inline (Enter or blur commits, Escape
 * restores), the color and category write at once, and Delete asks first because it strips the
 * tag from every document. Every write goes through the tag store and merges what main returns
 * (the name comes back kebab-cased, so the field re-syncs from the stored row). The Documents
 * section (F-4.10) lists what carries the tag in tree order, opens a row in the editor, and
 * hands the tree the same filter through "Show in tree". The Mentions section (F-4.12) lists
 * where main's scan found the tag's name, apart from those explicit links, and a row jumps to
 * the first occurrence; "Track mentions" turns the scan off for this tag, which drops its
 * recorded rows in main and hides the section.
 */
export function TagDetail({
  tag,
  onBack,
  onDeleted,
  focusName = 0
}: TagDetailProps): React.JSX.Element {
  const update = useTagStore((s) => s.update)
  const remove = useTagStore((s) => s.remove)
  const byId = useTreeStore((s) => s.byId)
  const index = useTreeStore(useShallow((s) => ({ rootIds: s.rootIds, childrenOf: s.childrenOf })))
  const tagIdsByNode = useDocumentTagStore((s) => s.tagIdsByNode)
  const mentions = useMentionStore((s) => s.byTag[tag.id])
  const [busy, setBusy] = useState(false)
  /** The color as picked, shown until main confirms it; null when the field shows the stored color. */
  const [draftColor, setDraftColor] = useState<string | null>(null)
  // The native picker fires a change per drag step, so at most one write is on the wire and the
  // latest pick is sent when it lands: a slow write never floods main or reorders colors.
  const colorInflight = useRef(false)
  const colorQueued = useRef<string | null>(null)
  const renameInflight = useRef(false)
  const nameField = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (focusName === 0) return
    nameField.current?.focus()
    nameField.current?.select()
  }, [focusName])

  const report = (err: unknown): void => {
    toast.error(describeError(err))
  }

  // The links may have been made elsewhere (the tag bar, inline tags, AI recommendations), so the
  // whole map is refreshed whenever a tag's detail opens; the chips keep it live in between.
  useEffect(() => {
    useDocumentTagStore
      .getState()
      .loadAll()
      .catch((err: unknown) => toast.error(describeError(err)))
  }, [tag.id])

  // F-4.12: main scans on save and pushes `mention:changed`, which refreshes this list; the
  // first read is asked for here, so the section is current whenever a detail opens.
  useEffect(() => {
    useMentionStore
      .getState()
      .loadForTag(tag.id)
      .catch((err: unknown) => toast.error(describeError(err)))
  }, [tag.id])

  // One walk of the tree for both lists (F-9.4's `sceneRowsForTag`, which the entity page reads
  // too): the links and the recorded mentions in one display order, split here by what each row is.
  const rows = useMemo(
    () => sceneRowsForTag(index, byId, tagIdsByNode, mentions, tag.id),
    [index, byId, tagIdsByNode, mentions, tag.id]
  )
  const documents = useMemo(() => rows.filter((row) => row.tagged), [rows])
  const mentioned = useMemo(() => rows.filter((row) => row.mentionCount > 0), [rows])

  const setTracking = async (trackMentions: boolean): Promise<void> => {
    try {
      await update(tag.id, { trackMentions })
    } catch (err) {
      report(err)
    }
  }

  const showInTree = (): void => {
    useTreeStore.getState().setTagFilter(tag.id)
    useLayoutStore.getState().setSidebarTab('manuscript')
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
          ref={nameField}
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
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={tag.trackMentions}
          onChange={(event) => void setTracking(event.target.checked)}
        />
        <span className="text-xs text-fg-muted">Track mentions</span>
      </label>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-fg-muted">Usage</dt>
        <dd className="m-0">{usedInLabel(tag.usageCount)}</dd>
        <dt className="text-fg-muted">Mentions</dt>
        <dd className="m-0">{mentionedInLabel(mentioned.length)}</dd>
        <dt className="text-fg-muted">Created</dt>
        <dd className="m-0">{formatDate(tag.created)}</dd>
        <dt className="text-fg-muted">Modified</dt>
        <dd className="m-0">{formatDate(tag.modified)}</dd>
      </dl>
      <section className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <h3 className="m-0 text-xs font-normal text-fg-muted">Documents</h3>
          <button
            type="button"
            onClick={showInTree}
            className="shrink-0 rounded-md border border-line px-2 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg"
          >
            Show in tree
          </button>
        </div>
        {documents.length === 0 ? (
          <p className="m-0 text-xs text-fg-muted">No documents carry this tag.</p>
        ) : (
          <ul role="list" aria-label="Documents with this tag" className="m-0 list-none p-0">
            {documents.map((document) => (
              <li key={document.id}>
                <button
                  type="button"
                  onClick={() => useTreeStore.getState().select(document.id)}
                  className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none"
                >
                  <span className="min-w-0 flex-1 truncate">{document.title}</span>
                  {document.parentTitle === null ? null : (
                    <span className="shrink-0 truncate text-xs text-fg-subtle">
                      {document.parentTitle}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {tag.trackMentions && mentioned.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h3 className="m-0 text-xs font-normal text-fg-muted">Mentions</h3>
          <ul role="list" aria-label="Documents mentioning this tag" className="m-0 list-none p-0">
            {mentioned.map((document) => (
              <li key={document.id}>
                <button
                  type="button"
                  onClick={() => void openMention(document.id, document.first ?? [0, 0], tag.name)}
                  className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none"
                >
                  <span className="min-w-0 flex-1 truncate">{document.title}</span>{' '}
                  <span className="shrink-0 text-xs text-fg-subtle tabular-nums">
                    ×{document.mentionCount}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
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
