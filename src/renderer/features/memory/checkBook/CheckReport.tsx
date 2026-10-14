import { useState } from 'react'
import type { CheckReport } from '@shared/memory/views'
import { useMemoryStore } from '@renderer/features/memory/memoryStore'
import { FindingRow, UnclearFindings } from '@renderer/features/memory/needsALook/FindingRow'
import { findingRuleLine } from '@renderer/features/memory/needsALook/findingView'
import { NoteConflictRow } from '@renderer/features/memory/needsALook/NoteConflictRow'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import {
  checkedLine,
  checkSkipsLine,
  nobodyLearnsLine,
  notCheckedExtras,
  reportHead
} from './checkView'

const SMALL =
  'rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40'
const HEADING = 'm-0 mt-3 mb-1 text-xs font-medium tracking-wide text-fg-muted uppercase'

/**
 * *Check the book*'s report (F-16.30; plan P4 §4, design §2.4): when it ran and what it cost; what
 * it found (each as Needs a look shows it, with the same answers), the unclear ones (shown as
 * unclear), the ones the stronger check cleared; what it checked ("Checked: 124 pairs over 90
 * scenes and your notes; 20 confirmed by a stronger AI read") and what it did not (what no rule
 * covers, the scenes not read yet, findings past the 20 confirmations, pairs a Stop left); the
 * findings hidden because a scene looks like a flashback, each with *Not a flashback?* (the card's
 * flashback marked not right, so it is judged next); and the secrets readers know that no scene
 * shows anyone learning, muted and scoped.
 */
export function CheckReportView({
  report,
  onNavigate
}: {
  report: CheckReport
  /** Closes the dialog the report is drawn in before a row opens a scene or a note behind it. */
  onNavigate: () => void
}): React.JSX.Element {
  const extras = notCheckedExtras(report)
  return (
    <div className="text-sm" data-testid="check-report">
      <p className="m-0 text-xs text-fg-muted">{reportHead(report)}</p>
      <h3 className={HEADING}>Found ({report.found.length})</h3>
      {report.found.length === 0 ? (
        <p className="m-0 text-xs text-fg-muted">
          No possible contradictions among what was checked.
        </p>
      ) : (
        <ul className="m-0 list-none space-y-2 p-0 text-xs">
          {report.found.map((finding) =>
            finding.rule === 'C6' ? (
              <NoteConflictRow key={finding.id} finding={finding} onNavigate={onNavigate} />
            ) : (
              <FindingRow key={finding.id} finding={finding} onNavigate={onNavigate} />
            )
          )}
        </ul>
      )}
      <UnclearFindings findings={report.unclear} onNavigate={onNavigate} />
      {report.cleared.length === 0 ? null : (
        <div className="mt-2 text-xs text-fg-muted" role="group" aria-label="Cleared">
          <p className="m-0">The stronger check found no contradiction in:</p>
          <ul className="m-0 list-disc pl-4">
            {report.cleared.map((finding) => (
              <li key={finding.id}>{findingRuleLine(finding)}</li>
            ))}
          </ul>
        </div>
      )}
      <h3 className={HEADING}>Checked</h3>
      <p className="m-0 text-xs" data-testid="check-checked">
        {checkedLine(report)}
      </p>
      <h3 className={HEADING}>Not checked</h3>
      <p className="m-0 text-xs text-fg-muted" data-testid="check-not-checked">
        {checkSkipsLine(report.notChecked.fixed, report.notChecked.unreadScenes)}
      </p>
      {extras.map((line) => (
        <p key={line} className="m-0 text-xs text-fg-muted">
          {line}
        </p>
      ))}
      {report.hidden.length === 0 ? null : <HiddenFlashbacks hidden={report.hidden} />}
      {report.secretsNobodyLearns.length === 0 ? null : (
        <>
          <h3 className={HEADING}>Secrets</h3>
          <ul className="m-0 list-none space-y-0.5 p-0 text-xs text-fg-muted opacity-80">
            {report.secretsNobodyLearns.map((secret) => (
              <li key={secret.secretId} data-testid="nobody-learns">
                {nobodyLearnsLine(secret)}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/** The findings hidden because a scene looks like a flashback, each with *Not a flashback?*. */
function HiddenFlashbacks({ hidden }: { hidden: CheckReport['hidden'] }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const notFlashback = async (entry: CheckReport['hidden'][number]): Promise<void> => {
    setBusy(true)
    try {
      const store = useMemoryStore.getState()
      // P4-D13: the card's flashback marked not right (P2a's Not right on a card value); the
      // finding is judged next, in the background or the next check.
      const marked = await store.cardNotRight({
        nodeId: entry.nodeId,
        field: 'flashback',
        value: 'yes'
      })
      if (!marked) return
      toast.info(`${entry.ref} is no longer read as a flashback; that pair is judged next.`)
      await store.loadCheckReport()
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <h3 className={HEADING}>Hidden as flashbacks ({hidden.length})</h3>
      <ul className="m-0 list-none space-y-1 p-0 text-xs" data-testid="check-hidden">
        {hidden.map((entry) => (
          <li key={entry.findingId} className="flex flex-wrap items-center gap-1">
            <span className="min-w-0 flex-1 text-fg-muted">
              {entry.label} ({entry.ref} looks like a flashback)
            </span>
            <button
              type="button"
              className={SMALL}
              disabled={busy}
              onClick={() => void notFlashback(entry)}
            >
              Not a flashback?
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}
