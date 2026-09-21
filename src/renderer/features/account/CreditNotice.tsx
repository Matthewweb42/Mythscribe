import { useEffect } from 'react'
import { creditWarning, periodSpentMicros, projectedDaysLeft } from '@shared/cloudUsage'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { useShellDialogStore } from '@renderer/features/shell/shellDialogStore'
import { useAccountStore } from './accountStore'
import { creditWarningText } from './creditMeter'

/**
 * The soft warning of the usage meter (F-15.5): one line in the editor's status bar when the
 * project sends its AI requests to MythScribe Cloud and the balance is used up, under a dollar,
 * or a few days from running out at the period's pace. Clicking it opens Settings on the Account
 * tab, where the meter and the packs are. Nothing renders otherwise — a project on the author's
 * own key has no balance to warn about — and it never blocks a request: the hard caps are the
 * Worker's refusal at a zero balance and the app's own daily cost cap.
 *
 * The balance it reads is live: main pushes `account:balanceChanged` with every answered Cloud
 * request, so the line appears as soon as a charge crosses the line, with no Settings visit.
 */
export function CreditNotice(): React.JSX.Element | null {
  const source = useAiSettingsStore((s) => s.settings?.source ?? null)
  const status = useAccountStore((s) => s.status)
  const credits = useAccountStore((s) => s.credits)
  const creditsAt = useAccountStore((s) => s.creditsAt)
  const creditsBusy = useAccountStore((s) => s.creditsBusy)
  const creditsError = useAccountStore((s) => s.creditsError)
  const loadCredits = useAccountStore((s) => s.loadCredits)
  const show = useShellDialogStore((s) => s.show)

  const onCloud = source === 'cloud' && status?.state === 'signedIn'
  // Ask once, so the warning exists before the first Cloud request of the session rather than
  // only after it. A failure leaves `creditsError` set, which stops this from retrying in a loop.
  const needsCredits = onCloud && credits === null && !creditsBusy && creditsError === null
  useEffect(() => {
    if (needsCredits) void loadCredits()
  }, [needsCredits, loadCredits])

  if (!onCloud || credits === null || creditsAt === null) return null
  // The pace is measured against when the store last had these numbers, not a clock read during
  // render; `creditsAt` moves with every load and with every charge main pushes.
  const daysLeft = projectedDaysLeft({
    balanceMicros: credits.balanceMicros,
    spentMicros: periodSpentMicros(credits.periodSpend),
    firstChargeAt: credits.periodFirstChargeAt,
    now: creditsAt
  })
  const warning = creditWarning({ balanceMicros: credits.balanceMicros, daysLeft })
  if (warning === null) return null

  return (
    <button
      type="button"
      data-testid="credit-notice"
      title="Open the Account tab in Settings"
      onClick={() => show('settings', 'account')}
      className="ml-auto rounded-md border border-warning/40 px-1.5 py-0.5 text-warning hover:bg-surface-raised"
    >
      {creditWarningText(warning, { balanceMicros: credits.balanceMicros, daysLeft })}
    </button>
  )
}
