import { useId, useState, type FormEvent } from 'react'
import { NOTE_PATCH_MAX, type NotePatch } from '@shared/memory/views'
import type { FindingView } from '@shared/memory/findings'
import { useMemoryStore } from '@renderer/features/memory/memoryStore'
import { pageKey, writeBehindPage } from '@renderer/features/research/pageStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { useFindingInfo } from './findingInfo'
import { FindingInfoButton, FindingInfoLines } from './FindingRow'
import { findingLine, noteConflictLine, noteSides } from './findingView'
import { openSide } from './openSide'

const SMALL =
  'rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40'

/** What the save says when the author kept typing on the note's page through every try. */
export const NOTE_BUSY = 'Your note was being edited; save it again in a moment'

/**
 * A book-against-note conflict in Needs a look (F-16.29, design Part 1): "Your note on Orrin says
 * born 1790; the book says 1792 (1.1)", with *Go there* (the scene), *Open my note* (the record's
 * sheet or the Research page), *Update my note* when offered (P4-D18: the book side is narration
 * in the present): the proposal made in code (`memory:notePatch`, no AI) in an editable field,
 * saved through `memory:applyNotePatch` behind the page store (pending typing on that page saved
 * first, the page read again after, `writeBehindPage`), refused when the line changed since; and
 * *Not a problem*. The manuscript is canon (answer 1): no *This one's right* here.
 */
export function NoteConflictRow({ finding }: { finding: FindingView }): React.JSX.Element {
  const sides = noteSides(finding)
  const [busy, setBusy] = useState(false)
  const [patch, setPatch] = useState<NotePatch | null>(null)
  const [text, setText] = useState('')
  const fieldId = useId()
  const info = useFindingInfo()
  const line = noteConflictLine(finding) ?? findingLine(finding)

  const startEdit = async (): Promise<void> => {
    setBusy(true)
    try {
      const proposal = await ipc().invoke('memory:notePatch', { findingId: finding.id })
      if (proposal === null) {
        toast.info('This note cannot be updated from here; open it to edit it.')
        return
      }
      setPatch(proposal)
      setText(proposal.after)
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (patch === null || text.trim() === '') return
    setBusy(true)
    const key = pageKey({
      kind: patch.owner.kind === 'record' ? 'pinned' : 'research',
      id: patch.owner.id
    })
    try {
      await writeBehindPage(
        key,
        () =>
          ipc().invoke('memory:applyNotePatch', {
            findingId: finding.id,
            index: patch.index,
            before: patch.before,
            text
          }),
        () => new Error(NOTE_BUSY)
      )
      setPatch(null)
      toast.info(`Your note on ${patch.owner.name} now reads “${text.trim()}”.`)
      // Main pushes the findings; the closed one goes from the list at once.
      await useMemoryStore.getState().loadFindings()
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li
      className="rounded-md border border-line bg-surface px-2 py-1.5"
      data-testid="note-conflict"
    >
      <div className="flex items-start gap-1">
        <p className="m-0 min-w-0 flex-1 font-medium">{line}</p>
        <FindingInfoButton info={info} line={line} />
      </div>
      {sides === null ? null : (
        <ul className="m-0 mt-1 list-none space-y-0.5 p-0 text-fg-muted">
          <li>
            {sides.note.label}: <q className="text-fg">{sides.note.quote}</q>
          </li>
          <li>
            {sides.book.label}: <q className="text-fg">{sides.book.quote}</q>
          </li>
        </ul>
      )}
      {patch === null ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {sides === null ? null : (
            <>
              <button type="button" className={SMALL} onClick={() => openSide(sides.book)}>
                Go there
              </button>
              <button type="button" className={SMALL} onClick={() => openSide(sides.note)}>
                Open my note
              </button>
            </>
          )}
          {finding.actions.updateNote ? (
            <button
              type="button"
              className={SMALL}
              disabled={busy}
              onClick={() => void startEdit()}
            >
              Update my note
            </button>
          ) : null}
          <button
            type="button"
            className={SMALL}
            disabled={busy}
            aria-label={`Not a problem: ${line}`}
            onClick={() => {
              setBusy(true)
              void useMemoryStore
                .getState()
                .findingAction({ findingId: finding.id, action: 'notProblem' })
                .finally(() => setBusy(false))
            }}
          >
            Not a problem
          </button>
        </div>
      ) : (
        <form className="mt-1 flex flex-col gap-1" onSubmit={(event) => void save(event)}>
          <label className="text-fg-muted" htmlFor={fieldId}>
            Your note, with the book’s {patch.value}
          </label>
          <textarea
            id={fieldId}
            value={text}
            rows={2}
            maxLength={NOTE_PATCH_MAX}
            onChange={(event) => setText(event.target.value)}
            className="rounded border border-line bg-surface-raised px-1.5 py-1 text-sm"
          />
          <div className="flex gap-1">
            <button type="submit" className={SMALL} disabled={busy || text.trim() === ''}>
              Save
            </button>
            <button type="button" className={SMALL} onClick={() => setPatch(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <FindingInfoLines info={info} finding={finding} />
    </li>
  )
}
