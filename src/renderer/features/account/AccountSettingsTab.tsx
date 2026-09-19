import { useEffect, useState } from 'react'
import { EMAIL_MAX } from '@shared/cloudApi'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useAccountStore } from './accountStore'

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

/**
 * The Account tab of the Settings dialog (F-15.2). Three states, one at a time, from the store
 * main owns: signed out (an email address and "Send sign-in link"), pending (the link was
 * emailed and main is polling; this window signs itself in when the link is opened anywhere,
 * so there is nothing to paste back), and signed in. Failures show inline under the controls
 * because the author is looking at them, not at a toast. Nothing here gates any other feature.
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
