import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { RECORD_NAME_MAX } from '@shared/memory/records'
import { isTopicCategory } from '@shared/memory/topics'
import type { TwinGateResult } from '@shared/memory/twinGate'
import { useCategory } from '@renderer/features/entities/categoryStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import { describeError } from '@renderer/lib/errors'
import { useRecordStore } from './recordStore'
import { aliasesInputOf, gateWarning } from './recordView'

/** How long the typed name rests before the twin gate is asked. */
export const GATE_DEBOUNCE_MS = 150

type Blocked = Extract<TwinGateResult, { outcome: 'blocked' }>

const capitalize = (word: string): string => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`

const BUTTON =
  'rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-60'

/**
 * The record creation dialog (F-16.4, F-16.6; story memory v2), mounted in the project screen
 * and open while `recordStore.creating` names a category. The twin gate runs as the name is
 * typed (`record:gate`): a name that looks like an existing record shows "Looks like Rynna
 * Falsire (starts the same as “Rynna”)" with *Same as Rynna Falsire* (open that sheet, adding the
 * typed name as a nickname unless it already is one) and *Create anyway* (decision P1-D4: the
 * author's own record is warned about, never silently blocked). A name on Dismissed says so and
 * offers *Create anyway* only. A refusal (a name another record holds unshared) toasts and keeps
 * the dialog, so the typed name is never lost. A secret or thread (P2b-D19) runs no gate as its
 * label is typed: only an exact duplicate label, answered by main on *Create*, is warned about.
 */
export function RecordCreateDialog(): React.JSX.Element | null {
  const categoryId = useRecordStore((s) => s.creating)
  if (categoryId === null) return null
  return <CreateForm key={categoryId} categoryId={categoryId} />
}

function CreateForm({ categoryId }: { categoryId: string }): React.JSX.Element {
  const titleId = useId()
  const warningId = useId()
  const [name, setName] = useState('')
  /** The gate's warning and the name it was for: shown only while that is still the name typed. */
  const [blocked, setBlocked] = useState<{ name: string; gate: Blocked } | null>(null)
  const [busy, setBusy] = useState(false)
  const nameInput = useRef<HTMLInputElement>(null)
  const trimmed = name.trim()
  const noun = useCategory(categoryId).noun
  const records = useRecordStore((s) => s.byId)
  const warning = blocked !== null && blocked.name === trimmed ? blocked.gate : null
  const match =
    warning?.recordId === null || warning === null ? undefined : records[warning.recordId]

  useEffect(() => {
    nameInput.current?.focus()
  }, [])

  useEffect(() => {
    // P2b-D19: a secret's or thread's label is not a name, so no twin gate runs as it is typed;
    // main still warns about an exact duplicate label when it is created.
    if (trimmed === '' || isTopicCategory(categoryId)) return
    let live = true
    const timer = window.setTimeout(() => {
      useRecordStore
        .getState()
        .gate(trimmed)
        .then((verdict) => {
          if (!live) return
          setBlocked(verdict.outcome === 'blocked' ? { name: trimmed, gate: verdict } : null)
        })
        .catch((err: unknown) => {
          if (live) toast.error(describeError(err))
        })
    }, GATE_DEBOUNCE_MS)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [trimmed, categoryId])

  const cancel = (): void => useRecordStore.getState().cancelCreate()

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    cancel()
  }

  const onBackdropMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) cancel()
  }

  /**
   * Opens a record's sheet and its category's section, and closes the dialog; opened from a
   * picker, the picker gets the record instead and the author stays where she was.
   */
  const open = (id: string, sectionId: string): void => {
    const store = useRecordStore.getState()
    const pick = store.picking
    if (pick !== null) {
      store.cancelCreate()
      pick(id)
      return
    }
    store.select(id)
    const layout = useLayoutStore.getState()
    layout.setSidebarTab(sectionId)
    if (!layout.layout.sidebar.open) layout.toggle('sidebar')
    store.cancelCreate()
  }

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  const create = (force: boolean): Promise<void> =>
    run(async () => {
      if (trimmed.length === 0) return
      const made = await useRecordStore.getState().create({ name: trimmed, categoryId, force })
      if ('gate' in made) {
        setBlocked({ name: trimmed, gate: made.gate })
        return
      }
      open(made.record.id, categoryId)
    })

  /** *Same as …*: the typed name joins that record as a nickname (unless it already is a name of it). */
  const sameAs = (): Promise<void> =>
    run(async () => {
      if (match === undefined || warning === null) return
      const store = useRecordStore.getState()
      if (warning.rule !== 'alias') {
        const names = aliasesInputOf(match)
        await store.setAliases(match.id, {
          ...names,
          aliases: [...names.aliases, { text: trimmed }]
        })
      }
      open(match.id, match.categoryId)
    })

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
          if (warning === null) void create(false)
        }}
        className="flex w-[420px] max-w-[90vw] flex-col rounded-lg border border-line bg-surface-raised p-5 shadow-panel"
      >
        <h2 id={titleId} className="m-0 text-base font-semibold">
          New {noun}
        </h2>
        <input
          ref={nameInput}
          aria-label="Name"
          aria-describedby={warning === null ? undefined : warningId}
          placeholder={`${capitalize(noun)} name`}
          value={name}
          maxLength={RECORD_NAME_MAX}
          onChange={(event) => setName(event.target.value)}
          className="mt-4 w-full rounded-md border border-line bg-bg px-3 py-2 text-sm"
        />
        {warning !== null ? (
          <div
            role="status"
            data-testid="record-gate-warning"
            className="mt-3 rounded-md border border-line bg-surface px-3 py-2 text-sm"
          >
            <p id={warningId} className="m-0">
              {gateWarning(warning, match?.name)}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {match !== undefined ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void sameAs()}
                  className={BUTTON}
                >
                  Same as {match.name}
                </button>
              ) : null}
              <button
                type="button"
                disabled={busy}
                onClick={() => void create(true)}
                className={BUTTON}
              >
                Create anyway
              </button>
            </div>
          </div>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={cancel} className={BUTTON}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={trimmed.length === 0 || busy || warning !== null}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-60"
          >
            Create
          </button>
        </div>
      </form>
    </div>
  )
}
