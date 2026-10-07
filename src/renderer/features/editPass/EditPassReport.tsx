import { useMemo } from 'react'
import { X } from 'lucide-react'
import { outputBudget } from '@shared/ai'
import {
  DEVELOPMENTAL_CATEGORY_LABEL,
  EDIT_PASS_LABEL,
  estimateEditPass,
  type EditChange,
  type EditPassDetail
} from '@shared/editPass'
import { formatCount, formatUsd } from '@renderer/features/ai/usageFormat'
import {
  FIX_BUTTON,
  FIX_PRIMARY_BUTTON,
  FixDiff,
  OffVoiceFlag
} from '@renderer/features/editor/FixDiff'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { dialogs } from '@renderer/features/shell/dialogs/dialogStore'
import { useEditPassStore } from './editPassStore'
import { useEditPassViewStore } from './editPassViewStore'
import { PASS_STATUS_LABEL, passCounts, passDate, passTitle } from './passFormat'

const STATUS_LABEL: Record<EditChange['status'], string> = {
  pending: 'To review',
  accepted: 'Accepted',
  rejected: 'Rejected',
  stale: 'Out of date'
}
const NOTE_STATUS_LABEL: Record<EditChange['status'], string> = {
  pending: 'To review',
  accepted: 'Done',
  rejected: 'Dismissed',
  stale: 'Out of date'
}

/**
 * The report of one edit pass (F-14.15), a document in the main pane: what kind of edit ran,
 * over which scenes, what it cost against what an editor typically charges for those words, and
 * every change scene by scene — the passage struck through, the replacement in colour, and why —
 * with Accept, Reject, and Show in scene (which opens the scene with the change highlighted in
 * its tracked changes). A developmental pass's report is its notes, each citing its passage.
 * Accept all and Reject all act on every change still to review; a stopped or failed pass can
 * be resumed from here.
 */
export function EditPassReport({ passId }: { passId: string }): React.JSX.Element {
  const detail = useEditPassStore((s) => (s.detail?.pass.id === passId ? s.detail : null))
  return (
    <article
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
      aria-label="Edit report"
      data-testid="edit-report"
    >
      {detail === null ? (
        <p className="m-0 p-6 text-sm text-fg-muted">Loading the report…</p>
      ) : (
        <ReportBody detail={detail} />
      )}
    </article>
  )
}

