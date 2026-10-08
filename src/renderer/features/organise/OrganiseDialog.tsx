import { useEffect, useId, useRef, type KeyboardEvent } from 'react'
import { categoryFieldLabel, categoryOf } from '@shared/categories'
import {
  canUndo,
  describeOrganiseAction,
  groupOf,
  needsAsk,
  ORGANISE_GROUP_LABEL,
  ORGANISE_GROUPS,
  ORGANISE_SCOPE_LABEL,
  scopesOf,
  type OrganiseAction
} from '@shared/organise'
import { AiWaitText } from '@renderer/features/ai/AiWaitText'
import { AI_WAIT_PHRASES } from '@renderer/features/ai/aiWaitPhrases'
import { RequestCost } from '@renderer/features/ai/RequestCost'
import { useCategoryStore } from '@renderer/features/entities/categoryStore'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { useOrganiseStore, type OrganiseChangeView } from './organiseStore'

const BUTTON =
  'rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-60'
const PRIMARY =
  'rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-60'
const LINK = 'text-xs text-accent hover:underline disabled:opacity-60'
/** Characters of a before or after value the plan screen shows. */
const VALUE_SHOWN = 160

const clip = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= VALUE_SHOWN ? flat : `${flat.slice(0, VALUE_SHOWN - 1)}…`
}

/**
 * The Organise plan screen (F-9.10): every change of the plan grouped (new categories, tags,
 * story bible, notes, binder), each with what it does and why, and where it stands. Ask: a
 * checkbox per change and Apply. Auto: what could be undone is already applied, each with Undo,
 * and "Undo the whole reorganisation"; merges, deletions, and new categories still wait for
 * Apply. Plan: it only describes.
 */
export function OrganiseDialog(): React.JSX.Element | null {
  const open = useOrganiseStore((s) => s.open)
  if (!open) return null
  return <Dialog />
}

function Dialog(): React.JSX.Element {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const phase = useOrganiseStore((s) => s.phase)
  const mode = useOrganiseStore((s) => s.mode)
  const request = useOrganiseStore((s) => s.request)
  const close = useOrganiseStore((s) => s.close)
  const stop = useOrganiseStore((s) => s.stop)

  useEffect(() => {
    panel.current?.focus()
  }, [phase])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    if (phase === 'running') stop()
    else close()
  }

  const scope =
    request === null
      ? ''
      : scopesOf(request)
          .map((s) => ORGANISE_SCOPE_LABEL[s])
          .join(', ')
  const lead =
    mode === 'plan'
      ? 'Plan mode: this only describes the changes. Switch the chat to Ask or Auto to apply them.'
      : mode === 'auto'
        ? 'Auto: what can be undone is applied, each with Undo. Merges, deletions, and new categories wait for you. Scene text is never rewritten.'
        : 'Tick what to keep; nothing changes until you apply. Scene text is never rewritten.'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="organise-dialog"
        onKeyDown={onKeyDown}
        className="flex max-h-[85vh] w-[760px] max-w-[95vw] flex-col rounded-lg border border-line bg-surface-raised shadow-panel outline-none"
      >
        <div className="shrink-0 border-b border-line px-5 pt-4 pb-3">
          <h2 id={titleId} className="m-0 text-base font-semibold">
            Organise {scope === '' ? '' : `· ${scope}`}
          </h2>
          <p className="mt-1 mb-0 text-sm text-fg-muted">{lead}</p>
          {request !== null && request.instruction !== '' ? (
            <p className="mt-1 mb-0 text-xs text-fg-subtle" data-testid="organise-instruction">
              You asked: {request.instruction}
            </p>
          ) : null}
        </div>
        {phase === 'ready' ? <Plan /> : <Status />}
      </div>
    </div>
  )
}

