import { Tag as TagIcon } from 'lucide-react'
import { openMention } from '@renderer/features/editor/openPassage'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import type { TagSceneRow } from '@renderer/features/tags/tagUsage'

/**
 * One document an entity reaches, as the entity page lists it (F-9.4, and the appearance log of
 * F-11.2c): the title, the parent folder, "Tagged" when the tag is linked, `×count` for scanned
 * mentions, and any badge the caller adds. A row with a mention jumps to its first occurrence;
 * any other selects the document, which closes the page (F-9.3).
 */
export function SceneRowButton({
  row,
  tagName,
  children
}: {
  row: TagSceneRow
  /** The tag's name, for the jump to a mention; null when the entity has no tag. */
  tagName: string | null
  /** Badges shown before the mention count (the log's "POV"). */
  children?: React.ReactNode
}): React.JSX.Element {
  // F-4.14: the mention may be an alias of the tag, so the jump checks those spellings too.
  const aliases = useTagStore((s) =>
    tagName === null
      ? undefined
      : Object.values(s.byId).find((tag) => tag.name === tagName)?.aliases
  )
  return (
    <button
      type="button"
      onClick={() => {
        if (row.first !== null && tagName !== null) {
          void openMention(row.id, row.first, tagName, aliases)
        } else useTreeStore.getState().select(row.id)
      }}
      className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none"
    >
      <span className="min-w-0 flex-1 truncate">{row.title}</span>
      {row.parentTitle === null ? null : (
        <span className="shrink-0 truncate text-xs text-fg-subtle">{row.parentTitle}</span>
      )}
      {row.tagged ? (
        <span title="Tagged" className="shrink-0 text-fg-subtle">
          <TagIcon size={12} aria-hidden="true" />
          <span className="sr-only">Tagged</span>
        </span>
      ) : null}
      {children}
      {row.mentionCount === 0 ? null : (
        <span className="shrink-0 text-xs text-fg-subtle tabular-nums">×{row.mentionCount}</span>
      )}
    </button>
  )
}
