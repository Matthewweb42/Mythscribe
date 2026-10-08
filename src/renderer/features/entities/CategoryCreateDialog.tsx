import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import {
  CATEGORY_FIELDS_MAX,
  CATEGORY_ICONS,
  CATEGORY_NAME_MAX,
  DEFAULT_CATEGORY_ICON,
  fieldLabelsOf,
  singularOf,
  type CategoryIcon
} from '@shared/categories'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import { describeError } from '@renderer/lib/errors'
import { CATEGORY_ICON } from './categoryIcons'
import { useCategoryStore } from './categoryStore'

/**
 * The "New category" dialog (F-9.11), open while `categoryStore.creating` is set (the section
 * picker's last item): a name, the singular, an icon, and the fields of its template, one per
 * line (Notes is always added). The new category becomes the current section, so its first sheet
 * is one click away; it stays in the picker once it has one. A refusal (a name already taken)
 * toasts and keeps the dialog.
 */
export function CategoryCreateDialog(): React.JSX.Element | null {
  const creating = useCategoryStore((s) => s.creating)
  return creating ? <CreateForm /> : null
}

function CreateForm(): React.JSX.Element {
  const titleId = useId()
  const [name, setName] = useState('')
  const [noun, setNoun] = useState('')
  const [icon, setIcon] = useState<CategoryIcon>(DEFAULT_CATEGORY_ICON)
  const [fields, setFields] = useState('')
  const [busy, setBusy] = useState(false)
  const nameInput = useRef<HTMLInputElement>(null)
  const trimmed = name.trim()

  useEffect(() => {
    nameInput.current?.focus()
  }, [])

  const cancel = (): void => useCategoryStore.getState().cancelCreate()

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    cancel()
  }

  const onBackdropMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) cancel()
  }

  const submit = async (): Promise<void> => {
    if (trimmed.length === 0 || busy) return
    setBusy(true)
    try {
      const store = useCategoryStore.getState()
      const category = await store.create({
        name: trimmed,
        ...(noun.trim() !== '' ? { noun: noun.trim() } : {}),
        icon,
        fields: fieldLabelsOf(fields)
      })
      const layout = useLayoutStore.getState()
      layout.setSidebarTab(category.id)
      if (!layout.layout.sidebar.open) layout.toggle('sidebar')
      store.cancelCreate()
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
      onMouseDown={onBackdropMouseDown}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
        className="flex w-[440px] max-w-[90vw] flex-col gap-3 rounded-lg border border-line bg-surface-raised p-5 shadow-panel"
      >
        <h2 id={titleId} className="m-0 text-base font-semibold">
          New category
        </h2>
        <label className="flex flex-col gap-1 text-sm">
          Name
          <input
            ref={nameInput}
            placeholder="Ships"
            value={name}
            maxLength={CATEGORY_NAME_MAX}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          One of them is called
          <input
            placeholder={trimmed === '' ? 'ship' : singularOf(trimmed)}
            value={noun}
            maxLength={CATEGORY_NAME_MAX}
            onChange={(event) => setNoun(event.target.value)}
            className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm"
          />
        </label>
        <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
          <legend className="mb-1 p-0 text-sm">Icon</legend>
          <div className="flex flex-wrap gap-1">
            {CATEGORY_ICONS.map((option) => {
              const Icon = CATEGORY_ICON[option]
              return (
                <button
                  key={option}
                  type="button"
                  aria-label={option}
                  aria-pressed={icon === option}
                  onClick={() => setIcon(option)}
                  className="flex size-7 items-center justify-center rounded-md border border-transparent text-fg-muted hover:bg-surface aria-pressed:border-accent aria-pressed:text-fg"
                >
                  <Icon size={15} aria-hidden="true" />
                </button>
              )
            })}
          </div>
        </fieldset>
        <label className="flex flex-col gap-1 text-sm">
          Fields, one per line
          <textarea
            rows={4}
            placeholder={'Crew\nHome port\nArmament'}
            value={fields}
            onChange={(event) => setFields(event.target.value)}
            className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm"
          />
          <span className="text-xs text-fg-muted">
            Up to {CATEGORY_FIELDS_MAX}. Every sheet also gets Notes.
          </span>
        </label>
        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            onClick={cancel}
            className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={trimmed.length === 0 || busy}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-60"
          >
            Create
          </button>
        </div>
      </form>
    </div>
  )
}
