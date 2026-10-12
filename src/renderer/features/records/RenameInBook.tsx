import { useEffect, useId, useState } from 'react'
import { describeRenamePreview } from '@shared/memory/rename'
import { RECORD_NAME_MAX, type StoryRecordSummary } from '@shared/memory/records'
import { useRenameStore } from './renameStore'

const BUTTON =
  'rounded-md border border-line px-2 py-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-50 disabled:hover:bg-transparent'

/** How long the new name rests before main is asked what the rename would change. */
export const RENAME_PREVIEW_DEBOUNCE_MS = 200

/**
 * *Rename in book…* on a record's sheet (F-16.13; story memory v2): pick one of the record's
 * names, type the new one, see what it changes ("12 matches in 7 scenes (+3 in other drafts)",
 * scene by scene), then Rename. The manuscript (every draft), the name and the Dismissed keys
 * change; notes, Research and sheets do not (decision P1-D10: Replace in project covers them).
 * While the last rename of this record can be undone, *Undo rename* sits beside the button.
 */
export function RenameInBook({
  record,
  busy
}: {
  record: StoryRecordSummary
  busy: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const undoable = useRenameStore((s) => s.undoable)
  const renaming = useRenameStore((s) => s.busy)
  const mine = undoable?.recordId === record.id ? undoable : null
  return (
    <section aria-label="Rename in book" className="flex flex-col gap-2">
      <div className="flex gap-2">
        <button
          type="button"
          aria-expanded={open}
          disabled={busy || renaming}
          onClick={() => setOpen(!open)}
          className={BUTTON}
        >
          Rename in book…
        </button>
        {mine === null ? null : (
          <button
            type="button"
            disabled={renaming}
            onClick={() => void useRenameStore.getState().undo()}
            className={BUTTON}
          >
            Undo rename to “{mine.to}”
          </button>
        )}
      </div>
      {open ? <RenameForm record={record} onDone={() => setOpen(false)} /> : null}
    </section>
  )
}

function RenameForm({
  record,
  onDone
}: {
  record: StoryRecordSummary
  onDone: () => void
}): React.JSX.Element {
  const pickId = useId()
  const toId = useId()
  const [aliasId, setAliasId] = useState(record.aliases.find((alias) => alias.isMain)?.id ?? '')
  const [to, setTo] = useState('')
  const preview = useRenameStore((s) => s.preview)
  const previewFor = useRenameStore((s) => s.previewFor)
  const error = useRenameStore((s) => s.error)
  const busy = useRenameStore((s) => s.busy)
  const trimmed = to.trim()
  const current = previewFor?.aliasId === aliasId && previewFor.to === trimmed ? preview : null

  useEffect(() => {
    const store = useRenameStore.getState()
    store.forget()
    if (trimmed === '' || aliasId === '') return
    const timer = window.setTimeout(() => {
      void store.ask({ recordId: record.id, aliasId, to: trimmed })
    }, RENAME_PREVIEW_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [record.id, aliasId, trimmed])

  useEffect(() => () => useRenameStore.getState().forget(), [])

  const apply = async (): Promise<void> => {
    if (await useRenameStore.getState().apply()) onDone()
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-line p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={pickId} className="text-xs text-fg-muted">
          Rename
        </label>
        <select
          id={pickId}
          value={aliasId}
          onChange={(event) => setAliasId(event.target.value)}
          className="rounded-md border border-line bg-bg px-2 py-1 text-sm"
        >
          {record.aliases.map((alias) => (
            <option key={alias.id} value={alias.id}>
              {alias.text}
            </option>
          ))}
        </select>
        <label htmlFor={toId} className="text-xs text-fg-muted">
          to
        </label>
        <input
          id={toId}
          aria-label="New name"
          value={to}
          maxLength={RECORD_NAME_MAX}
          onChange={(event) => setTo(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && current !== null) {
              event.preventDefault()
              void apply()
            }
          }}
          className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 text-sm"
        />
      </div>
      {error !== null ? (
        <p role="alert" className="m-0 text-xs text-danger">
          {error}
        </p>
      ) : current === null ? (
        trimmed === '' ? null : (
          <p className="m-0 text-xs text-fg-muted">Counting…</p>
        )
      ) : (
        <div role="status" data-testid="rename-preview" className="flex flex-col gap-1">
          <p className="m-0 text-xs">{describeRenamePreview(current)}</p>
          {current.scenes.length > 0 ? (
            <ul className="m-0 list-none p-0 text-xs text-fg-muted">
              {current.scenes.map((scene) => (
                <li key={scene.nodeId}>
                  {scene.title} · {scene.count}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="m-0 text-[11px] text-fg-subtle">
            Notes, Research and sheets stay as they are; Replace in project changes those. A
            snapshot is taken first.
          </p>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className={BUTTON}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || current === null}
          onClick={() => void apply()}
          className={BUTTON}
        >
          Rename
        </button>
      </div>
    </div>
  )
}
