import { useState } from 'react'
import type { CheckReport } from '@shared/memory/views'
import { useSceneDetailStore } from '@renderer/features/editor/sceneDetailStore'
import { useMemoryStore } from '@renderer/features/memory/memoryStore'
import { FindingRow, UnclearFindings } from '@renderer/features/memory/needsALook/FindingRow'
import { findingRuleLine } from '@renderer/features/memory/needsALook/findingView'
import { NoteConflictRow } from '@renderer/features/memory/needsALook/NoteConflictRow'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
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
 * findings hidden because a scene is a flashback (the author's Flashback switch, or the card's
 * reading), each with *Not a flashback?*: it sets the scene's switch to Not a flashback (one place
 * for the author's answer, 2026-10-14), with *Undo*, so the pair is judged next; and the secrets
 * readers know that no scene shows anyone learning, muted and scoped.
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

/**
 * A hidden finding's line: "Hobb: alive (1.3 looks like a flashback)" when the card's reading is
 * the cause, "(1.3 is set as a flashback in its scene details)" when the Flashback switch is (true
 * whoever set it).
 */
function hiddenLine(entry: CheckReport['hidden'][number]): string {
  const why = entry.typed
    ? `${entry.ref} is set as a flashback in its scene details`
    : `${entry.ref} looks like a flashback`
  return `${entry.label} (${why})`
}

/**
 * The findings hidden because a scene is a flashback, each with *Not a flashback?*: the scene's
 * Flashback switch set to Not a flashback (2026-10-14; P4-D13 marked the card's flashback not
 * right), so the author's answer lives in one place, the scene details, and wins over the card;
 * *Undo* puts the switch back as it was while it still says Not a flashback (a later change in the
 * scene details is left as it is). The finding is judged next, in the background or the next check.
 */
function HiddenFlashbacks({ hidden }: { hidden: CheckReport['hidden'] }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const notFlashback = async (entry: CheckReport['hidden'][number]): Promise<void> => {
    setBusy(true)
    try {
      const details = useSceneDetailStore.getState()
      const before = await details.setFlashback(entry.nodeId, false)
      // Undo reverses this one change only: a switch changed since in the scene details is left.
      const undo = (): void => {
        details
          .setFlashback(entry.nodeId, before, false)
          .then((now) => {
            if (now !== false) {
              toast.info(
                `${entry.ref}’s Flashback switch has changed since, so Undo left it as it is.`
              )
            }
            return useMemoryStore.getState().loadCheckReport()
          })
          .catch((err: unknown) => toast.error(describeError(err)))
      }
      toast.successWithAction(`${entry.ref} is set to Not a flashback; that pair is judged next.`, {
        label: 'Undo',
        run: undo
      })
      await useMemoryStore.getState().loadCheckReport()
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <h3 className={HEADING}>
        Hidden as flashbacks ({new Set(hidden.map((entry) => entry.findingId)).size})
      </h3>
      <ul className="m-0 list-none space-y-1 p-0 text-xs" data-testid="check-hidden">
        {hidden.map((entry) => (
          <li
            key={`${entry.findingId}:${entry.nodeId}`}
            className="flex flex-wrap items-center gap-1"
          >
            <span className="min-w-0 flex-1 text-fg-muted">{hiddenLine(entry)}</span>
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
