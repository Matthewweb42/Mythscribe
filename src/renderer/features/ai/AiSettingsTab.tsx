import { useEffect, useState } from 'react'
import { AI_KEY_MAX, AI_PROVIDER_LABEL, type AiStatus } from '@shared/ai'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useAiStore } from './aiStore'

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

/**
 * The AI tab of the Settings dialog (F-5.1): the provider, the key field with Save and Clear,
 * the masked hint once a key is saved, "Test connection" with its result inline, the privacy
 * line, and a warning when the key can only be obfuscated (no keyring) or not stored at all.
 * The uncommitted key lives in local state and is dropped as soon as it is saved, so it is
 * never shown again; the store holds only what main answers (a mask, never the key).
 */
export function AiSettingsTab(): React.JSX.Element {
  const status = useAiStore((s) => s.status)
  const testResult = useAiStore((s) => s.testResult)
  const testing = useAiStore((s) => s.testing)
  const load = useAiStore((s) => s.load)
  const setKey = useAiStore((s) => s.setKey)
  const clearKey = useAiStore((s) => s.clearKey)
  const test = useAiStore((s) => s.test)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    load().catch(report)
  }, [load])

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

  return (
    <div className="flex flex-col gap-4 text-sm">
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

      <p className="m-0 text-xs text-fg-muted">{privacyCopy(status?.encryption)}</p>
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
