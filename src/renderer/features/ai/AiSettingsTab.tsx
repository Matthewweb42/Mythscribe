import { useEffect, useId, useState } from 'react'
import {
  AI_KEY_MAX,
  AI_MODEL_MAX,
  AI_PROVIDER_LABEL,
  DAILY_CAP_MAX,
  DAILY_CAP_MIN,
  DEFAULT_MODELS,
  TIER_USE,
  type AiModelMap,
  type AiStatus,
  type AiUsageSummary,
  type Tier
} from '@shared/ai'
import { isFeatureAllowed } from '@shared/aiSettings'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { AiDialSection } from './AiDialSection'
import { AuthorRulesSection } from './AuthorRulesSection'
import { ProvenanceSection } from './ProvenanceSection'
import { VoiceSection } from './VoiceSection'
import { WritingPresetsSection } from './WritingPresetsSection'
import { useAiSettingsStore } from './aiSettingsStore'
import { useAiStore } from './aiStore'
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

const NO_SAFE_STORAGE_COPY =
  'This system has no safe storage available, so MythScribe cannot store a key here. ' +
  'On Linux, install and unlock a keyring (GNOME Keyring or KWallet), then try again.'

const PLAIN_STORAGE_COPY =
  'No system keyring found: the key is stored obfuscated, not encrypted. ' +
  'Install a keyring (GNOME Keyring or KWallet) for real encryption.'

/** The storage claim follows the real backend: no "encrypted" under the plain-text warning. */
const privacyCopy = (encryption: 'os' | 'plain' | 'none' | undefined): string =>
  `Your key is ${encryption === 'plain' ? 'stored only on this machine' : 'encrypted and stored only on this machine'}, and is sent only to OpenAI when you use an AI feature.`

const report = (err: unknown): void => {
  toast.error(describeError(err))
}

const TIER_LABEL: Record<Tier, string> = { fast: 'Fast tier', strong: 'Strong tier' }

const atDefaults = (models: AiModelMap): boolean =>
  models.fast === DEFAULT_MODELS.fast && models.strong === DEFAULT_MODELS.strong

/**
 * The AI tab of the Settings dialog (F-5.1): the project's AI dial, toggles, and data-sharing
 * table first (F-14.4, loaded with the project by `App.tsx`), the writing presets (F-5.2,
 * loaded the same way), "Summarize all scenes" (F-5.13), the voice profile (F-14.1), the author rules (F-14.2), the provenance ledger (F-14.6), then the
 * provider, the key field with Save and Clear, the masked hint once a key is saved, the model
 * per tier with "Reset to defaults" (F-5.11),
 * "Test connection" with its result inline, the Usage block with the daily cap (F-5.14), the
 * privacy line, and a warning when the key can only be obfuscated (no keyring) or not stored
 * at all. The uncommitted key lives in local state and is dropped as soon as it is saved, so
 * it is never shown again; the store holds only what main answers (a mask, never the key).
 */
export function AiSettingsTab(): React.JSX.Element {
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

  useEffect(() => {
    load().catch(report)
    loadUsage().catch(report)
  }, [load, loadUsage])

  const trimmed = draft.trim()
  const hasKey = status?.hasKey ?? false
  const canStore = status !== null && status.encryption !== 'none'

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

  const models = status?.models ?? null
  const saveModel = (tier: Tier, model: string): Promise<void> =>
    run(async () => {
      if (models) await setModels({ ...models, [tier]: model })
    })

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

      <div className="flex items-center justify-between gap-3">
        <span>Provider</span>
        <span className="font-medium">{AI_PROVIDER_LABEL.openai}</span>
      </div>

      {status !== null && status.encryption === 'none' ? (
        <p role="alert" className="m-0 rounded-md border border-warning/40 px-3 py-2 text-warning">
          {NO_SAFE_STORAGE_COPY}
        </p>
      ) : (
        <form
          aria-label="OpenAI API key"
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
              placeholder="Paste your OpenAI API key"
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
        </form>
      )}

      {status?.encryption === 'plain' ? (
        <p role="alert" className="m-0 text-xs text-warning">
          {PLAIN_STORAGE_COPY}
        </p>
      ) : null}

      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
        <div className="flex items-center justify-between gap-3">
          <legend className="float-left p-0 font-medium">Models</legend>
          <button
            type="button"
            disabled={models === null || atDefaults(models) || busy}
            onClick={() => void run(() => setModels({ ...DEFAULT_MODELS }))}
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
            onCommit={(model) => saveModel(tier, model)}
          />
        ))}
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          disabled={!hasKey || testing || busy}
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
        onCommitCap={(usd) => run(() => setDailyCap(usd))}
      />

      <p className="m-0 text-xs text-fg-muted">{privacyCopy(status?.encryption)}</p>
    </div>
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
  onCommitCap
}: {
  usage: AiUsageSummary | null
  disabled: boolean
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
        <span data-testid="ai-usage-session">{describeTotals(usage.session)}</span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span>This project, all time</span>
        <span data-testid="ai-usage-total">{describeTotals(usage.total)}</span>
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
              <th scope="col" className="text-right font-normal">
                Tokens
              </th>
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
                <td className="text-right tabular-nums">{formatCount(row.tokens)}</td>
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
              <th scope="col" className="text-right font-normal">
                Tokens
              </th>
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
                <td className="text-right tabular-nums">
                  {`${formatCount(row.promptTokens)} / ${formatCount(row.completionTokens)}`}
                </td>
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
 * a write, and a refused one shows the saved value again once the toast is up.
 */
function ModelField({
  tier,
  value,
  disabled,
  onCommit
}: {
  tier: Tier
  value: string
  disabled: boolean
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
    </div>
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
