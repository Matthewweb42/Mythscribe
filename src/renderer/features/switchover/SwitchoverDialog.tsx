import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import type { SwitchoverItem } from '@shared/memory/switchover'
import { formatCount } from '@renderer/features/ai/usageFormat'
import { AI_WAIT_CLASS } from '@renderer/features/ai/aiWaitPhrases'
import { mergeKey, useSwitchoverStore } from './switchoverStore'
import { rebuildLine } from './switchoverText'

/**
 * The story-memory switch-over on a copy (F-16.15): the dry run (kept, converted and dropped, by
 * name; the merges to tick; the sheet text the AI wrote; what cannot convert; the rebuild's price
 * and time), then the consent screen (each inline tag's words, editable), then the conversion's
 * summary. Escape or Cancel leaves the test copy open as it is (still v1) until Convert.
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
  }, [state.phase])

  const busy = state.phase === 'copying' || state.phase === 'converting'
  const close = (): void => useSwitchoverStore.getState().close()
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && !busy) {
      event.stopPropagation()
      close()
    }
  }

  let title = 'Story-memory switch-over'
  let body: ReactNode = null
  let actions: ReactNode = null
  const plan = state.plan
  if (state.phase === 'copying') {
    title = 'Making a test copy'
    body = <p className={`m-0 text-sm ${AI_WAIT_CLASS}`}>Copying the project and reading it…</p>
  } else if (state.phase === 'plan' && plan !== null) {
    title = 'Switch-over dry run'
    body = (
      <>
        <p className="m-0 text-sm">
          This is a test copy; nothing has changed yet. Your original project stays as it is.
        </p>
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
                      onChange={() =>
                        useSwitchoverStore.getState().toggleMerge(pair.keep, pair.merge)
                      }
                    />
                    Merge {pair.mergeName} into {pair.keepName}
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
        <button
          type="button"
          className={PRIMARY}
          onClick={() => void useSwitchoverStore.getState().toConsent()}
        >
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
                      maxLength={200}
                      onChange={(event) =>
                        useSwitchoverStore.getState().setReplacement(row.key, event.target.value)
                      }
                      className="w-full rounded-md border border-line bg-surface px-2 py-1"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="m-0 text-sm">
          A full backup and a dated copy beside this project are made first.
        </p>
      </>
    )
    actions = (
      <>
        <button
          ref={first}
          type="button"
          className={BUTTON}
          disabled={busy}
          onClick={() => useSwitchoverStore.getState().back()}
        >
          Back
        </button>
        <button
          type="button"
          className={PRIMARY}
          disabled={busy}
          onClick={() => void useSwitchoverStore.getState().convert()}
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
    const { counts, backup, datedCopy } = state.result
    title = 'Switched over'
    body = (
      <>
        <p className="m-0 text-sm" data-testid="switchover-done">
          The test copy now uses the new story memory: {formatCount(counts.records, 'record')},{' '}
          {formatCount(counts.labels, 'label')}, {formatCount(counts.research, 'Research document')}
          , {formatCount(counts.tokens, 'inline tag')} as words.
        </p>
        <p className="m-0 break-all text-xs text-fg-muted">
          Dated copy: {datedCopy}
          {backup === null ? '' : ` · Backup: ${backup}`}
        </p>
      </>
    )
    actions = (
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
