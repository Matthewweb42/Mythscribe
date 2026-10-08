import { useEffect, useId, useState } from 'react'
import {
  AI_KEY_MAX,
  AI_MODEL_MAX,
  AI_PROVIDER_LABEL,
  OWN_KEY_PROVIDERS,
  USAGE_HISTORY_PAGE,
  DAILY_CAP_MAX,
  DAILY_CAP_MIN,
  LOCAL_AI_BASE_URL_MAX,
  LocalAiBaseUrl,
  REASONING_LABEL,
  REASONING_MODES,
  ReasoningMode,
  TIER_USE,
  bundledReasoning,
  defaultModelsFor,
  isLoopbackUrl,
  type AiModelMap,
  type AiProviderId,
  type AiStatus,
  type AiUsageHistory,
  type AiUsageRecent,
  type AiUsageSummary,
  type OwnKeyProvider,
  type Tier
} from '@shared/ai'
import {
  ROUTABLE_FEATURES,
  ROUTE_CHOICE_LABEL,
  autoTable,
  hostedAutoTable,
  type AiModelChoice
} from '@shared/aiRouting'
import {
  AI_SOURCE_LABEL,
  AI_SOURCE_MEANING,
  AiSource,
  CLOUD_COMING_SOON,
  CLOUD_UNAVAILABLE_NOTICE,
  LOCAL_QUALITY_WARNING,
  isFeatureAllowed
} from '@shared/aiSettings'
import { CLOUD_AI_AVAILABLE, type PricingResult } from '@shared/cloudApi'
import { bundledPricing, hostedModel, hostedModelFor, multiplierLabel } from '@shared/hostedPricing'
import { useAccountStore } from '@renderer/features/account/accountStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { AiDialSection } from './AiDialSection'
import { AuthorRulesSection } from './AuthorRulesSection'
import { ProvenanceSection } from './ProvenanceSection'
import { VoiceSection } from './VoiceSection'
import { WritingPresetsSection } from './WritingPresetsSection'
import { useAiSettingsStore } from './aiSettingsStore'
import { ownKeyOf, providerOf, useAiStore } from './aiStore'
import { useIndexingStore } from './indexingStore'
import {
  describeTotals,
  featureLabel,
  formatCount,
  formatRequestCost,
  formatUsd
} from './usageFormat'

const FIELD = 'min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 text-sm'
const BUTTON =
  'shrink-0 rounded-md border border-line px-2 py-1 text-sm hover:bg-surface disabled:opacity-50 disabled:hover:bg-transparent'

/**
 * AI-BILLING-SPEC S2 (decided 2026-10-07): keys live only in the OS keychain, so without one
 * (no safe storage, or Linux's plain-text fallback) the key field is closed, with how to fix it.
 */
const NO_KEYCHAIN_COPY =
  'MythScribe keeps API keys only in your system keychain, and none is available here. ' +
  'On Linux, install and unlock GNOME Keyring or KWallet (for example: sudo apt install ' +
  'gnome-keyring), sign out and back in, then save the key. Until then, use MythScribe Cloud ' +
  'or a local model.'

/** Where each own-key provider's keys are made; shown under the key field. */
const KEY_HELP: Record<OwnKeyProvider, string> = {
  openrouter: 'One OpenRouter key reaches every model. Create one at openrouter.ai/keys.',
  openai: 'Create a key at platform.openai.com/api-keys.'
}

/**
 * The storage claim follows the real backend: no "encrypted" under the plain-text warning. On
 * MythScribe Cloud there is no key here at all, so the line names where the text goes instead.
 */
const privacyCopy = (source: AiSource, localUrl: string, ownKey: OwnKeyProvider): string =>
  source === 'local'
    ? isLoopbackUrl(localUrl)
      ? `Nothing leaves this computer: the text listed in the table above goes only to the model server at ${localUrl}.`
      : `The text listed in the table above goes to the model server at ${localUrl}, over your network.`
    : source === 'cloud'
      ? 'Your key stays out of it on MythScribe Cloud: the text listed in the table above goes ' +
        'to MythScribe Cloud, which relays it to the model and stores none of it.'
      : `Your key is kept in your system keychain on this machine, and is sent only to ${AI_PROVIDER_LABEL[ownKey]} when you use an AI feature.`

const RADIO =
  'flex min-w-0 flex-1 flex-col gap-0.5 rounded-md border border-line px-2 py-1.5 text-left hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent aria-checked:border-accent aria-checked:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent'

const report = (err: unknown): void => {
  toast.error(describeError(err))
}

