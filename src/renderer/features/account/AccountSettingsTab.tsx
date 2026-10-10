import { useEffect, useState } from 'react'
import { trialDaysText } from '@shared/appAccess'
import { EMAIL_MAX } from '@shared/cloudApi'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { formatUsd } from '@renderer/features/ai/usageFormat'
import { describeError } from '@renderer/lib/errors'
import { useAccountStore } from './accountStore'
import { BalanceSection } from './BalanceSection'
import { useAppAccessStore } from './appAccessStore'

const FIELD = 'min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 text-sm'
const BUTTON =
  'shrink-0 rounded-md border border-line px-2 py-1 text-sm hover:bg-surface disabled:opacity-50 disabled:hover:bg-transparent'

/**
 * What the account is for, before any field (changed by the author 2026-10-10: after the trial,
 * writing needs the license, which belongs to an account, so "never needed" no longer held).
 */
const INTRO = 'The account holds your MythScribe license and connects MythScribe Cloud.'

const clockTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { timeStyle: 'short' })

const day = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })

/**
 * What the MythScribe license is (AI-BILLING-SPEC M1, superseding the F-15.9 Supporter copy): the
 * one-time purchase, the trial, what happens after it, and the extras it includes.
 */
const LICENSE_INTRO =
  'MythScribe is a one-time purchase with a 30-day free trial. After the trial, projects open ' +
  'read-only until you buy it; export and backup always work. The license also includes the ' +
  'accent colours, the Sepia theme, and custom themes (Settings › Appearance).'

/**
 * The Account tab of the Settings dialog (F-15.2). Three states, one at a time, from the store
 * main owns: signed out (an email address and "Send sign-in link"), pending (the link was
 * emailed and main is polling; this window signs itself in when the link is opened anywhere,
 * so there is nothing to paste back), and signed in, which also carries the MythScribe Cloud
 * balance (F-15.3, `BalanceSection`). Failures show inline under the controls because the author is looking at them, not
 * at a toast. Nothing here gates any other feature.
 */
