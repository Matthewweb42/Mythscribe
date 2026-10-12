import { X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { Label } from '@shared/storyLabels'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useLabelStore } from './labelStore'

/** One label as a chip in its colour; `onRemove` adds the × that takes it off. */
export function LabelChip({
  label,
  onRemove
}: {
  label: Pick<Label, 'name' | 'colour'>
  onRemove?: () => void
}): React.JSX.Element {
  return (
    <span
      data-testid="label-chip"
      className="inline-flex max-w-full items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs"
    >
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: label.colour }}
      />
      <span className="min-w-0 truncate">{label.name}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove label ${label.name}`}
          onClick={onRemove}
          className="flex size-4 items-center justify-center rounded-full text-fg-muted hover:bg-surface-raised hover:text-fg"
        >
          <X size={10} aria-hidden="true" />
        </button>
      ) : null}
    </span>
  )
}

/**
 * The labels of one scene or Research document (F-16.7, story memory v2): its labels as chips
 * (× takes one off), a list to put another on, and *Manage labels…* for the Labels dialog.
 */
export function LabelPicker({ nodeId }: { nodeId: string }): React.JSX.Element {
  const labels = useLabelStore((s) => s.labels)
  const carried = useLabelStore(useShallow((s) => s.byNode[nodeId] ?? []))
  const on = labels.filter((label) => carried.includes(label.id))
  const off = labels.filter((label) => !carried.includes(label.id))
  const run = (action: () => Promise<void>): void => {
    action().catch((err: unknown) => toast.error(describeError(err)))
  }
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="label-picker">
      {on.map((label) => (
        <LabelChip
          key={label.id}
          label={label}
          onRemove={() => run(() => useLabelStore.getState().unassign(label.id, nodeId))}
        />
      ))}
      {off.length > 0 ? (
        <select
          aria-label="Add a label"
          value=""
          onChange={(event) => {
            const labelId = event.target.value
            if (labelId !== '') run(() => useLabelStore.getState().assign(labelId, nodeId))
          }}
          className="rounded-md border border-line bg-bg px-1 py-0.5 text-xs"
        >
          <option value="">Add a label…</option>
          {off.map((label) => (
            <option key={label.id} value={label.id}>
              {label.name}
            </option>
          ))}
        </select>
      ) : null}
      <button
        type="button"
        onClick={() => useLabelStore.getState().openManager()}
        className="rounded-md px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg"
      >
        Manage labels…
      </button>
    </div>
  )
}