const TIER_LABEL: Record<Tier, string> = { fast: 'Fast tier', strong: 'Strong tier' }

const atDefaults = (models: AiModelMap, provider: AiProviderId): boolean => {
  const defaults = defaultModelsFor(provider)
  return models.fast === defaults.fast && models.strong === defaults.strong
}

/**
 * The AI tab of the Settings dialog (F-5.1): the project's AI dial, toggles, and data-sharing
 * table first (F-14.4, loaded with the project by `App.tsx`), the writing presets (F-5.2,
 * loaded the same way), "Summarize all scenes" (F-5.13), the voice profile (F-14.1), the author rules (F-14.2), the provenance ledger (F-14.6), then the
 * provider, the key field with Save and Clear, the masked hint once a key is saved, the model
 * per tier with "Reset to defaults" (F-5.11) and, on MythScribe Cloud, its rate (F-15.11), the
 * local server's address and quality warning when the source is a local model (F-5.15),
 * "Test connection" with its result inline, the Usage block with the daily cap (F-5.14), the
 * privacy line, and a warning when the key can only be obfuscated (no keyring) or not stored
 * at all. While Cloud does not serve AI yet (`CLOUD_AI_AVAILABLE`, decided by the author
 * 2026-10-07) its source option is disabled with "Coming soon", and a project still stored on
 * Cloud gets a notice to choose another source; the stored source is never rewritten here.
 * The uncommitted key lives in local state and is dropped as soon as it is saved, so
 * it is never shown again; the store holds only what main answers (a mask, never the key).
 */
