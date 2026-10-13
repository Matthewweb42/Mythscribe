import { useId, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { RecordKind } from '@shared/memory/records'
import { useRecordStore } from '@renderer/features/records/recordStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useMemoryStore } from './memoryStore'

const SMALL =
  'rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40'

/**
 * *Not right* on an AI line (F-16.18; design §2.7): which is wrong?
 * - *Not about Mara*: pick the record it is about; one check reads the quote for that record
 *   (supported: the line moves there; refused: it is dismissed; no answer, or a sentence changed
 *   since it was read: nothing changes, and it says so);
 * - *Wrong value*: the line goes to Dismissed, where *Undo* brings it back.
 */
export function NotRightChoices({
  claimId,
  recordId,
  kinds = null,
  onDone
}: {
  claimId: string
  /** Whose line it is now; null for a line still waiting on its subject. */
  recordId: string | null
  /** The kinds *Not about* may pick (a knows line: a character or group); null for any. */
  kinds?: readonly RecordKind[] | null
  onDone: () => void
}): React.JSX.Element {
  const pickId = useId()
  const name = useRecordStore((s) => (recordId === null ? null : (s.byId[recordId]?.name ?? null)))
  const others = useRecordStore(
    useShallow((s) =>
      s.ids
        .flatMap((id) => s.byId[id] ?? [])
        .filter(
          (record) => record.id !== recordId && (kinds === null || kinds.includes(record.kind))
        )
        .sort((a, b) => a.name.localeCompare(b.name))
    )
  )
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState('')
  const [busy, setBusy] = useState(false)

  const wrongValue = async (): Promise<void> => {
    setBusy(true)
    const result = await useMemoryStore.getState().notRight(claimId, { kind: 'wrongValue' })
    setBusy(false)
    if (result?.ok === true) onDone()
  }

  const notAbout = async (): Promise<void> => {
    const target = others.find((record) => record.id === picked)
    if (target === undefined) return
    setBusy(true)
    const result = await useMemoryStore
      .getState()
      .notRight(claimId, { kind: 'notAbout', recordId: target.id })
    setBusy(false)
    if (result === null) return
    if (!result.ok) {
      toast.error(`${result.message} ${result.nextStep}`.trim())
      return
    }
    if (result.outcome === 'unchecked') {
      // Nothing changed: the choices stay open, so Wrong value is one click away.
      setPicking(false)
      toast.info(
        'This line could not be checked: its sentence changed since it was read, or the check gave no answer. Nothing changed; Wrong value still sends it to Dismissed.'
      )
      return
    }
    if (result.outcome === 'moved') toast.success(`Moved to ${target.name}.`)
    else if (result.outcome === 'dismissed') {
      toast.info(
        result.dismissed === null
          ? `The text does not say this about ${target.name}: the line went.`
          : `The text does not say this about ${target.name}: the line went to Dismissed.`
      )
    }
    onDone()
  }

  return (
    <div
      role="group"
      aria-label="What is not right"
      className="mt-1 flex w-full flex-wrap items-center gap-1 rounded-md border border-line bg-surface px-2 py-1.5 text-xs"
    >
      {picking ? (
        <>
          <label htmlFor={pickId} className="text-fg-muted">
            It is about
          </label>
          <select
            id={pickId}
            value={picked}
            disabled={busy}
            onChange={(event) => setPicked(event.target.value)}
            className="min-w-0 rounded-md border border-line bg-bg px-1 py-0.5 text-xs"
          >
            <option value="">Choose…</option>
            {others.map((record) => (
              <option key={record.id} value={record.id}>
                {record.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={SMALL}
            disabled={busy || picked === ''}
            onClick={() => void notAbout()}
          >
            Check
          </button>
          <button type="button" className={SMALL} disabled={busy} onClick={onDone}>
            Cancel
          </button>
        </>
      ) : (
        <>
          {name === null || others.length === 0 ? null : (
            <button
              type="button"
              className={SMALL}
              disabled={busy}
              onClick={() => setPicking(true)}
            >
              Not about {name}
            </button>
          )}
          <button type="button" className={SMALL} disabled={busy} onClick={() => void wrongValue()}>
            Wrong value
          </button>
          <button type="button" className={SMALL} disabled={busy} onClick={onDone}>
            Cancel
          </button>
        </>
      )}
    </div>
  )
}
