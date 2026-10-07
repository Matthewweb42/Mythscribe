import { trialDaysText } from '@shared/appAccess'
import { useShellDialogStore } from '@renderer/features/shell/shellDialogStore'
import { useAppAccessStore } from './appAccessStore'

/** The trial line shows itself only in the trial's last week (decided by Claude, unconfirmed). */
export const TRIAL_BANNER_DAYS = 7

const READ_ONLY_TEXT =
  'Your 30-day trial has ended. Projects open read-only; export and backup still work.'

/**
 * The trial and the read-only state (AI-BILLING-SPEC M1), one line under the header. After the
 * trial without the license it is always there, says what still works, and offers the purchase;
 * in the trial's last week it counts the days down. Buy opens Settings on the Account tab, where
 * the license is bought and refreshed (it belongs to the account). Nothing renders while the
 * trial has more than a week left, or with the license.
 */
export function TrialBanner(): React.JSX.Element | null {
  const access = useAppAccessStore((s) => s.access)
  const show = useShellDialogStore((s) => s.show)
  if (access === null || access.state === 'licensed') return null
  const expired = access.state === 'expired'
  if (!expired && access.daysLeft > TRIAL_BANNER_DAYS) return null

  return (
    <div
      role={expired ? 'alert' : 'status'}
      data-testid={expired ? 'read-only-banner' : 'trial-banner'}
      className={`flex items-center gap-3 border-b px-4 py-1.5 text-sm ${
        expired ? 'border-warning/40 bg-surface text-warning' : 'border-line bg-surface text-fg-muted'
      }`}
    >
      <span className="min-w-0 flex-1">
        {expired ? READ_ONLY_TEXT : `${trialDaysText(access.daysLeft)}.`}
      </span>
      <button
        type="button"
        data-testid="trial-buy"
        onClick={() => show('settings', 'account')}
        className="shrink-0 rounded-md bg-accent px-2 py-0.5 text-accent-fg hover:bg-accent-hover"
      >
        Buy MythScribe
      </button>
    </div>
  )
}
