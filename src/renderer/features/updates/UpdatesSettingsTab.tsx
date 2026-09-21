import { useEffect } from 'react'
import {
  UPDATE_CHANNELS,
  UPDATE_CHANNEL_LABEL,
  UPDATE_CHANNEL_MEANING,
  type ReleaseNotes,
  type UpdateStatus
} from '@shared/updates'
import { useUpdateStore } from './updateStore'

const BUTTON =
  'shrink-0 rounded-md border border-line px-2 py-1 text-sm hover:bg-surface disabled:opacity-50 disabled:hover:bg-transparent'
const RADIO =
  'flex min-w-0 flex-1 flex-col gap-0.5 rounded-md border border-line px-2 py-1.5 text-left hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent aria-checked:border-accent aria-checked:bg-surface-raised'

/** What the automatic check contacts, in one sentence, next to the checkbox that turns it off. */
const AUTO_CHECK_NOTE =
  'MythScribe asks GitHub for the list of releases. It sends no manuscript text and no account ' +
  'details, and an update never installs itself while you are writing.'

const clockTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { timeStyle: 'short' })

/** The one line that says where the update stands; the error keeps its next step beside it. */
function statusText(status: UpdateStatus): string {
  switch (status.state) {
    case 'unsupported':
      return status.reason
    case 'idle':
      return 'No check yet.'
    case 'checking':
      return 'Checking for updates…'
    case 'upToDate':
      return `MythScribe is up to date (checked at ${clockTime(status.checkedAt)}).`
    case 'downloading':
      return `Downloading ${status.version}… ${status.percent}%`
    case 'ready':
      return `Version ${status.version} is ready to install.`
    case 'error':
      return `${status.message} ${status.nextStep}`
  }
}

/**
 * The Updates tab of the Settings dialog (F-15.7): the running version, where the update stands,
 * a manual check, the channel, and the automatic check. Downloads happen in the background and
 * nothing restarts the app on its own — "Restart and install" is the only way in, and it closes
 * the project first. A build that cannot update itself (a development build, a Linux package)
 * says so and hides the buttons; the channel stays, because it is a stored preference that the
 * released build will honour.
 */
export function UpdatesSettingsTab(): React.JSX.Element {
  const state = useUpdateStore((s) => s.state)
  const busy = useUpdateStore((s) => s.busy)
  const error = useUpdateStore((s) => s.error)
  const load = useUpdateStore((s) => s.load)
  const check = useUpdateStore((s) => s.check)
  const setChannel = useUpdateStore((s) => s.setChannel)
  const setAutoCheck = useUpdateStore((s) => s.setAutoCheck)
  const markSeen = useUpdateStore((s) => s.markSeen)
  const installNow = useUpdateStore((s) => s.installNow)

  // `App` subscribes once and keeps the state current; this only covers the tab being opened
  // before that first answer arrived.
  useEffect(() => {
    if (state === null) void load()
  }, [state, load])

  // Opening the tab is reading what is new: it is not offered again after this.
  const unseen = state?.unseenNotes ?? false
  useEffect(() => {
    if (unseen) void markSeen()
  }, [unseen, markSeen])

  const status = state?.status ?? null
  const supported = status !== null && status.state !== 'unsupported'
  const checking = status?.state === 'checking' || status?.state === 'downloading'
  const whatsNew =
    state !== null && state.installedNotes?.version === state.currentVersion
      ? state.installedNotes
      : null

  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span data-testid="update-version">
          {state === null ? 'MythScribe' : `MythScribe ${state.currentVersion}`}
        </span>
        {supported ? (
          <button
            type="button"
            disabled={busy || checking}
            onClick={() => void check()}
            className={BUTTON}
          >
            Check for updates
          </button>
        ) : null}
      </div>

      {status === null ? null : (
        <p
          role="status"
          data-testid="update-status"
          className={`m-0 text-xs ${status.state === 'error' ? 'text-danger' : 'text-fg-muted'}`}
        >
          {statusText(status)}
        </p>
      )}

      {status?.state === 'ready' ? (
        <section
          aria-label="Update ready"
          className="flex flex-col gap-2 border-t border-line pt-3"
        >
          <div className="flex items-center justify-between gap-3">
            <h3 className="m-0 text-sm font-medium">{`What's new in ${status.version}`}</h3>
            <button
              type="button"
              data-testid="update-install"
              disabled={busy}
              onClick={() => void installNow()}
              className={BUTTON}
            >
              Restart and install
            </button>
          </div>
          <ReleaseNotesView notes={status.notes} testId="update-ready-notes" />
        </section>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-fg-muted">Channel</span>
        <div role="radiogroup" aria-label="Update channel" className="flex gap-2">
          {UPDATE_CHANNELS.map((channel) => (
            <button
              key={channel}
              type="button"
              role="radio"
              data-testid={`update-channel-${channel}`}
              aria-checked={state !== null && channel === state.channel}
              disabled={state === null || busy}
              onClick={() => void setChannel(channel)}
              className={RADIO}
            >
              <span className="text-sm font-medium">{UPDATE_CHANNEL_LABEL[channel]}</span>
              <span className="text-xs text-fg-muted">{UPDATE_CHANNEL_MEANING[channel]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            data-testid="update-auto-check"
            checked={state?.autoCheck ?? true}
            disabled={state === null || busy}
            onChange={(event) => void setAutoCheck(event.target.checked)}
          />
          <span>Check for updates automatically</span>
        </label>
        <p className="m-0 text-xs text-fg-muted">{AUTO_CHECK_NOTE}</p>
      </div>

      {whatsNew === null ? null : (
        <section aria-label="What's new" className="flex flex-col gap-2 border-t border-line pt-3">
          <h3 className="m-0 text-sm font-medium">{`What's new in ${whatsNew.version}`}</h3>
          <ReleaseNotesView notes={whatsNew} testId="update-whats-new" />
        </section>
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
 * Release notes as text (F-15.7): the provider's HTML was turned into plain lines in
 * `@shared/updates`, and they are rendered as paragraphs with the `- ` lines gathered into a
 * list. Nothing here ever renders markup.
 */
function ReleaseNotesView({
  notes,
  testId
}: {
  notes: ReleaseNotes
  testId: string
}): React.JSX.Element {
  const blocks = notesBlocks(notes.text)
  if (blocks.length === 0) {
    return (
      <p data-testid={testId} className="m-0 text-xs text-fg-muted">
        No release notes for this version.
      </p>
    )
  }
  return (
    <div data-testid={testId} className="flex flex-col gap-1 text-xs">
      {blocks.map((block, index) =>
        block.kind === 'list' ? (
          <ul key={index} className="m-0 list-disc pl-5">
            {block.lines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        ) : (
          <p key={index} className="m-0">
            {block.lines.join(' ')}
          </p>
        )
      )}
    </div>
  )
}

interface NotesBlock {
  kind: 'list' | 'text'
  lines: string[]
}

/** Groups the plain-text notes into runs of `- ` lines (a list) and runs of prose. */
function notesBlocks(text: string): NotesBlock[] {
  const blocks: NotesBlock[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    const isItem = line.startsWith('- ')
    const kind = isItem ? 'list' : 'text'
    const last = blocks[blocks.length - 1]
    const content = isItem ? line.slice(2) : line
    if (last?.kind === kind) last.lines.push(content)
    else blocks.push({ kind, lines: [content] })
  }
  return blocks
}
