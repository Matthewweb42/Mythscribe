import { useEffect, useState } from 'react'
import type { CreditsResult, LedgerEntryType, PricingResult, UsageEntry } from '@shared/cloudApi'
import { MICROS_PER_USD } from '@shared/cloudBilling'
import { creditWarning, periodSpentMicros, projectedDaysLeft } from '@shared/cloudUsage'
import { multiplierLabel, WORD_COST_ACTIONS, wordsCovered } from '@shared/hostedPricing'
import { featureLabel, formatCount, formatUsd } from '@renderer/features/ai/usageFormat'
import { useAccountStore } from './accountStore'
import {
  creditWarningText,
  packExampleText,
  positioningText,
  PRIVACY_TEXT,
  runOutText,
  termsText,
  wordsLeftText
} from './creditMeter'
import { useHostedPricing } from './hostedPricing'

const BUTTON =
  'shrink-0 rounded-md border border-line px-2 py-1 text-sm hover:bg-surface disabled:opacity-50 disabled:hover:bg-transparent'

/** How the usage history names an entry that is not a charge for a feature. */
const ENTRY_LABEL: Record<LedgerEntryType, string> = {
  topup: 'Added to balance',
  trial_grant: 'Trial balance',
  charge: 'AI request',
  refund: 'Refund',
  adjustment: 'Adjustment'
}

const entryAction = (entry: UsageEntry): string =>
  entry.type === 'charge' && entry.feature !== null
    ? featureLabel(entry.feature)
    : ENTRY_LABEL[entry.type]

const entryDate = (at: number): string =>
  new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** A signed amount: "+$10.00" for money in, "−$0.01" for a charge. */
const signedUsd = (micros: number): string =>
  `${micros < 0 ? '−' : '+'}${formatUsd(Math.abs(micros) / MICROS_PER_USD)}`

/**
 * The MythScribe Cloud balance of the signed-in account (F-15.3, AI-BILLING-SPEC E1–E7, C2–C4):
 * the balance in dollars, the words it still covers once measured, the low-balance warning at the
 * configured line, the period meter, the packs (each described by example once measured) with the
 * privacy statement beside them, spend per feature, the models on sale with their multiplier, and
 * the usage history. No token counts outside the history (C4). It mounts with the signed-in
 * state, so the balance is asked for on sign-in and on every later visit; the store asks again
 * when the window regains focus after a checkout. Its failures stay in here, under their own
 * alert, so an unreachable Worker never hides the sign-out button.
 */
