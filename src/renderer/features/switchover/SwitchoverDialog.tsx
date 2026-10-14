import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { INLINE_TAG_REPLACEMENT_MAX, type SwitchoverItem } from '@shared/memory/switchover'
import { AI_WAIT_CLASS } from '@renderer/features/ai/aiWaitPhrases'
import { useBackupStore } from '@renderer/features/backups/backupStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { SwitchoverFailure } from './SwitchoverFailure'
import { mergeKey, useSwitchoverStore } from './switchoverStore'
import {
  THIS_IS_A_COPY,
  TRY_COPY_FIRST,
  WHAT_CHANGES,
  cloudLabel,
  countsLine,
  goBackLine,
  rebuildLine,
  safetyProgress
} from './switchoverText'

/**
 * The story-memory switch-over (F-16.15; F-16.31 part A, plan `Switchover.md` §3): the intro (what
 * changes; *Try it on a copy first*, recommended; *Switch this project…*; on a test copy only
 * *Switch this copy…*), the safety step's progress, the dry run (kept, converted and dropped, by
 * name; the merges to tick; the sheet text the AI wrote; what cannot convert; the rebuild's price
 * and time; on the project itself, where the backup and the dated copy are), the consent screen
 * (each inline tag's words, editable), then the final screen (what was written, the kept backup
 * with *Show backups*, the dated copy, how to go back; a test copy's names the project it was made
 * from and offers *Open my project*). A failed step shows its block (`SwitchoverFailure`) where it
 * failed. Escape or Cancel leaves the project as it is (still v1) until Convert.
 */
export function SwitchoverDialog(): React.JSX.Element | null {
  const phase = useSwitchoverStore((s) => s.phase)
  if (phase === 'idle') return null
  return <SwitchoverBody />
}

const BUTTON =
  'rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-60'
const PRIMARY =
  'rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50'

function Section({
  title,
  testId,
  children
}: {
  title: string
  testId: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <section aria-label={title} data-testid={testId} className="flex flex-col gap-1">
      <h3 className="m-0 text-sm font-semibold">{title}</h3>
      {children}
    </section>
  )
}

function Items({
  items,
  label
}: {
  items: readonly SwitchoverItem[]
  label: string
}): React.JSX.Element {
  if (items.length === 0) return <p className="m-0 text-sm text-fg-muted">Nothing.</p>
  return (
    <ul role="list" aria-label={label} className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-sm">
      {items.map((item, at) => (
        <li key={`${item.name}-${at}`}>
          <span className="font-medium">{item.name}</span>
          <span className="text-fg-muted">: {item.detail}</span>
        </li>
      ))}
    </ul>
  )
}