function Status(): React.JSX.Element {
  const phase = useOrganiseStore((s) => s.phase)
  const error = useOrganiseStore((s) => s.error)
  const request = useOrganiseStore((s) => s.request)
  const close = useOrganiseStore((s) => s.close)
  const stop = useOrganiseStore((s) => s.stop)
  const start = useOrganiseStore((s) => s.start)
  return (
    <>
      <div
        className={
          phase === 'running'
            ? 'flex min-h-40 items-center justify-center px-5 py-10 text-center text-sm'
            : 'px-5 py-4 text-sm'
        }
      >
        {phase === 'running' ? (
          <AiWaitText phrases={AI_WAIT_PHRASES.organise} testId="organise-running" />
        ) : (
          <p className="m-0 text-danger" role="alert" data-testid="organise-error">
            {error ?? 'Organise did not finish.'}
          </p>
        )}
      </div>
      <div className="flex shrink-0 justify-end gap-2 border-t border-line px-5 py-3">
        {phase === 'running' ? (
          <button type="button" onClick={stop} className={BUTTON}>
            Stop
          </button>
        ) : (
          <>
            <button type="button" onClick={close} className={BUTTON}>
              Close
            </button>
            {request !== null ? (
              <button type="button" onClick={() => void start(request)} className={PRIMARY}>
                Try again
              </button>
            ) : null}
          </>
        )}
      </div>
    </>
  )
}

