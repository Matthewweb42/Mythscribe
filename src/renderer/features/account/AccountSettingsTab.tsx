import { useEffect, useState } from 'react'
import { EMAIL_MAX, type CreditsResult } from '@shared/cloudApi'
import { CLOUD_RATES, MICROS_PER_USD } from '@shared/cloudRates'
import { creditWarning, periodSpentMicros, projectedDaysLeft } from '@shared/cloudUsage'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { featureLabel, formatCount, formatUsd } from '@renderer/features/ai/usageFormat'
import { describeError } from '@renderer/lib/errors'
import { useAccountStore } from './accountStore'
import { creditWarningText, runOutText } from './creditMeter'

const FIELD = 'min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 text-sm'
const BUTTON =
  'shrink-0 rounded-md border border-line px-2 py-1 text-sm hover:bg-surface disabled:opacity-50 disabled:hover:bg-transparent'

/** The one promise the tab makes, before any field: the account is never needed to write. */
const INTRO =
  'Optional. You never need an account to write. It will connect MythScribe Cloud, which is not available yet.'

const clockTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { timeStyle: 'short' })

const day = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })

/** The one line about the rates, so no one reads the table as the provider's own price. */
const RATES_NOTE =
  "Rates include MythScribe's margin over the provider price; each request is charged at the " +
  'rate of the model that answered.'

/**
 * The Account tab of the Settings dialog (F-15.2). Three states, one at a time, from the store
 * main owns: signed out (an email address and "Send sign-in link"), pending (the link was
 * emailed and main is polling; this window signs itself in when the link is opened anywhere,
 * so there is nothing to paste back), and signed in, which also carries the Cloud credits
 * (F-15.3). Failures show inline under the controls because the author is looking at them, not
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
          <CreditsSection />
        </div>
      )}

      {error === null ? null : (
        <p role="alert" className="m-0 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * The Cloud credits of the signed-in account (F-15.3): the balance, the packs on sale, what
 * each feature has spent, and the published rate table. It mounts with the signed-in state, so
 * the balance is asked for on sign-in and on every later visit to the tab; "Refresh" asks again
 * after a checkout was paid in the browser. Its failures stay in here, under their own alert,
 * so an unreachable Worker never hides the sign-out button.
 */
