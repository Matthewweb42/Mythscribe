import { useEffect, useState } from 'react'
import { useDiagnosticsStore } from './diagnosticsStore'

const BUTTON =
  'shrink-0 rounded-md border border-line px-2 py-1 text-sm hover:bg-surface disabled:opacity-50 disabled:hover:bg-transparent'

/** The promise the tab makes before it asks for anything: off, and recording nothing until then. */
const INTRO =
  'Off unless you turn it on. Diagnostics tell us when MythScribe breaks and which parts of it ' +
  'get used, so the next version fixes the right things. While the switch is off nothing is ' +
  'recorded, so there is nothing to send.'

/** Exactly what leaves the machine, in the order it matters to someone deciding. */
const SENT = [
  'When something crashes: the kind of error, its message with every quoted phrase, file path, web address, and email address taken out, and the lines of the stack that are inside MythScribe itself.',
  'Counts: how many times a named action happened on a day — the app started, a project was created or opened, an export ran, focus mode was entered, an AI feature made a request, a proposal was accepted or rejected. Numbers only, never what the action was about.',
  'The build it came from: the MythScribe version, the Electron version it runs on, your operating system, and its processor type.'
]

/** The list that matters most; it is what the switch is really being asked about. */
const NEVER_SENT = [
  'Your manuscript, notes, tags, or any other text you wrote.',
  'The name of a project, folder, or document, or any path on your machine.',
  'Your account, your email address, or your API key.',
  'Anything that ties two reports together: there is no install id and nothing device-specific, so a report cannot be traced back to you or to another report.'
]

/** Why the preview is usually empty on the first day; it is not a bug to be explained twice. */
const TIMING =
  'Counts are sent one whole day at a time, so today’s counts leave after midnight. A crash ' +
  'report goes with the next send.'

/**
 * The Diagnostics tab of the Settings dialog (F-15.8): one switch, plain language about what is
 * and is not sent, and the next report verbatim. The preview is the exact JSON main would post —
 * read-only, never an edited summary — so "see exactly what would be sent" can be taken
 * literally. Turning the switch off throws away everything recorded so far, which is why this
 * tab never needs a "delete my data" button.
 */
export function DiagnosticsSettingsTab(): React.JSX.Element {
  const state = useDiagnosticsStore((s) => s.state)
  const busy = useDiagnosticsStore((s) => s.busy)
  const error = useDiagnosticsStore((s) => s.error)
  const load = useDiagnosticsStore((s) => s.load)
  const setEnabled = useDiagnosticsStore((s) => s.setEnabled)
  const [showPending, setShowPending] = useState(false)
  const lastSentDay = state?.lastSentDay ?? null

  // `App` subscribes once and keeps the state current; this only covers the tab being opened
  // before that first answer arrived.
  useEffect(() => {
    if (state === null) void load()
  }, [state, load])

  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="m-0 text-fg-muted">{INTRO}</p>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          data-testid="diagnostics-enabled"
          checked={state?.enabled ?? false}
          disabled={state === null || busy}
          onChange={(event) => void setEnabled(event.target.checked)}
        />
        <span>Send anonymous diagnostics</span>
      </label>

      <section aria-label="What is sent" className="flex flex-col gap-1">
        <h3 className="m-0 text-sm font-medium">What is sent</h3>
        <ul className="m-0 list-disc pl-5 text-xs text-fg-muted">
          {SENT.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      <section aria-label="What is never sent" className="flex flex-col gap-1">
        <h3 className="m-0 text-sm font-medium">What is never sent</h3>
        <ul className="m-0 list-disc pl-5 text-xs text-fg-muted">
          {NEVER_SENT.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      <p className="m-0 text-xs text-fg-muted">{TIMING}</p>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <span data-testid="diagnostics-last-sent" className="text-xs text-fg-muted">
            {lastSentDay === null
              ? 'Nothing has been sent from this machine.'
              : `Last sent: counts up to ${lastSentDay}.`}
          </span>
          <button
            type="button"
            aria-expanded={showPending}
            onClick={() => setShowPending(!showPending)}
            className={BUTTON}
          >
            See exactly what would be sent
          </button>
        </div>
        {showPending ? (
          <pre
            data-testid="diagnostics-pending"
            className="m-0 max-h-60 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-xs whitespace-pre-wrap"
          >
            {state?.pending ?? ''}
          </pre>
        ) : null}
      </div>

      {error === null ? null : (
        <p role="alert" className="m-0 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