export function BalanceSection(): React.JSX.Element {
  const credits = useAccountStore((s) => s.credits)
  const creditsAt = useAccountStore((s) => s.creditsAt)
  const busy = useAccountStore((s) => s.creditsBusy)
  const error = useAccountStore((s) => s.creditsError)
  const loadCredits = useAccountStore((s) => s.loadCredits)
  const loadPricing = useAccountStore((s) => s.loadPricing)
  const buyCredits = useAccountStore((s) => s.buyCredits)
  const pricing = useHostedPricing()

  useEffect(() => {
    void loadCredits()
    void loadPricing()
  }, [loadCredits, loadPricing])

  const packs = credits?.packs.filter((pack) => pack.priceCents * 10_000 >= pricing.minPackMicros)

  return (
    <section aria-label="Balance" className="flex flex-col gap-2 border-t border-line pt-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="m-0 text-sm font-medium">MythScribe Cloud balance</h3>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void loadCredits()
            void loadPricing()
          }}
          className={BUTTON}
        >
          Refresh
        </button>
      </div>
      <p className="m-0 text-xs text-fg-muted" data-testid="account-positioning">
        {positioningText(pricing)}
      </p>

      {credits === null ? null : (
        <>
          <div className="flex items-center justify-between gap-3">
            <span>Balance</span>
            <span data-testid="account-balance" className="tabular-nums">
              {formatUsd(Math.max(0, credits.balanceMicros) / MICROS_PER_USD)}
            </span>
          </div>
          <WordsLeft pricing={pricing} balanceMicros={credits.balanceMicros} />

          {creditsAt === null ? null : (
            <UsageMeter credits={credits} now={creditsAt} pricing={pricing} />
          )}

          {packs === undefined || packs.length === 0 ? (
            <p className="m-0 text-xs text-fg-muted">Packs are not on sale yet.</p>
          ) : (
            <ul aria-label="Packs" className="m-0 flex list-none flex-col gap-1 p-0">
              {packs.map((pack) => {
                const example = packExampleText(pricing, pack.priceCents)
                return (
                  <li key={pack.variantId} className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void buyCredits(pack.variantId)}
                      className={BUTTON}
                    >
                      {`Add ${formatUsd(pack.priceCents / 100)}`}
                    </button>
                    {example === null ? null : (
                      <span
                        data-testid={`account-pack-example-${pack.variantId}`}
                        className="text-xs text-fg-muted"
                      >
                        {example}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          <p data-testid="account-privacy" className="m-0 text-xs text-fg-muted">
            {PRIVACY_TEXT}
          </p>
          <p data-testid="account-terms" className="m-0 text-xs text-fg-muted">
            {termsText(pricing)}
          </p>

          <SpendTable credits={credits} />
        </>
      )}

      <ModelsTable pricing={pricing} />

      {credits === null ? null : <UsageHistory />}

      {error === null ? null : (
        <p role="alert" className="m-0 text-xs text-danger">
          {error}
        </p>
      )}
    </section>
  )
}

/** E2: the words of line editing the balance still covers; nothing until measured. */
function WordsLeft({
  pricing,
  balanceMicros
}: {
  pricing: PricingResult
  balanceMicros: number
}): React.JSX.Element | null {
  const text = wordsLeftText(
    wordsCovered(pricing, balanceMicros, 'lineEdit'),
    WORD_COST_ACTIONS.lineEdit
  )
  return text === null ? null : (
    <p data-testid="account-words-left" className="m-0 text-xs text-fg-muted">
      {text}
    </p>
  )
}

/**
 * The usage meter (F-15.5): what the rolling period cost, how long the balance lasts at that
 * pace, and the one warning line when it is under the configured line (E6) or running out. The
 * period is a window, not a billing cycle — the balance is prepaid — so it says "the last 30
 * days" rather than "this month". `now` is when the store last had these numbers from the Worker,
 * not a clock read during render. The same pure functions drive the status-bar notice.
 */
function UsageMeter({
  credits,
  now,
  pricing
}: {
  credits: CreditsResult
  now: number
  pricing: PricingResult
}): React.JSX.Element {
  const spentMicros = periodSpentMicros(credits.periodSpend)
  const daysLeft = projectedDaysLeft({
    balanceMicros: credits.balanceMicros,
    spentMicros,
    firstChargeAt: credits.periodFirstChargeAt,
    now
  })
  const warning = creditWarning({
    balanceMicros: credits.balanceMicros,
    daysLeft,
    lowMicros: pricing.lowBalanceWarningMicros
  })
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
        <p role="status" data-testid="account-balance-warning" className="m-0 text-xs text-warning">
          {creditWarningText(warning, { balanceMicros: credits.balanceMicros, daysLeft })}
        </p>
      )}
    </div>
  )
}

/** What each feature spent in the period, in dollars and requests (no tokens, C4). */
function SpendTable({ credits }: { credits: CreditsResult }): React.JSX.Element {
  return (
    <>
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
  )
}

/**
 * The models MythScribe Cloud offers (C2: every model, one balance), each with what it costs
 * against the default model (E5, "about 2x") rather than a per-token rate (C4). Which model each
 * task uses is chosen in Settings › AI.
 */
function ModelsTable({ pricing }: { pricing: PricingResult }): React.JSX.Element {
  const defaults = new Set(Object.values(pricing.routing.tiers))
  return (
    <table aria-label="MythScribe Cloud models" className="w-full text-xs">
      <thead className="text-fg-muted">
        <tr>
          <th scope="col" className="text-left font-normal">
            Model
          </th>
          <th scope="col" className="text-right font-normal">
            Price
          </th>
        </tr>
      </thead>
      <tbody>
        {pricing.models.map((model) => {
          const multiplier = multiplierLabel(pricing, model.id)
          return (
            <tr key={model.id}>
              <th scope="row" className="text-left font-normal">
                {model.label}
                {defaults.has(model.id) ? <span className="text-fg-muted"> (default)</span> : null}
              </th>
              <td className="text-right" data-testid={`account-model-price-${model.id}`}>
                {multiplier === null ? 'Standard' : `${multiplier} the standard price`}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/**
 * The usage history (E7) from the Worker's ledger: date, action, model, tokens, and amount, for
 * every top-up, charge, and refund. Closed by default — the one place hosted users see token
 * counts (C4) — and loaded the first time it is opened; "Show more" pages back.
 */
function UsageHistory(): React.JSX.Element {
  const usage = useAccountStore((s) => s.usage)
  const cursor = useAccountStore((s) => s.usageCursor)
  const busy = useAccountStore((s) => s.usageBusy)
  const error = useAccountStore((s) => s.usageError)
  const loadUsage = useAccountStore((s) => s.loadUsage)
  const [open, setOpen] = useState(false)

  return (
    <details
      data-testid="account-usage-history"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open
        setOpen(next)
        if (next && usage === null && !busy) void loadUsage()
      }}
    >
      <summary className="cursor-pointer text-xs">Usage history</summary>
      {usage === null ? null : usage.length === 0 ? (
        <p className="m-0 text-xs text-fg-muted">Nothing yet.</p>
      ) : (
        <table aria-label="Usage history" className="mt-1 w-full text-xs">
          <thead className="text-fg-muted">
            <tr>
              <th scope="col" className="text-left font-normal">
                Date
              </th>
              <th scope="col" className="text-left font-normal">
                Action
              </th>
              <th scope="col" className="text-left font-normal">
                Model
              </th>
              <th scope="col" className="text-right font-normal">
                Tokens in / out
              </th>
              <th scope="col" className="text-right font-normal">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {usage.map((entry) => (
              <tr key={entry.id}>
                <td className="text-left tabular-nums">{entryDate(entry.at)}</td>
                <td className="text-left">{entryAction(entry)}</td>
                <td className="text-left">{entry.model ?? '—'}</td>
                <td className="text-right tabular-nums">
                  {entry.tokensIn === null
                    ? '—'
                    : `${formatCount(entry.tokensIn)} / ${formatCount(entry.tokensOut ?? 0)}`}
                </td>
                <td className="text-right tabular-nums">{signedUsd(entry.amountMicros)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {cursor === null ? null : (
        <button
          type="button"
          disabled={busy}
          onClick={() => void loadUsage(true)}
          className={`${BUTTON} mt-1`}
        >
          Show more
        </button>
      )}
      {error === null ? null : (
        <p role="alert" className="m-0 text-xs text-danger">
          {error}
        </p>
      )}
    </details>
  )
}
