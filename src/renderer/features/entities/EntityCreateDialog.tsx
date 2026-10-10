import { storyBibleSettingsNow } from './storyBibleSettingsStore'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import {
  ENTITY_NAME_MAX,
  ENTITY_TEMPLATES,
  type EntityKind,
  type EntityTemplate
} from '@shared/entities'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import { describeError } from '@renderer/lib/errors'
import { useCategory } from './categoryStore'
import { useEntityStore } from './entityStore'
import { ENTITY_TEMPLATE_LABEL } from './entityView'

/** What each template means, under its radio. */
const TEMPLATE_MEANING: Record<EntityTemplate, string> = {
  structured: 'One field for each part of the template',
  blank: 'One free page'
}

const capitalize = (word: string): string => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`

/** The same option tile the create-project wizard uses, so the two radio lists look alike. */
const OPTION =
  'block cursor-pointer rounded-md border border-line bg-surface px-3 py-2 hover:bg-bg has-checked:border-accent has-focus-visible:outline-2 has-focus-visible:outline-accent'

/**
 * The creation dialog (F-9.3), mounted in the project screen and open while
 * `entityStore.creating` names a kind: the quick-add's "New …" button and the three Insert menu
 * items open it. It asks for the name and the template, creates the entity, opens its page, and
 * shows the kind's sidebar tab. A refusal (a name already taken) toasts and keeps the dialog, so
 * the typed name is never lost.
 */
export function EntityCreateDialog(): React.JSX.Element | null {
  const kind = useEntityStore((s) => s.creating)
  if (kind === null) return null
  return <CreateForm key={kind} kind={kind} />
}

function CreateForm({ kind }: { kind: EntityKind }): React.JSX.Element {
  const titleId = useId()
  const radioName = useId()
  const [name, setName] = useState('')
  // F-9.19: the view the author chose for new sheets in Settings › Story bible.
  const [template, setTemplate] = useState<EntityTemplate>(
    () => storyBibleSettingsNow().defaultTemplate
  )
  const [busy, setBusy] = useState(false)
  const nameInput = useRef<HTMLInputElement>(null)
  const trimmed = name.trim()
  const noun = useCategory(kind).noun

  useEffect(() => {
    nameInput.current?.focus()
  }, [])

  const cancel = (): void => useEntityStore.getState().cancelCreate()

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
      const store = useEntityStore.getState()
      const entity = await store.create({ kind, name: trimmed, template })
      store.select(entity.id)
      const layout = useLayoutStore.getState()
      // F-9.11: a category's section id is its id.
      layout.setSidebarTab(kind)
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
        className="flex w-[420px] max-w-[90vw] flex-col rounded-lg border border-line bg-surface-raised p-5 shadow-panel"
      >
        <h2 id={titleId} className="m-0 text-base font-semibold">
          New {noun}
        </h2>
        <input
          ref={nameInput}
          aria-label="Name"
          placeholder={`${capitalize(noun)} name`}
          value={name}
          maxLength={ENTITY_NAME_MAX}
          onChange={(event) => setName(event.target.value)}
          className="mt-4 w-full rounded-md border border-line bg-bg px-3 py-2 text-sm"
        />
        <fieldset className="m-0 mt-4 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-2 p-0 text-sm font-medium">Template</legend>
          {ENTITY_TEMPLATES.map((option) => (
            <label key={option} className={OPTION}>
              <input
                type="radio"
                name={radioName}
                value={option}
                className="sr-only"
                checked={template === option}
                onChange={() => setTemplate(option)}
              />
              <span className="block text-sm font-medium">{ENTITY_TEMPLATE_LABEL[option]}</span>
              <span className="block text-sm text-fg-muted">{TEMPLATE_MEANING[option]}</span>
            </label>
          ))}
        </fieldset>
        <div className="mt-5 flex justify-end gap-2">
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