export function AiSettingsTab({
  cloudAvailable = CLOUD_AI_AVAILABLE
}: {
  /** Whether the Cloud source can be chosen; the shared flag unless a test says otherwise. */
  cloudAvailable?: boolean
} = {}): React.JSX.Element {
  const status = useAiStore((s) => s.status)
  const testResult = useAiStore((s) => s.testResult)
  const testing = useAiStore((s) => s.testing)
  const load = useAiStore((s) => s.load)
  const setKey = useAiStore((s) => s.setKey)
  const clearKey = useAiStore((s) => s.clearKey)
  const setModels = useAiStore((s) => s.setModels)
  const test = useAiStore((s) => s.test)
  const usage = useAiStore((s) => s.usage)
  const loadUsage = useAiStore((s) => s.loadUsage)
  const setDailyCap = useAiStore((s) => s.setDailyCap)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  // F-5.13: "Summarize all scenes" is only offered when the dial and the toggle allow summaries.
  const summariesAllowed = useAiSettingsStore((s) =>
    s.settings === null ? false : isFeatureAllowed(s.settings, 'summary')
  )
  const indexAll = useIndexingStore((s) => s.indexAll)
  // F-15.4: where this project's requests go; the new-project wizard sets the first value
  // (F-15.11) and this picker switches it any time.
  const settings = useAiSettingsStore((s) => s.settings)
  const updateSettings = useAiSettingsStore((s) => s.update)
  const account = useAccountStore((s) => s.status)
  const source: AiSource = settings?.source ?? 'ownKey'
  const provider = providerOf(status, source)
  const ownKey = ownKeyOf(status)
  const setOwnKeyProvider = useAiStore((s) => s.setOwnKeyProvider)
  const loadChoice = useAiStore((s) => s.loadChoice)
  const choice = useAiStore((s) => s.choice)
  const signedIn = account?.state === 'signedIn'

  useEffect(() => {
    load().catch(report)
    loadUsage().catch(report)
    loadChoice().catch(report)
  }, [load, loadUsage, loadChoice])

  const trimmed = draft.trim()
  const hasKey = status?.hasKey ?? false
  // S2: a key is stored only in the OS keychain (`os`); the plain-text fallback is refused.
  const canStore = status !== null && (status.canStoreKey ?? status.encryption === 'os')

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } catch (err) {
      report(err)
    } finally {
      setBusy(false)
    }
  }

  const save = (): Promise<void> =>
    run(async () => {
      await setKey(trimmed)
      setDraft('')
    })

  const models = status?.models[provider] ?? null
  const saveModel = (tier: Tier, model: string): Promise<void> =>
    run(async () => {
      if (models) await setModels(provider, { ...models, [tier]: model })
    })
  const canTest =
    source === 'cloud' ? cloudAvailable && signedIn : source === 'local' ? status !== null : hasKey
  const localUrl = status?.local.baseUrl ?? ''

  return (
    <div className="flex flex-col gap-4 text-sm">
      <AiDialSection />

      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-fg-muted">
          Summarise every scene that has no summary yet or whose summary is out of date. They are
          indexed in the background, one at a time; the header shows the progress.
        </span>
        <button
          type="button"
          data-testid="summarize-all"
          disabled={!summariesAllowed || busy}
          onClick={() => void indexAll()}
          className={BUTTON}
        >
          Summarize all scenes
        </button>
      </div>

      <WritingPresetsSection />

      <VoiceSection />

      <AuthorRulesSection />

      <ProvenanceSection />

      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-fg-muted">AI source</span>
        <div role="radiogroup" aria-label="AI source" className="flex gap-2">
          {AiSource.options.map((option) => {
            const comingSoon = option === 'cloud' && !cloudAvailable
            return (
              <button
                key={option}
                type="button"
                role="radio"
                data-testid={`ai-source-${option}`}
                aria-checked={option === source}
                disabled={settings === null || busy || comingSoon}
                onClick={() => updateSettings({ source: option })}
                className={RADIO}
              >
                <span className="text-sm font-medium">
                  {AI_SOURCE_LABEL[option]}
                  {comingSoon ? (
                    <span
                      data-testid="ai-source-cloud-coming-soon"
                      className="ml-1.5 text-xs font-normal text-fg-muted"
                    >
                      {CLOUD_COMING_SOON}
                    </span>
                  ) : null}
                </span>
                <span className="text-xs text-fg-muted">{AI_SOURCE_MEANING[option]}</span>
              </button>
            )
          })}
        </div>
      </div>

      {source === 'cloud' && !cloudAvailable ? (
        <p
          role="alert"
          data-testid="ai-cloud-unavailable"
          className="m-0 rounded-md border border-warning/40 px-3 py-2 text-warning"
        >
          {CLOUD_UNAVAILABLE_NOTICE}
        </p>
      ) : source === 'cloud' ? (
        <CloudAccountLine signedIn={signedIn} email={signedIn ? account.email : null} />
      ) : source === 'local' ? (
        <LocalEndpointForm key={localUrl} current={localUrl} disabled={status === null || busy} />
      ) : (
        <>
          <OwnKeyProviderPicker
            value={ownKey}
            disabled={status === null || busy}
            onChange={(next) => void run(() => setOwnKeyProvider(next))}
          />
          {status !== null && !canStore ? (
            <p
              role="alert"
              data-testid="ai-no-keychain"
              className="m-0 rounded-md border border-warning/40 px-3 py-2 text-warning"
            >
              {NO_KEYCHAIN_COPY}
            </p>
          ) : null}
          <form
            aria-label={`${AI_PROVIDER_LABEL[ownKey]} API key`}
            onSubmit={(event) => {
              event.preventDefault()
              if (trimmed.length > 0 && canStore) void save()
            }}
            className="flex flex-col gap-1.5"
          >
            <div className="flex items-center gap-2">
              <input
                type="password"
                aria-label="API key"
                placeholder={`Paste your ${AI_PROVIDER_LABEL[ownKey]} API key`}
                autoComplete="off"
                spellCheck={false}
                maxLength={AI_KEY_MAX}
                value={draft}
                disabled={!canStore || busy}
                onChange={(event) => setDraft(event.target.value)}
                className={FIELD}
              />
              <button
                type="submit"
                disabled={trimmed.length === 0 || !canStore || busy}
                className={BUTTON}
              >
                Save
              </button>
              <button
                type="button"
                disabled={!hasKey || busy}
                onClick={() => void run(clearKey)}
                className={BUTTON}
              >
                Clear
              </button>
            </div>
            <KeyHint status={status} />
            <p className="m-0 text-xs text-fg-muted">{KEY_HELP[ownKey]}</p>
          </form>
        </>
      )}

      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
        <div className="flex items-center justify-between gap-3">
          <legend className="float-left p-0 font-medium">Models</legend>
          <button
            type="button"
            disabled={models === null || atDefaults(models, provider) || busy}
            onClick={() => void run(() => setModels(provider, defaultModelsFor(provider)))}
            className={BUTTON}
          >
            Reset to defaults
          </button>
        </div>
        {(['fast', 'strong'] as const).map((tier) => (
          <ModelField
            key={tier}
            tier={tier}
            value={models?.[tier] ?? ''}
            disabled={models === null || busy}
            showCloudRate={source === 'cloud' && models !== null}
            pricing={choice?.cloudPricing ?? null}
            onCommit={(model) => saveModel(tier, model)}
          />
        ))}
      </fieldset>

      <ModelChoiceSection choice={choice} source={source} models={models} disabled={busy} />

      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          disabled={!canTest || testing || busy}
          onClick={() => void run(test)}
          className={`${BUTTON} self-start`}
        >
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        {testResult !== null ? (
          <p
            role="status"
            data-testid="ai-test-result"
            className={`m-0 text-xs ${testResult.ok ? 'text-success' : 'text-danger'}`}
          >
            {testResult.ok
              ? `Connected. ${testResult.model} answered.`
              : `${testResult.message} ${testResult.nextStep}`}
          </p>
        ) : null}
      </div>

      <UsageBlock
        usage={usage}
        disabled={busy}
        showTokens={source !== 'cloud'}
        onCommitCap={(usd) => run(() => setDailyCap(usd))}
      />

      <UsageHistory />

      <p className="m-0 text-xs text-fg-muted">{privacyCopy(source, localUrl, ownKey)}</p>
    </div>
  )
}