function ReportBody({ detail }: { detail: EditPassDetail }): React.JSX.Element {
  const { pass, changes, titles } = detail
  const busy = useEditPassStore((s) => s.busy)
  const words = useTreeStore((s) => s.wordCountRollup)
  const notes = pass.type === 'developmental'
  const pending = changes.filter((change) => change.status === 'pending')
  const groups = useMemo(() => {
    const byNode = new Map<string, EditChange[]>()
    for (const change of changes) {
      byNode.set(change.nodeId, [...(byNode.get(change.nodeId) ?? []), change])
    }
    return pass.nodeIds
      .filter((id) => pass.doneNodeIds.includes(id))
      .map((id) => ({ id, changes: byNode.get(id) ?? [] }))
  }, [changes, pass.nodeIds, pass.doneNodeIds])
  const pro = estimateEditPass(
    pass.type,
    pass.doneNodeIds.map((id) => words[id] ?? 0),
    pass.model,
    outputBudget('editPass')
  )

  const remove = async (): Promise<void> => {
    const ok = await dialogs.confirm({
      title: 'Delete this report?',
      message:
        'Its changes still to review go with it. Changes you already accepted stay in the manuscript.',
      confirmLabel: 'Delete',
      danger: true
    })
    if (ok) await useEditPassStore.getState().remove(pass.id)
  }

  return (
    <>
      <header className="flex flex-col gap-1 border-b border-line px-6 py-4">
        <div className="flex items-start gap-2">
          <h2 className="m-0 flex-1 text-lg font-semibold" data-testid="edit-report-title">
            {passTitle(pass)}
          </h2>
          <button
            type="button"
            aria-label="Close the report"
            className="rounded-md p-1 text-fg-muted hover:bg-surface-raised hover:text-fg"
            onClick={() => useEditPassViewStore.getState().close()}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <p className="m-0 text-sm text-fg-muted">
          {`${PASS_STATUS_LABEL[pass.status]} · ${passDate(pass.createdAt)} · ${pass.doneNodeIds.length} of ${pass.nodeIds.length} scenes · ${formatCount(pro.words, 'word')}`}
        </p>
        {pass.instruction ? (
          <p className="m-0 text-sm">
            <span className="text-fg-muted">Instruction: </span>
            {pass.instruction}
          </p>
        ) : null}
        <p className="m-0 text-sm" data-testid="edit-report-cost">
          {`Cost: ${formatUsd(pass.costUsd)}${pass.model ? ` on ${pass.model}` : ''} · ${formatCount(pass.tokensIn)} tokens in · ${formatCount(pass.tokensOut)} out. A professional ${EDIT_PASS_LABEL[pass.type].toLowerCase()} of these words typically costs ${formatUsd(pro.proLowUsd)} to ${formatUsd(pro.proHighUsd)}.`}
        </p>
        <p className="m-0 text-sm" data-testid="edit-report-counts">
          {`${passCounts(pass)}${pass.dropped > 0 ? ` · ${pass.dropped} discarded (not found once in the scene)` : ''}`}
        </p>
        {pass.error ? <p className="m-0 text-sm text-danger">{pass.error}</p> : null}
        <div className="mt-1 flex flex-wrap gap-2">
          {!notes && pending.length > 0 ? (
            <>
              <button
                type="button"
                className={FIX_PRIMARY_BUTTON}
                disabled={busy}
                data-testid="edit-report-accept-all"
                onClick={() => void useEditPassStore.getState().accept(pending)}
              >
                Accept all
              </button>
              <button
                type="button"
                className={FIX_BUTTON}
                disabled={busy}
                onClick={() => void useEditPassStore.getState().reject(pending)}
              >
                Reject all
              </button>
            </>
          ) : null}
          {pass.status === 'cancelled' || pass.status === 'failed' ? (
            <button
              type="button"
              className={FIX_BUTTON}
              onClick={() => void useEditPassStore.getState().resume(pass.id)}
            >
              Resume the pass
            </button>
          ) : null}
          {pass.status === 'running' ? null : (
            <button type="button" className={FIX_BUTTON} onClick={() => void remove()}>
              Delete report
            </button>
          )}
        </div>
      </header>
      {groups.length === 0 ? (
        <p className="m-0 px-6 py-4 text-sm text-fg-muted">No scene has been read yet.</p>
      ) : (
        groups.map((group) => (
          <section
            key={group.id}
            aria-label={titles[group.id] ?? 'Scene'}
            className="flex flex-col gap-2 border-b border-line px-6 py-4"
            data-testid="edit-report-scene"
          >
            <h3 className="m-0 text-sm font-semibold">{titles[group.id] ?? 'Deleted scene'}</h3>
            {group.changes.length === 0 ? (
              <p className="m-0 text-sm text-fg-muted">
                {notes ? 'No notes for this scene.' : 'Nothing to change in this scene.'}
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {group.changes.map((change) => (
                  <ChangeItem key={change.id} change={change} busy={busy} />
                ))}
              </ul>
            )}
          </section>
        ))
      )}
    </>
  )
}

function ChangeItem({ change, busy }: { change: EditChange; busy: boolean }): React.JSX.Element {
  const store = useEditPassStore.getState()
  const pending = change.status === 'pending'
  const note = change.kind === 'note'
  return (
    <li
      className="flex flex-col gap-1"
      data-testid="edit-report-change"
      data-status={change.status}
    >
      {note ? (
        <>
          <span className="text-xs font-medium text-fg-muted">
            {change.category === null ? 'Note' : DEVELOPMENTAL_CATEGORY_LABEL[change.category]}
          </span>
          <blockquote className="m-0 border-l-2 border-line pl-2 text-sm italic text-fg-muted">
            {change.original}
          </blockquote>
          <p className="m-0 text-sm">{change.rationale}</p>
        </>
      ) : (
        <>
          <FixDiff
            quote={change.original}
            fix={change.replacement ?? ''}
            testId="edit-report-diff"
          />
          {change.rationale ? (
            <p className="m-0 text-xs text-fg-muted">{change.rationale}</p>
          ) : null}
          {change.flagged ? (
            <OffVoiceFlag violation={change.violation} testId="edit-report-flag" />
          ) : null}
        </>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-fg-muted">
          {(note ? NOTE_STATUS_LABEL : STATUS_LABEL)[change.status]}
        </span>
        {pending && !note ? (
          <>
            <button
              type="button"
              className={FIX_PRIMARY_BUTTON}
              disabled={busy}
              data-testid="edit-report-accept"
              onClick={() => void store.accept([change])}
            >
              Accept
            </button>
            <button
              type="button"
              className={FIX_BUTTON}
              disabled={busy}
              onClick={() => void store.reject([change])}
            >
              Reject
            </button>
          </>
        ) : null}
        {pending && note ? (
          <>
            <button
              type="button"
              className={FIX_BUTTON}
              onClick={() => void store.markDone([change])}
            >
              Mark done
            </button>
            <button
              type="button"
              className={FIX_BUTTON}
              onClick={() => void store.reject([change])}
            >
              Dismiss
            </button>
          </>
        ) : null}
        {change.status === 'stale' ? null : (
          <button type="button" className={FIX_BUTTON} onClick={() => store.jump(change)}>
            Show in scene
          </button>
        )}
      </div>
    </li>
  )
}