export function AccountSettingsTab(): React.JSX.Element {
  const status = useAccountStore((s) => s.status)
  const busy = useAccountStore((s) => s.busy)
  const error = useAccountStore((s) => s.error)
  const requestLink = useAccountStore((s) => s.requestLink)
  const cancelLink = useAccountStore((s) => s.cancelLink)
  const signOut = useAccountStore((s) => s.signOut)
  const refresh = useAccountStore((s) => s.refresh)

  // `since` is only known once the Worker has been asked, so a session restored from disk fills
  // it the first time the author opens this tab. A failure leaves the status as it is.
  const needsSince = status?.state === 'signedIn' && status.since === null
  useEffect(() => {
    if (needsSince) void refresh()
  }, [needsSince, refresh])

  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="m-0 text-fg-muted">{INTRO}</p>

      {status === null ? null : status.state === 'signedOut' ? (
        <SignInForm busy={busy} onSubmit={(email) => void requestLink(email)} />
      ) : status.state === 'pending' ? (
        <div className="flex flex-col gap-2">
          <p className="m-0">
            We sent a sign-in link to {status.email}. Open it on any device; this window signs in by
            itself.
          </p>
          <p className="m-0 text-xs text-fg-muted">
            The link works until {clockTime(status.expiresAt)}.
          </p>
          {status.devLink === undefined ? null : (
            <DevLink key={status.devLink} url={status.devLink} />
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void cancelLink()}
              className={BUTTON}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void requestLink(status.email)}
              className={BUTTON}
            >
              Send again
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span data-testid="account-signed-in">Signed in as {status.email}</span>
            <button type="button" disabled={busy} onClick={() => void signOut()} className={BUTTON}>
              Sign out
            </button>
          </div>
          {status.since === null ? null : (
            <p className="m-0 text-xs text-fg-muted">since {day(status.since)}</p>
          )}
          <BalanceSection />
        </div>
      )}

      {/* M1: the license is cached locally, so it shows signed in or out; buying needs the account. */}
      {status === null ? null : <LicenseSection signedIn={status.state === 'signedIn'} />}

      {error === null ? null : (
        <p role="alert" className="m-0 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * The MythScribe license (AI-BILLING-SPEC M1; the F-15.9 Supporter license it supersedes): a
 * one-time purchase, bought through the same Lemon Squeezy checkout as the packs and granted to
 * the account. Licensed shows the badge and, while the Worker cannot be reached, how long the
 * cached token stays good; unlicensed says where the trial stands, what the purchase is, and
 * offers it. App loads the license and the trial at start (both are local), so this section never
 * asks on mount; Refresh needs the account, and is how a purchase made in the browser lands.
 */
function LicenseSection({ signedIn }: { signedIn: boolean }): React.JSX.Element {
  const supporter = useAccountStore((s) => s.supporter)
  const busy = useAccountStore((s) => s.supporterBusy)
  const error = useAccountStore((s) => s.supporterError)
  const refreshSupporter = useAccountStore((s) => s.refreshSupporter)
  const buySupporter = useAccountStore((s) => s.buySupporter)
  const access = useAppAccessStore((s) => s.access)
  const licensed = supporter?.licensed === true
  const product = supporter?.product ?? null

  return (
    <section
      aria-label="MythScribe license"
      className="flex flex-col gap-2 border-t border-line pt-3"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="m-0 text-sm font-medium">MythScribe license</h3>
        <button
          type="button"
          // Its own name, so it is not the credits Refresh with a different job behind it.
          aria-label="Refresh license"
          title="Refresh license"
          disabled={busy || !signedIn}
          onClick={() => void refreshSupporter()}
          className={BUTTON}
        >
          Refresh
        </button>
      </div>

      {licensed && supporter !== null ? (
        <>
          <span
            data-testid="account-supporter-badge"
            className="self-start rounded-md border border-accent px-2 py-0.5 text-xs text-accent"
          >
            {/* `since` is the token's `iat`; a verified license always carries one. */}
            {supporter.since === null ? 'Licensed' : `Licensed since ${day(supporter.since)}`}
          </span>
          {supporter.offline && supporter.validUntil !== null ? (
            <p className="m-0 text-xs text-fg-muted">
              {`Your license stays active until ${day(supporter.validUntil)} while MythScribe Cloud cannot be reached.`}
            </p>
          ) : null}
        </>
      ) : (
        <>
          {access === null || access.state === 'licensed' ? null : (
            <p
              data-testid="account-trial-status"
              className={`m-0 ${access.state === 'expired' ? 'text-warning' : ''}`}
            >
              {access.state === 'expired'
                ? 'Your trial has ended. Projects open read-only; export and backup still work.'
                : `${trialDaysText(access.daysLeft)} (it ends ${day(access.trialEndsAt)}).`}
            </p>
          )}
          <p className="m-0 text-fg-muted">{LICENSE_INTRO}</p>
          {product === null ? (
            <p className="m-0 text-xs text-fg-muted">The MythScribe license is not on sale yet.</p>
          ) : (
            <button
              type="button"
              data-testid="account-supporter-buy"
              disabled={busy || !signedIn}
              onClick={() => void buySupporter()}
              className={BUTTON}
            >
              {`Buy MythScribe — ${formatUsd(product.priceCents / 100)}`}
            </button>
          )}
          {signedIn ? (
            <p className="m-0 text-xs text-fg-muted">
              After paying in the browser, press Refresh to activate the license here.
            </p>
          ) : (
            <p className="m-0 text-xs text-fg-muted">
              Sign in to buy it: the license belongs to your account, so it follows you to the next
              machine.
            </p>
          )}
        </>
      )}

      {error === null ? null : (
        <p role="alert" className="m-0 text-xs text-danger">
          {error}
        </p>
      )}
    </section>
  )
}

/** The signed-out state: one address, one button; Enter sends the link too. */
function SignInForm({
  busy,
  onSubmit
}: {
  busy: boolean
  onSubmit: (email: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const trimmed = draft.trim()
  return (
    <form
      aria-label="Sign in"
      onSubmit={(event) => {
        event.preventDefault()
        if (trimmed.length > 0 && !busy) onSubmit(trimmed)
      }}
      className="flex items-center gap-2"
    >
      <label className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0">Email</span>
        <input
          type="email"
          autoComplete="email"
          spellCheck={false}
          maxLength={EMAIL_MAX}
          value={draft}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          className={FIELD}
        />
      </label>
      <button type="submit" disabled={busy || trimmed.length === 0} className={BUTTON}>
        Send sign-in link
      </button>
    </form>
  )
}

/**
 * Only from a Worker running the `log` mail transport (local dev): the link the email would
 * have carried. It is shown as text with a copy button rather than a link, because the app
 * only ever hands https://mythscribe.app/ URLs to the OS browser (`menu:openExternal`).
 */
function DevLink({ url }: { url: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  // A clipboard the platform refuses (or does not expose) must not take the tab down with it;
  // the link is on screen, so the author can still select it.
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch (err: unknown) {
      toast.error(describeError(err))
    }
  }
  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0 text-xs text-fg-muted">Local dev:</span>
      <code data-testid="account-dev-link" className="min-w-0 flex-1 truncate font-mono text-xs">
        {url}
      </code>
      <button type="button" onClick={() => void copy()} className={BUTTON}>
        Copy link
      </button>
      {copied ? (
        <span role="status" className="shrink-0 text-xs text-fg-muted">
          Copied
        </span>
      ) : null}
    </div>
  )
}
