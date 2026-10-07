import { useEffect } from 'react'
import { CLOUD_AI_AVAILABLE } from '@shared/cloudApi'
import { MICROS_PER_USD } from '@shared/cloudBilling'
import { creditWarning, periodSpentMicros, projectedDaysLeft } from '@shared/cloudUsage'
import { WORD_COST_ACTIONS, wordsCovered } from '@shared/hostedPricing'
import { formatUsd } from '@renderer/features/ai/usageFormat'
import { useShellDialogStore } from '@renderer/features/shell/shellDialogStore'
import { useAccountStore } from './accountStore'
import { creditWarningText, wordsLeftText } from './creditMeter'
import { useHostedPricing, useHostedSource } from './hostedPricing'

/**
 * The MythScribe Cloud balance in the editor's status bar (F-15.5; AI-BILLING-SPEC E1, E2, E6):
 * whenever the project sends its AI requests to Cloud and the account is signed in, the balance
 * in dollars is always on screen, with the approximate words of line editing it still covers in
 * the tooltip once that constant has been measured. Under the configured warning line (or close
 * to running out at the period's pace) it turns into the warning. Clicking it opens Settings on
 * the Account tab, where the meter and the packs are. Nothing renders otherwise — a project on
 * the author's own key has no balance — and it never blocks a request: the hard cap is the
 * Worker's refusal when the balance cannot cover a request.
 *
 * The balance it reads is live: main pushes `account:balanceChanged` with every answered Cloud
 * request, and the store asks again when the window regains focus (after a checkout). While
 * Cloud does not serve AI yet (`CLOUD_AI_AVAILABLE`) there is nothing to spend, so it renders
 * nothing; Settings › AI tells a project still stored on Cloud to choose another source.
 */
export function BalanceNotice({
  cloudAvailable = CLOUD_AI_AVAILABLE
}: {
  /** Whether Cloud serves AI; the shared flag unless a test says otherwise. */
  cloudAvailable?: boolean
} = {}): React.JSX.Element | null {
  const hosted = useHostedSource()
  const status = useAccountStore((s) => s.status)
  const credits = useAccountStore((s) => s.credits)
  const creditsAt = useAccountStore((s) => s.creditsAt)
  const creditsBusy = useAccountStore((s) => s.creditsBusy)
  const creditsError = useAccountStore((s) => s.creditsError)
  const loadCredits = useAccountStore((s) => s.loadCredits)
  const loadPricing = useAccountStore((s) => s.loadPricing)
  const pricing = useHostedPricing()
  const show = useShellDialogStore((s) => s.show)

  const onCloud = cloudAvailable && hosted && status?.state === 'signedIn'
  // Ask once, so the balance shows before the first Cloud request of the session rather than
  // only after it. A failure leaves `creditsError` set, which stops this from retrying in a loop.
  const needsCredits = onCloud && credits === null && !creditsBusy && creditsError === null
  useEffect(() => {
    if (needsCredits) void loadCredits()
  }, [needsCredits, loadCredits])
  useEffect(() => {
    if (onCloud) void loadPricing()
  }, [onCloud, loadPricing])

  if (!onCloud || credits === null || creditsAt === null) return null
  // The pace is measured against when the store last had these numbers, not a clock read during
  // render; `creditsAt` moves with every load and with every charge main pushes.
  const daysLeft = projectedDaysLeft({
    balanceMicros: credits.balanceMicros,
    spentMicros: periodSpentMicros(credits.periodSpend),
    firstChargeAt: credits.periodFirstChargeAt,
    now: creditsAt
  })
  const warning = creditWarning({
    balanceMicros: credits.balanceMicros,
    daysLeft,
    lowMicros: pricing.lowBalanceWarningMicros
  })
  const wordsLeft = wordsLeftText(
    wordsCovered(pricing, credits.balanceMicros, 'lineEdit'),
    WORD_COST_ACTIONS.lineEdit
  )
  const balance = formatUsd(Math.max(0, credits.balanceMicros) / MICROS_PER_USD)

  return (
    <button
      type="button"
      data-testid="balance-notice"
      data-warning={warning ?? undefined}
      title={wordsLeft ?? 'Open the Account tab in Settings'}
      onClick={() => show('settings', 'account')}
      className={
        warning === null
          ? 'ml-auto rounded-md px-1.5 py-0.5 tabular-nums hover:bg-surface-raised'
          : 'ml-auto rounded-md border border-warning/40 px-1.5 py-0.5 text-warning hover:bg-surface-raised'
      }
    >
      {warning === null
        ? `Balance ${balance}`
        : creditWarningText(warning, { balanceMicros: credits.balanceMicros, daysLeft })}
    </button>
  )
}
