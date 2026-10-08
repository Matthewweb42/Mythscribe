import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import {
  EntityImportAction,
  actionsFor,
  countImportActions,
  type EntityImportItem,
  type EntityImportPlan
} from '@shared/entityExchange'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useEntityStore } from './entityStore'
import { useCategory, useCategoryStore } from './categoryStore'
import { excerptOf } from './entityView'

/** What each action promises, as the row's own label; the dialog explains nothing twice. */
const ACTION_LABEL: Record<EntityImportAction, string> = {
  add: 'Add',
  merge: 'Fill in blanks',
  replace: 'Replace values',
  skip: 'Skip'
}

/** `N thing` / `N things`, the count line's one formatter; `plural` for an irregular one. */
const count = (n: number, singular: string, plural = `${singular}s`): string =>
  `${n.toLocaleString()} ${n === 1 ? singular : plural}`

/** What the import would do, as the header's one line. */
function summaryLine(plan: EntityImportPlan): string {
  const { added, merged, replaced } = countImportActions(plan.items)
  const skipped = plan.items.length - added - merged - replaced
  const parts = [
    count(plan.items.length, 'entity', 'entities'),
    `${added} to add`,
    `${merged + replaced} to update`
  ]
  if (skipped > 0) parts.push(`${skipped} skipped`)
  if (plan.duplicates > 0) parts.push(`${count(plan.duplicates, 'duplicate')} in the file dropped`)
  return parts.join(' · ')
}

/**
 * The import review dialog (F-9.5), open while `entityStore.importPlan` holds a plan: every record
 * of the file with what it matched in the story bible and what will happen to it. Nothing has been
 * written yet — Cancel and Escape drop the plan — and the author sets the action per row, so an
 * import can fill in blanks without ever overwriting what they wrote themselves.
 */
export function EntityImportDialog(): React.JSX.Element | null {
  const plan = useEntityStore((s) => s.importPlan)
  if (plan === null) return null
  return <ImportReview plan={plan} />
}

function ImportReview({ plan }: { plan: EntityImportPlan }): React.JSX.Element {
  const titleId = useId()
  const [busy, setBusy] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const cancel = useEntityStore((s) => s.cancelImport)
  const nothingToDo = plan.items.every((item) => item.action === 'skip')

  useEffect(() => {
    panel.current?.focus()
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || busy) return
    event.preventDefault()
    event.stopPropagation()
    cancel()
  }

  const submit = async (): Promise<void> => {
    if (nothingToDo || busy) return
    setBusy(true)
    try {
      const { added, merged, replaced } = await useEntityStore.getState().commitImport()
      const written = added + merged + replaced
      toast.success(
        `Imported ${count(written, 'entity', 'entities')} (${added} added, ${merged} merged, ${replaced} replaced)`
      )
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="entity-import-dialog"
        onKeyDown={onKeyDown}
        className="flex max-h-[80vh] w-[720px] max-w-[95vw] flex-col rounded-lg border border-line bg-surface-raised shadow-panel outline-none"
      >
        <div className="shrink-0 border-b border-line px-5 pt-4 pb-3">
          <h2 id={titleId} className="m-0 text-base font-semibold">
            Import “{plan.source.name}”
          </h2>
          <p className="mt-1 mb-0 text-sm text-fg-muted">
            Choose what happens to each one. Nothing is written until you import.
          </p>
          <p className="mt-1 mb-0 text-xs text-fg-subtle" data-testid="entity-import-summary">
            {summaryLine(plan)}
          </p>
        </div>
        <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-2">
          {plan.items.map((item) => (
            <ImportRow key={item.id} item={item} />
          ))}
        </ul>
        <div className="flex shrink-0 justify-end gap-2 border-t border-line px-5 py-3">
          <button
            type="button"
            data-testid="entity-import-cancel"
            disabled={busy}
            onClick={cancel}
            className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="entity-import-commit"
            disabled={nothingToDo || busy}
            onClick={() => void submit()}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-60"
          >
            Import
          </button>
        </div>
      </div>
    </div>
  )
}

function ImportRow({ item }: { item: EntityImportItem }): React.JSX.Element {
  const setAction = useEntityStore((s) => s.setImportAction)
  const existing = useEntityStore((s) =>
    item.existingId === null ? null : s.byId[item.existingId]
  )
  // The excerpt is of the incoming values, so the row says what the file would bring.
  const categories = useCategoryStore((s) => s.categories)
  const noun = useCategory(item.record.kind).noun
  const excerpt = excerptOf(item.record, categories)
  return (
    <li
      className="m-0 flex list-none items-start gap-2 rounded-md px-2 py-1.5 hover:bg-surface"
      data-testid="entity-import-item"
      data-import-id={item.id}
    >
      <div className="min-w-0 flex-1">
        <p className="m-0 truncate text-sm font-medium">{item.record.name}</p>
        <p className="m-0 text-xs text-fg-muted">
          {noun}
          {existing ? ` · Existing: ${existing.name}` : ''}
        </p>
        {excerpt.length > 0 ? (
          <p className="m-0 line-clamp-2 text-xs wrap-anywhere text-fg-subtle">{excerpt}</p>
        ) : null}
      </div>
      <select
        aria-label={`Action for ${item.record.name}`}
        data-testid="entity-import-action"
        value={item.action}
        onChange={(event) => {
          const chosen = EntityImportAction.safeParse(event.target.value)
          if (chosen.success) setAction(item.id, chosen.data)
        }}
        className="shrink-0 rounded-md border border-line bg-bg px-2 py-1 text-sm"
      >
        {actionsFor(item).map((action) => (
          <option key={action} value={action}>
            {ACTION_LABEL[action]}
          </option>
        ))}
      </select>
    </li>
  )
}