function CreditsSection(): React.JSX.Element {
  const credits = useAccountStore((s) => s.credits)
  const creditsAt = useAccountStore((s) => s.creditsAt)
  const busy = useAccountStore((s) => s.creditsBusy)
  const error = useAccountStore((s) => s.creditsError)
  const loadCredits = useAccountStore((s) => s.loadCredits)
  const buyCredits = useAccountStore((s) => s.buyCredits)

  useEffect(() => {
    void loadCredits()
  }, [loadCredits])

  return (
    <section aria-label="Credits" className="flex flex-col gap-2 border-t border-line pt-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="m-0 text-sm font-medium">Credits</h3>
        <button type="button" disabled={busy} onClick={() => void loadCredits()} className={BUTTON}>
          Refresh
        </button>
      </div>

      {credits === null ? null : (
        <>
          <div className="flex items-center justify-between gap-3">
            <span>Balance</span>
            <span data-testid="account-credit-balance" className="tabular-nums">
              {formatUsd(credits.balanceMicros / MICROS_PER_USD)}
            </span>
          </div>

          {creditsAt === null ? null : <UsageMeter credits={credits} now={creditsAt} />}

          {credits.packs.length === 0 ? (
            <p className="m-0 text-xs text-fg-muted">Credit packs are not on sale yet.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {credits.packs.map((pack) => (
                <button
                  key={pack.variantId}
                  type="button"
                  disabled={busy}
                  onClick={() => void buyCredits(pack.variantId)}
                  className={BUTTON}
                >
                  {`Buy ${formatUsd(pack.priceCents / 100)}`}
                </button>
              ))}
            </div>
          )}

          {credits.periodSpend.length === 0 ? (
            <p className="m-0 text-xs text-fg-muted">
              {credits.spend.length === 0
                ? 'No Cloud requests yet.'
                : `No Cloud requests in the last ${formatCount(credits.periodDays, 'day')}.`}
            </p>
          ) : (
            <table aria-label="Cloud spend by feature" className="w-full text-xs">
              <caption className="text-left text-fg-muted">{`Last ${formatCount(credits.periodDays, 'day')}`}</caption>
              <thead className="text-fg-muted">
                <tr>
                  <th scope="col" className="text-left font-normal">
                    Feature
                  </th>
                  <th scope="col" className="text-right font-normal">
                    Requests
                  </th>
                  <th scope="col" className="text-right font-normal">
                    Tokens
                  </th>
                  <th scope="col" className="text-right font-normal">
                    Spent
                  </th>
                </tr>
              </thead>
              <tbody>
                {credits.periodSpend.map((row) => (
                  <tr key={row.feature}>
                    <th scope="row" className="text-left font-normal">
                      {featureLabel(row.feature)}
                    </th>
                    <td className="text-right tabular-nums">{formatCount(row.requests)}</td>
                    <td className="text-right tabular-nums">{formatCount(row.tokens)}</td>
                    <td className="text-right tabular-nums">
                      {formatUsd(row.micros / MICROS_PER_USD)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {credits.spend.length === 0 ? null : (
            <p data-testid="account-all-time" className="m-0 text-xs text-fg-muted">
              {`All time: ${formatUsd(periodSpentMicros(credits.spend) / MICROS_PER_USD)}`}
            </p>
          )}
        </>
      )}

      <table aria-label="MythScribe Cloud rates" className="w-full text-xs">
        <thead className="text-fg-muted">
          <tr>
            <th scope="col" className="text-left font-normal">
              Model
            </th>
            <th scope="col" className="text-left font-normal">
              Tier
            </th>
            <th scope="col" className="text-right font-normal">
              Input per 1M
            </th>
            <th scope="col" className="text-right font-normal">
              Output per 1M
            </th>
          </tr>
        </thead>
        <tbody>
          {CLOUD_RATES.map((rate) => (
            <tr key={rate.model}>
              <th scope="row" className="text-left font-normal">
                {rate.model}
              </th>
              <td className="text-left">{rate.tiers.length === 0 ? '—' : rate.tiers.join(', ')}</td>
              <td className="text-right tabular-nums">{formatUsd(rate.inUsdPerM)}</td>
              <td className="text-right tabular-nums">{formatUsd(rate.outUsdPerM)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="m-0 text-xs text-fg-muted">{RATES_NOTE}</p>

      {error === null ? null : (
        <p role="alert" className="m-0 text-xs text-danger">
          {error}
        </p>
      )}
    </section>
  )
}

/**
 * The usage meter (F-15.5): what the rolling period cost, how long the balance lasts at that
 * pace, and the one warning line when it is running out. The period is a window, not a billing
 * cycle — credits are prepaid — so it says "the last 30 days" rather than "this month". `now` is
 * when the store last had these numbers from the Worker, not a clock read during render. The
 * same two pure functions drive the status-bar notice.
 */
function UsageMeter({ credits, now }: { credits: CreditsResult; now: number }): React.JSX.Element {
  const spentMicros = periodSpentMicros(credits.periodSpend)
  const daysLeft = projectedDaysLeft({
    balanceMicros: credits.balanceMicros,
    spentMicros,
    firstChargeAt: credits.periodFirstChargeAt,
    now
  })
  const warning = creditWarning({ balanceMicros: credits.balanceMicros, daysLeft })
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <span>{`Used in the last ${formatCount(credits.periodDays, 'day')}`}</span>
        <span data-testid="account-period-spent" className="tabular-nums">
          {formatUsd(spentMicros / MICROS_PER_USD)}
        </span>
      </div>
      <p data-testid="account-run-out" className="m-0 text-xs text-fg-muted">
        {runOutText(daysLeft)}
      </p>
      {warning === null ? null : (
        <p role="status" data-testid="account-credit-warning" className="m-0 text-xs text-warning">
          {creditWarningText(warning, { balanceMicros: credits.balanceMicros, daysLeft })}
        </p>
      )}
    </div>
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
