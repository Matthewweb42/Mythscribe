import { useEffect, useState } from 'react'
import type { DraftInfo } from '@shared/drafts'
import { flushPendingSaves } from '@renderer/features/project/pendingSaves'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
import { StatsFrame } from '@renderer/features/stats/StatsFrame'
import { describeError } from '@renderer/lib/errors'
import { DraftCompare } from './DraftCompare'
import { draftNameProblem, nextDraftName, useDraftStore } from './draftStore'

const BUTTON =
  'rounded-md border border-line px-2.5 py-1 text-xs hover:bg-surface disabled:opacity-50 disabled:hover:bg-transparent'

const words = (count: number): string => `${count.toLocaleString()} word${count === 1 ? '' : 's'}`

/**
 * The Drafts dialog (F-8.5), shell dialog `drafts` from Tools › Drafts… and the status bar's
 * draft label: every draft of the project with its word count and the active one marked, and per
 * draft Switch, Duplicate…, Rename…, Delete… (not the active one), and Compare with current,
 * which turns the dialog into the compare view. The list is asked for again on open, after the
 * pending saves are flushed, so the word counts include what was just typed.
 */
export function DraftsDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const drafts = useDraftStore((s) => s.drafts)
  const activeId = useDraftStore((s) => s.activeId)
  const [comparing, setComparing] = useState<string | null>(null)

  useEffect(() => {
    const load = async (): Promise<void> => {
      // A failed save is reported by the autosave itself; the stored counts are still worth showing.
      await flushPendingSaves().catch(() => undefined)
      await useDraftStore.getState().load()
    }
    load().catch((err: unknown) => toast.error(describeError(err)))
  }, [])

  let body: React.ReactNode
  if (drafts === null || activeId === null) {
    body = <p className="m-0 text-xs text-fg-muted">Loading…</p>
  } else if (comparing !== null && drafts.some((d) => d.id === comparing)) {
    body = (
      <DraftCompare
        drafts={drafts}
        activeId={activeId}
        initialFromId={comparing}
        onBack={() => setComparing(null)}
      />
    )
  } else {
    body = <DraftList drafts={drafts} onCompare={setComparing} />
  }

  return (
    <StatsFrame
      title={comparing !== null ? 'Compare drafts' : 'Drafts'}
      widthClassName="w-[min(860px,94vw)]"
      onClose={onClose}
    >
      {body}
    </StatsFrame>
  )
}

function DraftList({
  drafts,
  onCompare
}: {
  drafts: readonly DraftInfo[]
  onCompare: (id: string) => void
}): React.JSX.Element {
  const busy = useDraftStore((s) => s.busy)
  const { switchTo, duplicate, rename, remove } = useDraftStore.getState()

  const onDuplicate = async (draft: DraftInfo): Promise<void> => {
    const name = await dialogs.prompt({
      title: 'Duplicate draft',
      message: `A copy of "${draft.name}" as a new draft. The active draft stays active.`,
      initialValue: nextDraftName(drafts),
      confirmLabel: 'Duplicate',
      validate: (value) => draftNameProblem(value, useDraftStore.getState().drafts ?? drafts)
    })
    if (name !== null) await duplicate(draft.id, name)
  }

  const onRename = async (draft: DraftInfo): Promise<void> => {
    const name = await dialogs.prompt({
      title: 'Rename draft',
      initialValue: draft.name,
      confirmLabel: 'Rename',
      validate: (value) =>
        draftNameProblem(value, useDraftStore.getState().drafts ?? drafts, draft.id)
    })
    if (name !== null && name.trim() !== draft.name) await rename(draft.id, name)
  }

  const onDelete = async (draft: DraftInfo): Promise<void> => {
    const ok = await dialogs.confirm({
      title: `Delete "${draft.name}"?`,
      message: 'Its text is deleted for good. The other drafts and the tree are not affected.',
      confirmLabel: 'Delete',
      danger: true
    })
    if (ok) await remove(draft.id)
  }

  return (
    <>
      <p className="m-0 text-sm text-fg-muted">
        Every draft shares the binder, notes, and tags; only the text of the manuscript differs.
      </p>
      <ul aria-label="Drafts" className="m-0 flex list-none flex-col gap-1.5 p-0">
        {drafts.map((draft) => (
          <li
            key={draft.id}
            data-testid="draft-row"
            aria-current={draft.active ? 'true' : undefined}
            className={`flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 ${draft.active ? 'border-accent bg-surface' : 'border-line'}`}
          >
            <span className="font-medium">{draft.name}</span>
            {draft.active ? (
              <span className="rounded-full bg-accent px-2 py-0.5 text-[0.65rem] font-medium text-accent-fg">
                Active
              </span>
            ) : null}
            <span className="text-xs text-fg-muted">{words(draft.wordCount)}</span>
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              {draft.active ? null : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void switchTo(draft.id)}
                  aria-label={`Switch to ${draft.name}`}
                  className={BUTTON}
                >
                  Switch
                </button>
              )}
              {draft.active ? null : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onCompare(draft.id)}
                  aria-label={`Compare ${draft.name} with current`}
                  className={BUTTON}
                >
                  Compare with current
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => void onDuplicate(draft)}
                aria-label={`Duplicate ${draft.name}…`}
                className={BUTTON}
              >
                Duplicate…
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void onRename(draft)}
                aria-label={`Rename ${draft.name}…`}
                className={BUTTON}
              >
                Rename…
              </button>
              <button
                type="button"
                disabled={busy || draft.active}
                title={
                  draft.active ? 'Switch to another draft before deleting this one' : undefined
                }
                onClick={() => void onDelete(draft)}
                aria-label={`Delete ${draft.name}…`}
                className={BUTTON}
              >
                Delete…
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}
