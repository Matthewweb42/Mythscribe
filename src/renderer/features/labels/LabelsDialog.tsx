import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import { LABEL_KINDS, LABEL_NAME_MAX, type Label, type LabelKind } from '@shared/storyLabels'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useLabelStore } from './labelStore'
import { LABEL_KIND_HINT, LABEL_KIND_LABEL } from './labelText'

const BUTTON =
  'flex size-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-surface hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent'
const SELECT = 'rounded-md border border-line bg-bg px-1 py-1 text-xs'

/**
 * The Labels dialog (F-16.7, story memory v2): create, rename, colour, kind, order and delete the
 * author's labels. Open while `labelStore.managing`; *Manage labels…* beside every label picker
 * opens it. The AI never creates or touches a label (answer 2).
 */
export function LabelsDialog(): React.JSX.Element | null {
  const managing = useLabelStore((s) => s.managing)
  if (!managing) return null
  return <Manager />
}

function Manager(): React.JSX.Element {
  const titleId = useId()
  const labels = useLabelStore((s) => s.labels)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<LabelKind>('tone')
  const [busy, setBusy] = useState(false)
  const nameInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameInput.current?.focus()
  }, [])

  const close = (): void => useLabelStore.getState().closeManager()

  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    if (busy) return false
    setBusy(true)
    try {
      await action()
      return true
    } catch (err) {
      toast.error(describeError(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  const add = async (): Promise<void> => {
    const trimmed = name.trim()
    if (trimmed === '') return
    if (await run(() => useLabelStore.getState().create({ name: trimmed, kind }))) setName('')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    close()
  }

  const onBackdropMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) close()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
      onMouseDown={onBackdropMouseDown}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className="flex max-h-[80vh] w-[480px] max-w-[90vw] flex-col rounded-lg border border-line bg-surface-raised p-5 shadow-panel"
      >
        <h2 id={titleId} className="m-0 text-base font-semibold">
          Labels
        </h2>
        <p className="m-0 mt-1 text-xs text-fg-muted">
          Your own labels for scenes and Research documents, to filter by. Nothing about them is
          sent to the AI.
        </p>
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
          {labels.length === 0 ? (
            <p className="m-0 py-2 text-sm text-fg-muted">No labels yet.</p>
          ) : (
            <ul aria-label="Labels" className="m-0 flex list-none flex-col gap-1 p-0">
              {labels.map((label, index) => (
                <LabelRow
                  key={`${label.id}:${label.name}`}
                  label={label}
                  first={index === 0}
                  last={index === labels.length - 1}
                  busy={busy}
                  run={run}
                />
              ))}
            </ul>
          )}
        </div>
        <form
          aria-label="New label"
          onSubmit={(event) => {
            event.preventDefault()
            void add()
          }}
          className="mt-3 flex items-center gap-1.5 border-t border-line pt-3"
        >
          <input
            ref={nameInput}
            aria-label="New label name"
            placeholder="New label"
            value={name}
            maxLength={LABEL_NAME_MAX}
            onChange={(event) => setName(event.target.value)}
            className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 text-sm"
          />
          <select
            aria-label="New label kind"
            title={LABEL_KIND_HINT[kind]}
            value={kind}
            onChange={(event) => {
              const next = LABEL_KINDS.find((option) => option === event.target.value)
              if (next !== undefined) setKind(next)
            }}
            className={SELECT}
          >
            {LABEL_KINDS.map((option) => (
              <option key={option} value={option}>
                {LABEL_KIND_LABEL[option]}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={busy || name.trim() === ''}
            className="rounded-md border border-line px-2 py-1 text-xs hover:bg-surface disabled:opacity-50"
          >
            Add
          </button>
        </form>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={close}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

function LabelRow({
  label,
  first,
  last,
  busy,
  run
}: {
  label: Label
  first: boolean
  last: boolean
  busy: boolean
  run: (action: () => Promise<unknown>) => Promise<boolean>
}): React.JSX.Element {
  const [name, setName] = useState(label.name)
  const store = useLabelStore.getState
  const rename = (): void => {
    const next = name.trim()
    if (next === '' || next === label.name) {
      setName(label.name)
      return
    }
    void run(() => store().update(label.id, { name: next })).then((ok) => {
      if (!ok) setName(label.name)
    })
  }
  const remove = async (): Promise<void> => {
    const ok = await dialogs.confirm({
      title: `Delete the label "${label.name}"?`,
      message: 'It comes off every scene and document that carries it. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true
    })
    if (ok) await run(() => store().remove(label.id))
  }
  return (
    <li aria-label={label.name} className="flex items-center gap-1.5">
      <ColourInput
        key={label.colour}
        label={`Colour of ${label.name}`}
        value={label.colour}
        disabled={busy}
        onCommit={(colour) => void run(() => store().update(label.id, { colour }))}
      />
      <input
        aria-label={`Name of ${label.name}`}
        value={name}
        maxLength={LABEL_NAME_MAX}
        onChange={(event) => setName(event.target.value)}
        onBlur={rename}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            rename()
          }
        }}
        className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 text-sm"
      />
      <select
        aria-label={`Kind of ${label.name}`}
        title={LABEL_KIND_HINT[label.kind]}
        value={label.kind}
        disabled={busy}
        onChange={(event) => {
          const kind = LABEL_KINDS.find((option) => option === event.target.value)
          if (kind !== undefined) void run(() => store().update(label.id, { kind }))
        }}
        className={SELECT}
      >
        {LABEL_KINDS.map((option) => (
          <option key={option} value={option}>
            {LABEL_KIND_LABEL[option]}
          </option>
        ))}
      </select>
      <button
        type="button"
        aria-label={`Move ${label.name} up`}
        disabled={busy || first}
        onClick={() => void run(() => store().move(label.id, -1))}
        className={BUTTON}
      >
        <ArrowUp size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label={`Move ${label.name} down`}
        disabled={busy || last}
        onClick={() => void run(() => store().move(label.id, 1))}
        className={BUTTON}
      >
        <ArrowDown size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label={`Delete ${label.name}`}
        disabled={busy}
        onClick={() => void remove()}
        className={BUTTON}
      >
        <Trash2 size={14} aria-hidden="true" />
      </button>
    </li>
  )
}

/**
 * A colour well that shows the colour as it is dragged and saves once, when the picker closes
 * (the DOM `change` event; React's `onChange` fires on every step of the drag).
 */
function ColourInput({
  label,
  value,
  disabled,
  onCommit
}: {
  label: string
  value: string
  disabled: boolean
  onCommit: (colour: string) => void
}): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  // Reset by the parent's key when the stored colour changes.
  const [shown, setShown] = useState(value)
  useEffect(() => {
    const element = input.current
    if (element === null) return
    const onChange = (): void => {
      if (element.value !== value) onCommit(element.value)
    }
    element.addEventListener('change', onChange)
    return () => element.removeEventListener('change', onChange)
  }, [value, onCommit])
  return (
    <input
      ref={input}
      type="color"
      aria-label={label}
      value={shown}
      disabled={disabled}
      onChange={(event) => setShown(event.target.value)}
      className="size-7 shrink-0 cursor-pointer rounded-md border border-line bg-bg p-0.5"
    />
  )
}