function SwitchoverBody(): React.JSX.Element {
  const titleId = useId()
  const state = useSwitchoverStore()
  const first = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    first.current?.focus()
  }, [state.phase, state.target])

  const busy =
    state.phase === 'copying' || state.phase === 'safety' || state.phase === 'converting'
  const store = useSwitchoverStore.getState
  const close = (): void => store().close()
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && !busy) {
      event.stopPropagation()
      close()
    }
  }
  const onCopy = state.target === 'copy'
  const failure =
    state.failure === null ? null : (
      <SwitchoverFailure
        failure={state.failure}
        cloud={state.cloud}
        busy={busy}
        onRetry={() => void store().retry()}
      />
    )

  let title = 'Switch to the new story memory'
  let body: ReactNode = null
  let actions: ReactNode = null
  const plan = state.plan
  if (state.phase === 'intro') {
    body = (
      <>
        {onCopy ? <p className="m-0 text-sm">{THIS_IS_A_COPY}</p> : null}
        <ul
          role="list"
          aria-label="What changes"
          data-testid="switchover-what-changes"
          className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm"
        >
          {WHAT_CHANGES.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {state.target === 'project' ? <p className="m-0 text-sm">{TRY_COPY_FIRST}</p> : null}
        {failure}
      </>
    )
    actions =
      state.target === null ? null : (
        <>
          <button type="button" className={BUTTON} onClick={close}>
            Cancel
          </button>
          {onCopy ? (
            <button
              ref={first}
              type="button"
              className={PRIMARY}
              onClick={() => void store().switchThis()}
            >
              Switch this copy…
            </button>
          ) : (
            <>
              <button type="button" className={BUTTON} onClick={() => void store().switchThis()}>
                Switch this project…
              </button>
              <button
                ref={first}
                type="button"
                className={PRIMARY}
                onClick={() => void store().tryCopy()}
              >
                Try it on a copy first
              </button>
            </>
          )}
        </>
      )
  } else if (state.phase === 'copying') {
    title = state.copy === null ? 'Making a test copy' : 'Reading the test copy'
    body = (
      <p className={`m-0 text-sm ${AI_WAIT_CLASS}`}>
        {state.copy === null ? 'Copying the project and reading it…' : 'Reading the test copy…'}
      </p>
    )
  } else if (state.phase === 'safety') {
    title = 'Making the backup and the dated copy'
    body = (
      <p className={`m-0 text-sm ${AI_WAIT_CLASS}`} data-testid="switchover-safety">
        {state.safety === null ? safetyProgress(state.cloud) : 'Reading the project…'}
      </p>
    )
  } else if (state.phase === 'plan' && plan !== null) {
    title = 'Switch-over dry run'
    body = (
      <>
        {onCopy ? (
          <p className="m-0 text-sm">
            This is a test copy; nothing has changed yet. Your original project stays as it is.
          </p>
        ) : (
          <div className="flex flex-col gap-0.5 text-sm" data-testid="switchover-yours">
            <p className="m-0">
              This is your project. Nothing has changed yet; the backup and the dated copy are made.
            </p>
            {state.safety === null ? null : (
              <>
                <p className="m-0 break-all text-xs text-fg-muted">Backup: {state.safety.backup}</p>
                <p className="m-0 break-all text-xs text-fg-muted">
                  Dated copy: {state.safety.datedCopy}
                </p>
              </>
            )}
          </div>
        )}
        <Section title="Converted" testId="switchover-converted">
          <Items items={plan.converted} label="Converted" />
        </Section>
        <Section title="Kept as it is" testId="switchover-kept">
          <Items items={plan.kept} label="Kept as it is" />
        </Section>
        <Section title="Dropped (what the AI made)" testId="switchover-dropped">
          <Items items={plan.dropped} label="Dropped" />
        </Section>
        {plan.merges.length > 0 ? (
          <Section title="These may be one record" testId="switchover-merges">
            <ul role="list" className="m-0 flex flex-col gap-1 p-0 text-sm">
              {plan.merges.map((pair) => (
                <li key={mergeKey(pair.keep, pair.merge)} className="list-none">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={state.ticked.includes(mergeKey(pair.keep, pair.merge))}
                      onChange={() => store().toggleMerge(pair.keep, pair.merge)}
                    />
                    {`Merge ${pair.mergeName} (${pair.mergeCategory}) into ${pair.keepName} (${pair.keepCategory})`}
                  </label>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
        {plan.filedByAi.length > 0 ? (
          <Section title="Filed by AI earlier: please check (Not canon)" testId="switchover-ai">
            <ul role="list" className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-sm">
              {plan.filedByAi.map((each) => (
                <li key={each.name}>
                  <span className="font-medium">{each.name}</span>: {each.lines.join(' · ')}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
        {plan.notes.length > 0 ? (
          <Section title="Notes" testId="switchover-notes">
            <ul role="list" className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-sm">
              {plan.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </Section>
        ) : null}
        <p className="m-0 text-sm" data-testid="switchover-rebuild">
          {rebuildLine(plan.rebuild)}
        </p>
      </>
    )
    actions = (
      <>
        <button ref={first} type="button" className={BUTTON} onClick={close}>
          Cancel
        </button>
        <button type="button" className={PRIMARY} onClick={() => void store().toConsent()}>
          Next
        </button>
      </>
    )
  } else if (state.phase === 'consent' || state.phase === 'converting') {
    title = 'Inline tags become words'
    body = (
      <>
        <p className="m-0 text-sm">
          Each inline tag in your scenes, notes and other drafts becomes these words. Snapshots are
          left as they are.
        </p>
        {state.rows.length === 0 ? (
          <p className="m-0 text-sm text-fg-muted">This project has no inline tags.</p>
        ) : (
          <table data-testid="switchover-consent" className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left">
                <th className="py-1 pr-2">Tag</th>
                <th className="py-1 pr-2">Uses</th>
                <th className="py-1 pr-2">Where</th>
                <th className="py-1">Becomes</th>
              </tr>
            </thead>
            <tbody>
              {state.rows.map((row) => (
                <tr key={row.key} className="align-top">
                  <td className="py-1 pr-2 font-medium">{row.tag}</td>
                  <td className="py-1 pr-2">{row.count}</td>
                  <td className="py-1 pr-2 text-fg-muted">{row.sample}</td>
                  <td className="py-1">
                    <input
                      type="text"
                      aria-label={`Replacement for ${row.tag}`}
                      value={row.replacement}
                      disabled={busy}
                      maxLength={INLINE_TAG_REPLACEMENT_MAX}
                      onChange={(event) => store().setReplacement(row.key, event.target.value)}
                      className="w-full rounded-md border border-line bg-surface px-2 py-1"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="m-0 break-all text-sm" data-testid="switchover-consent-last">
          {onCopy
            ? 'Only this test copy changes; the project it was made from stays as it is.'
            : `Convert changes this project. Its backup is ${state.safety?.backup ?? 'made first'}.`}
        </p>
        {failure}
      </>
    )
    actions = (
      <>
        <button
          ref={first}
          type="button"
          className={BUTTON}
          disabled={busy}
          onClick={() => store().back()}
        >
          Back
        </button>
        <button
          type="button"
          className={PRIMARY}
          disabled={busy}
          onClick={() => void store().convert()}
        >
          {state.phase === 'converting' ? (
            <span className={AI_WAIT_CLASS}>Converting…</span>
          ) : (
            'Convert'
          )}
        </button>
      </>
    )
  } else if (state.phase === 'done' && state.result !== null) {
    const { counts, backup, datedCopy, trial } = state.result
    title = 'Switched over'
    const where = cloudLabel(state.cloud)
    body = (
      <>
        <p className="m-0 text-sm" data-testid="switchover-done">
          {trial
            ? `This test copy now uses the new story memory: ${countsLine(counts)}.`
            : `Your project now uses the new story memory: ${countsLine(counts)}.`}
        </p>
        {trial ? (
          <p className="m-0 break-all text-sm" data-testid="switchover-original">
            {`Your project at ${state.source ?? 'its folder'} is unchanged and still uses the old one.`}
          </p>
        ) : null}
        {backup === null ? null : (
          <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="switchover-backup">
            <span className="min-w-0 break-all">
              Backup: {backup} (kept until you delete it)
            </span>
            <button type="button" className={BUTTON} onClick={() => void showBackups()}>
              Show backups
            </button>
          </div>
        )}
        {datedCopy === null ? null : (
          <p className="m-0 break-all text-sm" data-testid="switchover-dated-copy">
            {where === null
              ? `Dated copy: ${datedCopy}`
              : `Dated copy (in ${where}): ${datedCopy}`}
          </p>
        )}
        {trial || backup === null ? null : (
          <p className="m-0 text-sm" data-testid="switchover-go-back">
            {goBackLine(backup)}
          </p>
        )}
      </>
    )
    actions = trial ? (
      <>
        <button type="button" className={BUTTON} onClick={close}>
          Close
        </button>
        <button
          ref={first}
          type="button"
          className={PRIMARY}
          disabled={state.source === null}
          onClick={() => void store().openMyProject()}
        >
          Open my project
        </button>
      </>
    ) : (
      <button ref={first} type="button" className={PRIMARY} onClick={close}>
        Close
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="switchover-dialog"
        onKeyDown={onKeyDown}
        className="flex max-h-[88vh] w-[640px] max-w-[94vw] flex-col gap-3 overflow-y-auto rounded-lg border border-line bg-surface-raised px-5 py-4 shadow-panel"
      >
        <h2 id={titleId} className="m-0 text-lg font-semibold">
          {title}
        </h2>
        {body}
        {state.error === null ? null : (
          <p role="alert" className="m-0 text-sm text-danger">
            {state.error}
          </p>
        )}
        {actions === null ? null : <div className="flex justify-end gap-2">{actions}</div>}
      </div>
    </div>
  )
}

/** *Show backups*: the backup folder in the file manager; a failure says why. */
async function showBackups(): Promise<void> {
  await useBackupStore.getState().reveal()
  const error = useBackupStore.getState().error
  if (error !== null) toast.error(error)
}