/**
 * The local model server (F-5.15): its address with Save, the quality warning, and a warning
 * when the address is not on this computer. Keyed on the stored address, so a save resets the
 * draft to what main kept (it drops a trailing slash).
 */
function LocalEndpointForm({
  current,
  disabled
}: {
  current: string
  disabled: boolean
}): React.JSX.Element {
  const setLocalEndpoint = useAiStore((s) => s.setLocalEndpoint)
  const [draft, setDraft] = useState(current)
  const trimmed = draft.trim()
  const valid = LocalAiBaseUrl.safeParse(trimmed).success
  return (
    <form
      aria-label="Local model server"
      onSubmit={(event) => {
        event.preventDefault()
        if (valid && trimmed !== current) setLocalEndpoint(trimmed).catch(report)
      }}
      className="flex flex-col gap-1.5"
    >
      <div className="flex items-center gap-2">
        <input
          type="url"
          aria-label="Server address"
          placeholder="http://localhost:11434/v1"
          spellCheck={false}
          maxLength={LOCAL_AI_BASE_URL_MAX}
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          className={FIELD}
        />
        <button
          type="submit"
          disabled={disabled || !valid || trimmed === current}
          className={BUTTON}
        >
          Save
        </button>
      </div>
      <p className="m-0 text-xs text-fg-muted">
        Ollama answers at http://localhost:11434/v1 and LM Studio at http://localhost:1234/v1. Set
        the model names below to models you have downloaded.
      </p>
      <p role="note" data-testid="ai-local-warning" className="m-0 text-xs text-warning">
        {LOCAL_QUALITY_WARNING}
      </p>
      {current !== '' && !isLoopbackUrl(current) ? (
        <p role="alert" className="m-0 text-xs text-warning">
          This address is not on this computer, so your text leaves the machine.
        </p>
      ) : null}
    </form>
  )
}

/**
 * Who the Cloud requests are charged to (F-15.4), in one line: the account this machine is
 * signed in to, or what to do about it. The Account tab owns signing in; this only reports.
 */
function CloudAccountLine({
  signedIn,
  email
}: {
  signedIn: boolean
  email: string | null
}): React.JSX.Element {
  return (
    <p role="status" data-testid="ai-cloud-account" className="m-0 text-xs text-fg-muted">
      {signedIn && email !== null
        ? `Signed in as ${email}. Manage your balance on the Account tab.`
        : 'Not signed in. Sign in on the Account tab to use MythScribe Cloud.'}
    </p>
  )
}