function Plan(): React.JSX.Element {
  const plan = useOrganiseStore((s) => s.plan)
  const order = useOrganiseStore((s) => s.order)
  const views = useOrganiseStore((s) => s.views)
  const mode = useOrganiseStore((s) => s.mode)
  const busy = useOrganiseStore((s) => s.busy)
  const model = useOrganiseStore((s) => s.model)
  const costUsd = useOrganiseStore((s) => s.costUsd)
  const usage = useOrganiseStore((s) => s.usage)
  const cached = useOrganiseStore((s) => s.cached)
  const close = useOrganiseStore((s) => s.close)
  const applySelected = useOrganiseStore((s) => s.applySelected)
  const undoAll = useOrganiseStore((s) => s.undoAll)
  const setAll = useOrganiseStore((s) => s.setAll)
  const all = order.flatMap((id) => (views[id] === undefined ? [] : [views[id]]))
  const ticked = all.filter((view) => view.status === 'pending' && view.checked).length
  const pending = all.filter((view) => view.status === 'pending').length
  const undoable = all.filter(
    (view) => view.status === 'applied' && canUndo(view.change.action)
  ).length

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3 text-sm">
        {plan !== null && plan.reply !== '' ? (
          <p className="mt-0 mb-2" data-testid="organise-reply">
            {plan.reply}
          </p>
        ) : null}
        <p className="mt-0 mb-3 text-xs text-fg-subtle tabular-nums" data-testid="organise-cost">
          <RequestCost request={{ model: model ?? '', costUsd, usage, cached }} />
        </p>
        {all.length === 0 ? (
          <p className="m-0 text-fg-muted" data-testid="organise-nothing">
            Nothing to change: everything already looks organised.
          </p>
        ) : (
          ORGANISE_GROUPS.map((group) => {
            const rows = all.filter((view) => groupOf(view.change.action) === group)
            if (rows.length === 0) return null
            return (
              <section key={group} className="mb-3" aria-label={ORGANISE_GROUP_LABEL[group]}>
                <h3 className="mt-0 mb-1 text-xs font-semibold tracking-wide text-fg-muted uppercase">
                  {ORGANISE_GROUP_LABEL[group]}
                </h3>
                <ul className="m-0 list-none p-0">
                  {rows.map((view) => (
                    <ChangeRow key={view.change.id} view={view} />
                  ))}
                </ul>
              </section>
            )
          })
        )}
        {plan !== null && plan.skipped.length > 0 ? (
          <details className="mt-2 text-xs text-fg-muted">
            <summary>
              {plan.skipped.length} suggestion{plan.skipped.length === 1 ? '' : 's'} could not be
              used
            </summary>
            <ul className="mt-1 mb-0 pl-4">
              {plan.skipped.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-line px-5 py-3">
        <div className="flex gap-3">
          {mode !== 'plan' && pending > 0 ? (
            <>
              <button type="button" className={LINK} disabled={busy} onClick={() => setAll(true)}>
                Select all
              </button>
              <button type="button" className={LINK} disabled={busy} onClick={() => setAll(false)}>
                Select none
              </button>
            </>
          ) : null}
          {undoable > 0 ? (
            <button
              type="button"
              className={LINK}
              disabled={busy}
              data-testid="organise-undo-all"
              onClick={() => void undoAll()}
            >
              Undo the whole reorganisation
            </button>
          ) : null}
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={close} disabled={busy} className={BUTTON}>
            {pending === 0 || mode === 'plan' ? 'Done' : 'Close'}
          </button>
          {mode !== 'plan' && pending > 0 ? (
            <button
              type="button"
              data-testid="organise-apply"
              disabled={busy || ticked === 0}
              onClick={() => void applySelected()}
              className={PRIMARY}
            >
              {ticked === pending ? `Apply ${ticked}` : `Apply ${ticked} of ${pending}`}
            </button>
          ) : null}
        </div>
      </div>
    </>
  )
}

function ChangeRow({ view }: { view: OrganiseChangeView }): React.JSX.Element {
  const mode = useOrganiseStore((s) => s.mode)
  const busy = useOrganiseStore((s) => s.busy)
  const views = useOrganiseStore((s) => s.views)
  const toggle = useOrganiseStore((s) => s.toggle)
  const undo = useOrganiseStore((s) => s.undo)
  const categories = useCategoryStore((s) => s.categories)
  const { change, status } = view
  const proposedName = (id: string): string | undefined => {
    const proposal = Object.values(views).find(
      (other) => other.change.action.kind === 'category' && other.change.action.id === id
    )?.change.action
    return proposal?.kind === 'category' ? proposal.name : undefined
  }
  const categoryName = (id: string): string => proposedName(id) ?? categoryOf(id, categories).name
  const label = describeOrganiseAction(change.action, categoryName)
  const checkable = status === 'pending' && mode !== 'plan'
  const asks = needsAsk(change.action)
  return (
    <li
      className="flex items-start gap-2 border-b border-line py-1.5 last:border-b-0"
      data-testid="organise-change"
      data-status={status}
    >
      {checkable ? (
        <input
          type="checkbox"
          className="mt-1"
          checked={view.checked}
          disabled={busy}
          aria-label={label}
          onChange={() => toggle(change.id)}
        />
      ) : (
        <span className="mt-0.5 w-[13px] shrink-0" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className={status === 'undone' ? 'text-fg-muted line-through' : ''}>{label}</span>
          {status === 'applied' ? <span className="text-xs text-success">Applied</span> : null}
          {status === 'undone' ? <span className="text-xs text-fg-muted">Undone</span> : null}
          {status === 'applying' ? <span className="text-xs text-fg-muted">Applying…</span> : null}
          {status === 'pending' && asks && mode === 'auto' ? (
            <span className="text-xs text-fg-muted">Asks first</span>
          ) : null}
        </div>
        {change.reason !== '' ? (
          <div className="text-xs text-fg-subtle">{change.reason}</div>
        ) : null}
        <Detail action={change.action} />
        {view.error !== null ? (
          <div className="text-xs text-danger" role="alert">
            {view.error}
          </div>
        ) : null}
      </div>
      {status === 'applied' && canUndo(change.action) ? (
        <button
          type="button"
          className={LINK}
          disabled={busy}
          aria-label={`Undo: ${label}`}
          onClick={() => void undo(change.id)}
        >
          Undo
        </button>
      ) : null}
    </li>
  )
}

/** What a change replaces and with what, where that is worth showing: fields, page, notes. */
function Detail({ action }: { action: OrganiseAction }): React.JSX.Element | null {
  const categories = useCategoryStore((s) => s.categories)
  const sheetKind = useEntityStore((s) =>
    action.kind === 'sheet' ? (s.byId[action.entityId]?.kind ?? null) : null
  )
  if (action.kind === 'notes') {
    return (
      <ul className="mt-0.5 mb-0 pl-4 text-xs text-fg-muted">
        {action.points.map((point, i) => (
          <li key={i}>{clip(point)}</li>
        ))}
      </ul>
    )
  }
  if (action.kind !== 'sheet') return null
  const category = categoryOf(action.patch.kind ?? sheetKind ?? '', categories)
  const rows = Object.entries(action.patch.fields ?? {}).map(([id, after]) => ({
    label: categoryFieldLabel(category, id),
    before: action.before.fields?.[id] ?? '',
    after
  }))
  if (action.patch.body !== undefined) {
    rows.push({ label: 'Page', before: action.before.body ?? '', after: action.patch.body ?? '' })
  }
  if (rows.length === 0) return null
  return (
    <dl className="mt-0.5 mb-0 text-xs">
      {rows.map((row) => (
        <div key={row.label} className="flex gap-1">
          <dt className="shrink-0 text-fg-muted">{row.label}:</dt>
          <dd className="m-0 min-w-0">
            {row.before.trim() !== '' ? (
              <del className="text-fg-subtle">{clip(row.before)}</del>
            ) : null}{' '}
            <ins className="text-accent no-underline">{clip(row.after)}</ins>
          </dd>
        </div>
      ))}
    </dl>
  )
}
