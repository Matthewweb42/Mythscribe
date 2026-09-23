import { useState } from 'react'
import { ENTITY_KIND_NOUN, ENTITY_NAME_MAX, type EntityKind } from '@shared/entities'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useEntityStore } from './entityStore'

/**
 * The quick-add form at the foot of an entity tab (F-9.2): a name, and Enter or Add creates the
 * entity with the kind's structured template (the creation dialog with a template choice is
 * F-9.3). The new entity is selected so its row is visible in the list; a name that is already
 * taken, or any other refusal, toasts and keeps the name in the field.
 */
export function EntityQuickAdd({ kind }: { kind: EntityKind }): React.JSX.Element {
  const create = useEntityStore((s) => s.create)
  const select = useEntityStore((s) => s.select)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const trimmed = name.trim()
  const noun = ENTITY_KIND_NOUN[kind]

  const submit = async (): Promise<void> => {
    if (trimmed.length === 0 || busy) return
    setBusy(true)
    try {
      const entity = await create({ kind, name: trimmed, template: 'structured' })
      select(entity.id)
      setName('')
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      aria-label={`New ${noun}`}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
      className="flex shrink-0 flex-wrap gap-1.5 border-t border-line p-2"
    >
      <input
        aria-label={`${noun[0]?.toUpperCase() ?? ''}${noun.slice(1)} name`}
        placeholder={`New ${noun}`}
        value={name}
        maxLength={ENTITY_NAME_MAX}
        onChange={(event) => setName(event.target.value)}
        className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 text-sm"
      />
      <button
        type="submit"
        disabled={trimmed.length === 0 || busy}
        className="ml-auto shrink-0 rounded-md border border-line px-2 py-1 text-xs hover:bg-surface-raised disabled:opacity-50 disabled:hover:bg-transparent"
      >
        Add
      </button>
    </form>
  )
}