/** The local clock time of a ledger row's ISO timestamp, the Recent requests Time column. */
const clockTime = (iso: string): string => {
  const at = new Date(iso)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/**
 * The Usage block (F-5.14, extended by F-5.9): today's spend across every project (the day and
 * the cap are app-wide), this run of the app across every project, this project's ledger since
 * it was created with a per-feature breakdown and the newest requests one by one, and the daily
 * cap field. Nothing renders until the summary has loaded.
 */
function UsageBlock({
  usage,
  disabled,
  showTokens,
  onCommitCap
}: {
  usage: AiUsageSummary | null
  disabled: boolean
  /** AI-BILLING-SPEC C4: false on MythScribe Cloud, where tokens stay in the usage history. */
  showTokens: boolean
  onCommitCap: (usd: number) => Promise<void>
}): React.JSX.Element | null {
  if (usage === null) return null
  return (
    <fieldset data-testid="ai-usage" className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend className="float-left p-0 font-medium">Usage</legend>
      <div className="flex items-center justify-between gap-3">
        <span>Spent today, all projects</span>
        <span data-testid="ai-usage-today" className="font-medium">
          {formatUsd(usage.today.costUsd)}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span>This session, all projects</span>
        <span data-testid="ai-usage-session">{describeTotals(usage.session, showTokens)}</span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span>This project, all time</span>
        <span data-testid="ai-usage-total">{describeTotals(usage.total, showTokens)}</span>
      </div>
      {usage.byFeature.length > 0 ? (
        <table aria-label="This project by feature" className="w-full text-xs">
          <thead className="text-fg-muted">
            <tr>
              <th scope="col" className="text-left font-normal">
                Feature
              </th>
              <th scope="col" className="text-right font-normal">
                Requests
              </th>
              {showTokens ? (
                <th scope="col" className="text-right font-normal">
                  Tokens
                </th>
              ) : null}
              <th scope="col" className="text-right font-normal">
                Cost
              </th>
            </tr>
          </thead>
          <tbody>
            {usage.byFeature.map((row) => (
              <tr key={row.feature}>
                <th scope="row" className="text-left font-normal">
                  {featureLabel(row.feature)}
                </th>
                <td className="text-right tabular-nums">{formatCount(row.requests)}</td>
                {showTokens ? (
                  <td className="text-right tabular-nums">{formatCount(row.tokens)}</td>
                ) : null}
                <td className="text-right tabular-nums">{formatUsd(row.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="m-0 text-xs text-fg-muted">No AI requests in this project yet.</p>
      )}
      {usage.recent.length > 0 ? (
        <table
          aria-label="Recent requests"
          data-testid="ai-usage-recent"
          className="w-full text-xs"
        >
          <thead className="text-fg-muted">
            <tr>
              <th scope="col" className="text-left font-normal">
                Time
              </th>
              <th scope="col" className="text-left font-normal">
                Feature
              </th>
              <th scope="col" className="text-left font-normal">
                Model
              </th>
              {showTokens ? (
                <th scope="col" className="text-right font-normal">
                  Tokens
                </th>
              ) : null}
              <th scope="col" className="text-right font-normal">
                Cost
              </th>
            </tr>
          </thead>
          <tbody>
            {usage.recent.map((row) => (
              <tr key={row.id}>
                <th scope="row" className="text-left font-normal tabular-nums">
                  {clockTime(row.at)}
                </th>
                <td className="text-left">{featureLabel(row.feature)}</td>
                <td className="text-left">{row.model}</td>
                {showTokens ? (
                  <td className="text-right tabular-nums">
                    {`${formatCount(row.promptTokens)} / ${formatCount(row.completionTokens)}`}
                  </td>
                ) : null}
                <td className="text-right tabular-nums">
                  {`${formatRequestCost(row.costUsd)}${row.cached ? ' · cached' : ''}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <DailyCapField value={usage.dailyCapUsd} disabled={disabled} onCommit={onCommitCap} />
    </fieldset>
  )
}

/**
 * The app-wide daily cap in USD, committed on blur or Enter like `ModelField`: a blank,
 * unparsable, or unchanged commit restores the saved value without a write; a refused one
 * shows the saved value again once the toast is up.
 */
function DailyCapField({
  value,
  disabled,
  onCommit
}: {
  value: number
  disabled: boolean
  onCommit: (usd: number) => Promise<void>
}): React.JSX.Element {
  const hintId = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(null)
  }

  const commit = (): void => {
    if (draft === null) return
    const text = draft.trim()
    const usd = Number(text)
    if (text === '' || !Number.isFinite(usd) || usd === value) {
      setDraft(null)
      return
    }
    void onCommit(usd).then(() => setDraft(null))
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-3">
        <span className="w-24 shrink-0">Daily cap (USD)</span>
        <input
          type="number"
          inputMode="decimal"
          min={DAILY_CAP_MIN}
          max={DAILY_CAP_MAX}
          step="0.5"
          aria-describedby={hintId}
          value={draft ?? value.toFixed(2)}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
            }
          }}
          className={FIELD}
        />
      </label>
      <p id={hintId} className="m-0 pl-27 text-xs text-fg-muted">
        Every project spends against this cap. A request that would go over it is refused until
        tomorrow; 0 pauses AI for the day.
      </p>
    </div>
  )
}

/**
 * One tier's model id, committed on blur or Enter (F-5.11). `draft` holds only text that is not
 * (yet) the saved value and is dropped when the value changes underneath (a save or a reset),
 * so the field always follows the store; a blank or unchanged commit restores the value without
 * a write, and a refused one shows the saved value again once the toast is up. On MythScribe
 * Cloud the saved model's rate sits under it (F-15.11), so the author sees what a tier costs
 * before choosing it; a model outside the rate table cannot be billed, and the line says so.
 */
function ModelField({
  tier,
  value,
  disabled,
  showCloudRate,
  pricing,
  onCommit
}: {
  tier: Tier
  value: string
  disabled: boolean
  showCloudRate: boolean
  /** The server's table (`GET /pricing`), or null until one was fetched. */
  pricing: PricingResult | null
  onCommit: (model: string) => Promise<void>
}): React.JSX.Element {
  const hintId = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(null)
  }

  const commit = (): void => {
    if (draft === null) return
    const text = draft.trim()
    if (text === '' || text === value) {
      setDraft(null)
      return
    }
    void onCommit(text).then(() => setDraft(null))
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-3">
        <span className="w-24 shrink-0">{TIER_LABEL[tier]}</span>
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={AI_MODEL_MAX}
          aria-describedby={hintId}
          value={draft ?? value}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
            }
          }}
          className={FIELD}
        />
      </label>
      <p id={hintId} className="m-0 pl-27 text-xs text-fg-muted">
        {TIER_USE[tier]}
      </p>
      {showCloudRate ? <CloudRateLine tier={tier} model={value} pricing={pricing} /> : null}
    </div>
  )
}

/**
 * What one tier's saved model costs on MythScribe Cloud, without tokens (AI-BILLING-SPEC C4,
 * E5): a model the server marks with a multiplier says "about 2x the default"; the server's
 * table (`GET /pricing`) wins, and its bundled defaults (`bundledPricing`) stand in until then.
 */
function CloudRateLine({
  tier,
  model,
  pricing
}: {
  tier: Tier
  model: string
  pricing: PricingResult | null
}): React.JSX.Element {
  const table = pricing ?? bundledPricing()
  // A tier left at a default goes out as the server's routing model, so that is the one priced.
  const sent = hostedModelFor(tier, model, table)
  const priced = hostedModel(table, sent) !== undefined
  const multiplier = multiplierLabel(table, sent)
  return priced ? (
    <p data-testid={`ai-model-rate-${tier}`} className="m-0 pl-27 text-xs text-fg-muted">
      {multiplier === null
        ? 'Paid from your MythScribe Cloud balance at the published price.'
        : `Paid from your MythScribe Cloud balance: ${multiplier} the default model\u2019s price.`}
    </p>
  ) : (
    <p
      role="alert"
      data-testid={`ai-model-rate-${tier}`}
      className="m-0 pl-27 text-xs text-warning"
    >
      MythScribe Cloud does not offer this model and will not answer with it. Pick one from the
      models on the Account tab.
    </p>
  )
}

/** "No key" until one is saved, then the mask main answers with; nothing while status is loading. */
function KeyHint({ status }: { status: AiStatus | null }): React.JSX.Element | null {
  if (status === null) return null
  return (
    <p data-testid="ai-key-hint" className="m-0 text-xs text-fg-muted">
      {status.hasKey && status.hint !== null ? (
        <>
          Key saved: <code className="font-mono">{status.hint}</code>
        </>
      ) : (
        'No key'
      )}
    </p>
  )
}

/**
 * Which provider an own key is for (2026-10-07, AI-BILLING-SPEC A2): OpenRouter (the default:
 * one key, every model) or OpenAI directly. Each keeps its own key and its own models.
 */
function OwnKeyProviderPicker({
  value,
  disabled,
  onChange
}: {
  value: OwnKeyProvider
  disabled: boolean
  onChange: (provider: OwnKeyProvider) => void
}): React.JSX.Element {
  return (
    <div role="radiogroup" aria-label="Key provider" className="flex gap-2">
      {OWN_KEY_PROVIDERS.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          data-testid={`own-key-provider-${option}`}
          aria-checked={option === value}
          disabled={disabled}
          onClick={() => {
            if (option !== value) onChange(option)
          }}
          className={RADIO}
        >
          <span className="text-sm font-medium">{AI_PROVIDER_LABEL[option]}</span>
          <span className="text-xs text-fg-muted">
            {option === 'openrouter'
              ? 'One key for every model (recommended).'
              : 'A key from OpenAI, for OpenAI models only.'}
          </span>
        </button>
      ))}
    </div>
  )
}

type RouteValue = 'auto' | Tier

const SELECT = 'min-w-0 rounded-md border border-line bg-bg px-2 py-1 text-sm'

/**
 * Model choice (AI-BILLING-SPEC M8, R4): Auto routes each task to the fast or the strong model
 * by a table (the server's on MythScribe Cloud); the author can put every task on one model, or
 * override single tasks, which wins over both. App-wide, like the models themselves.
 */
function ModelChoiceSection({
  choice,
  source,
  models,
  disabled
}: {
  choice: AiModelChoice | null
  source: AiSource
  models: AiModelMap | null
  disabled: boolean
}): React.JSX.Element | null {
  const setRouting = useAiStore((s) => s.setRouting)
  const hintId = useId()
  if (choice === null) return null
  const { routing } = choice
  const table = autoTable(source === 'cloud' ? hostedAutoTable(choice.cloudPricing) : null)
  const named = (tier: Tier): string =>
    models === null ? ROUTE_CHOICE_LABEL[tier] : `${ROUTE_CHOICE_LABEL[tier]} (${models[tier]})`
  const save = (next: typeof routing): void => {
    setRouting(next).catch(report)
  }
  const setAll = (value: RouteValue): void =>
    save({ ...routing, all: value === 'auto' ? null : value })
  const setFeature = (feature: (typeof ROUTABLE_FEATURES)[number], value: RouteValue): void => {
    const { [feature]: _dropped, ...rest } = routing.features
    save({ ...routing, features: value === 'auto' ? rest : { ...rest, [feature]: value } })
  }
  const autoLabel = (feature: (typeof ROUTABLE_FEATURES)[number]): string => {
    const tier = routing.all ?? table[feature]
    return tier === undefined
      ? `${ROUTE_CHOICE_LABEL.auto} (depends on the request)`
      : `${ROUTE_CHOICE_LABEL.auto} (${ROUTE_CHOICE_LABEL[tier].toLowerCase()})`
  }
  return (
    <fieldset
      data-testid="ai-model-choice"
      className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0"
    >
      <legend className="float-left p-0 font-medium">Which model each task uses</legend>
      <label className="flex items-center gap-3">
        <span className="w-24 shrink-0">All tasks</span>
        <select
          aria-describedby={hintId}
          value={routing.all ?? 'auto'}
          disabled={disabled}
          onChange={(event) => setAll(event.target.value as RouteValue)}
          className={SELECT}
        >
          <option value="auto">{`${ROUTE_CHOICE_LABEL.auto}: by task`}</option>
          <option value="fast">{named('fast')}</option>
          <option value="strong">{named('strong')}</option>
        </select>
      </label>
      <p id={hintId} className="m-0 pl-27 text-xs text-fg-muted">
        Auto sends small jobs (tags, summaries, proofreading) to the fast model and judgement jobs
        (questions, critique, the beta reader) to the strong one. A choice for one task below wins
        over this.
      </p>
      <details>
        <summary className="cursor-pointer text-xs text-fg-muted">Choose per task</summary>
        <table aria-label="Model per task" className="mt-1 w-full text-xs">
          <tbody>
            {ROUTABLE_FEATURES.map((feature) => (
              <tr key={feature}>
                <th scope="row" className="py-0.5 pr-2 text-left font-normal">
                  {featureLabel(feature)}
                </th>
                <td className="py-0.5 text-right">
                  <select
                    aria-label={`Model for ${featureLabel(feature)}`}
                    value={routing.features[feature] ?? 'auto'}
                    disabled={disabled}
                    onChange={(event) => setFeature(feature, event.target.value as RouteValue)}
                    className={SELECT}
                  >
                    <option value="auto">{autoLabel(feature)}</option>
                    <option value="fast">{ROUTE_CHOICE_LABEL.fast}</option>
                    <option value="strong">{ROUTE_CHOICE_LABEL.strong}</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      {source === 'cloud' ? null : (
        <ReasoningChoice routing={routing} models={models} disabled={disabled} onSave={save} />
      )}
    </fieldset>
  )
}

/**
 * How much each model may think before it answers (2026-10-07, "measure, then decide"): the
 * built-in table's mode per model (`bundledReasoning`, the model's default unless the table says
 * otherwise) or the author's choice per tier. Sent to OpenRouter only; MythScribe Cloud decides
 * on its server, so the choice is not offered there.
 */
function ReasoningChoice({
  routing,
  models,
  disabled,
  onSave
}: {
  routing: AiModelChoice['routing']
  models: AiModelMap | null
  disabled: boolean
  onSave: (next: AiModelChoice['routing']) => void
}): React.JSX.Element {
  const setTier = (tier: Tier, value: string): void => {
    const { [tier]: _dropped, ...rest } = routing.reasoning
    const parsed = ReasoningMode.safeParse(value)
    onSave({ ...routing, reasoning: parsed.success ? { ...rest, [tier]: parsed.data } : rest })
  }
  return (
    <details data-testid="ai-reasoning-choice">
      <summary className="cursor-pointer text-xs text-fg-muted">Thinking (OpenRouter)</summary>
      <p className="m-0 mt-1 text-xs text-fg-muted">
        Some models think before they write, which is slower and counts against each reply&apos;s
        length. Off asks the model not to; Low asks it to think briefly.
      </p>
      {(['fast', 'strong'] as const).map((tier) => (
        <label key={tier} className="mt-1 flex items-center gap-3 text-xs">
          <span className="w-24 shrink-0">{ROUTE_CHOICE_LABEL[tier]}</span>
          <select
            aria-label={`Thinking for the ${tier} model`}
            value={routing.reasoning[tier] ?? 'table'}
            disabled={disabled}
            onChange={(event) => setTier(tier, event.target.value)}
            className={SELECT}
          >
            <option value="table">
              {`Built-in (${REASONING_LABEL[models === null ? 'default' : bundledReasoning(models[tier])].toLowerCase()})`}
            </option>
            {REASONING_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {REASONING_LABEL[mode]}
              </option>
            ))}
          </select>
        </label>
      ))}
    </details>
  )
}

/** A ledger row's local date and time, `YYYY-MM-DD HH:MM`, the history's Date column. */
const dateTime = (iso: string): string => {
  const at = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clockTime(iso)}`
}

/** In / out tokens of one row, with the prompt-cache hits when the provider reported any. */
const rowTokens = (row: AiUsageRecent): string =>
  `${formatCount(row.promptTokens)} / ${formatCount(row.completionTokens)}${row.cachedTokens ? ` (${formatCount(row.cachedTokens)} cached)` : ''}`

/**
 * The usage history (AI-BILLING-SPEC E7): every request this project made, whatever the source,
 * newest first, a page at a time: date, action, model, tokens, and cost. Tokens are shown here
 * for every source; this is the usage view C4 allows them in. Loaded only when opened.
 */
function UsageHistory(): React.JSX.Element {
  const history = useAiStore((s) => s.history)
  const offset = useAiStore((s) => s.historyOffset)
  const loadHistory = useAiStore((s) => s.loadHistory)
  const [open, setOpen] = useState(false)
  const show = (at: number): void => {
    loadHistory(at).catch(report)
  }
  const toggle = (): void => {
    if (!open) show(0)
    setOpen(!open)
  }
  const page: AiUsageHistory | null = open ? history : null
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        data-testid="ai-usage-history-toggle"
        onClick={toggle}
        className={`${BUTTON} self-start`}
      >
        {open ? 'Hide usage history' : 'Show usage history'}
      </button>
      {page === null ? null : page.total === 0 ? (
        <p className="m-0 text-xs text-fg-muted">No AI requests in this project yet.</p>
      ) : (
        <>
          <table
            aria-label="Usage history"
            data-testid="ai-usage-history"
            className="w-full text-xs"
          >
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
                  Cost
                </th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row) => (
                <tr key={row.id}>
                  <th scope="row" className="text-left font-normal tabular-nums">
                    {dateTime(row.at)}
                  </th>
                  <td className="text-left">{featureLabel(row.feature)}</td>
                  <td className="text-left">{row.model}</td>
                  <td className="text-right tabular-nums">{rowTokens(row)}</td>
                  <td className="text-right tabular-nums">
                    {`${formatRequestCost(row.costUsd)}${row.cached ? ' · cached' : ''}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between gap-3 text-xs text-fg-muted">
            <span data-testid="ai-usage-history-range">
              {`${formatCount(offset + 1)}\u2013${formatCount(offset + page.rows.length)} of ${formatCount(page.total)}`}
            </span>
            <span className="flex gap-2">
              <button
                type="button"
                disabled={offset === 0}
                onClick={() => show(Math.max(0, offset - USAGE_HISTORY_PAGE))}
                className={BUTTON}
              >
                Newer
              </button>
              <button
                type="button"
                disabled={offset + page.rows.length >= page.total}
                onClick={() => show(offset + USAGE_HISTORY_PAGE)}
                className={BUTTON}
              >
                Older
              </button>
            </span>
          </div>
        </>
      )}
    </div>
  )
}
