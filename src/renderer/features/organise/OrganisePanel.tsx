import { useId, useMemo, useState } from 'react'
import { categoryFieldLabel, categoryOf } from '@shared/categories'
import {
  canUndo,
  describeOrganiseAction,
  groupOf,
  needsAsk,
  ORGANISE_GROUP_LABEL,
  ORGANISE_GROUP_NOUN,
  ORGANISE_GROUPS,
  ORGANISE_SCOPE_LABEL,
  scopesOf,
  type OrganiseAction
} from '@shared/organise'
import { TAG_CATEGORIES, TAG_CATEGORY_LABEL, TagCategory, toTagName } from '@shared/tags'
import { AiWaitText } from '@renderer/features/ai/AiWaitText'
import { AI_WAIT_PHRASES } from '@renderer/features/ai/aiWaitPhrases'
import { RequestCost } from '@renderer/features/ai/RequestCost'
import { useCategoryStore } from '@renderer/features/entities/categoryStore'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { ReviewDeck } from '@renderer/features/review/ReviewDeck'
import type { ReviewDeckGroup, ReviewDeckItem } from '@renderer/features/review/reviewDeckModel'
import { SideWorkFrame } from '@renderer/features/sideWork/SideWorkFrame'
import { useTakesFocus } from '@renderer/features/sideWork/sideWork'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { useOrganiseStore } from './organiseStore'

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
 * The Organise plan screen (F-9.10; one decision at a time since 2026-10-08; side work since
 * 2026-10-10): shown in the assistant column when the author opens the run from its status-bar
 * item, never over the editor. While the AI works it shows the wait with Stop (Escape stops
 * too); then the plan on the review deck, grouped (Merges, Not names, Categories, Tags, Story
 * bible, Notes, Binder), one card per change with what it does, before → after, and why. Ask:
 * Accept / Skip / Edit each (A / S / E), Accept group, and "Apply N accepted" (or reaching the
 * end with nothing skipped) applies them. Auto: what could be undone is already applied, each
 * with Undo, and "Undo the whole reorganisation"; merges, deletions, and new categories wait on
 * the deck. Plan: the cards only describe. Close (or Escape) ends the run; "Back to the
 * conversation" only hides it.
 */
export function OrganisePanel(): React.JSX.Element | null {
  const shown = useOrganiseStore((s) => s.open && s.shown)
  if (!shown) return null
  return <Panel />
}

function Panel(): React.JSX.Element {
  const phase = useOrganiseStore((s) => s.phase)
  const mode = useOrganiseStore((s) => s.mode)
  const request = useOrganiseStore((s) => s.request)
  const busy = useOrganiseStore((s) => s.busy)
  const close = useOrganiseStore((s) => s.close)
  const stop = useOrganiseStore((s) => s.stop)
  const hide = useOrganiseStore((s) => s.hide)

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
        : 'One change at a time: A accepts, S skips, E edits. Nothing changes until you apply. Scene text is never rewritten.'

  return (
    <SideWorkFrame
      title={`Organise${scope === '' ? '' : ` · ${scope}`}`}
      testId="organise-panel"
      onEscape={() => {
        if (phase === 'running') stop()
        else if (!busy) close()
      }}
      onHide={hide}
    >
      <div className="shrink-0 px-3 pb-2">
        <p className="mt-1 mb-0 text-xs text-fg-muted">{lead}</p>
        {request !== null && request.instruction !== '' ? (
          <p className="mt-1 mb-0 text-xs text-fg-subtle" data-testid="organise-instruction">
            You asked: {request.instruction}
          </p>
        ) : null}
      </div>
      {phase === 'ready' ? <Plan /> : <Status />}
    </SideWorkFrame>
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
            ? 'flex min-h-32 items-center justify-center px-3 py-6 text-center text-sm'
            : 'px-3 py-3 text-sm'
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
      <div className="flex shrink-0 justify-end gap-2 border-t border-line px-3 py-2">
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

const GROUPS: ReviewDeckGroup[] = ORGANISE_GROUPS.map((id) => ({
  id,
  label: ORGANISE_GROUP_LABEL[id],
  noun: ORGANISE_GROUP_NOUN[id]
}))

/** The changes whose card has an edit form: another keeper, a new name, another category. */
const EDITABLE: ReadonlySet<OrganiseAction['kind']> = new Set([
  'mergeTags',
  'mergeSheets',
  'tag',
  'sheet',
  'createSheet',
  'category'
])

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
  const decide = useOrganiseStore((s) => s.decide)
  const setEditing = useOrganiseStore((s) => s.setEditing)
  const applyAccepted = useOrganiseStore((s) => s.applyAccepted)
  const undoAll = useOrganiseStore((s) => s.undoAll)
  const autoFocus = useTakesFocus()
  const items = useMemo<ReviewDeckItem[]>(
    () =>
      order.flatMap((id) => {
        const view = views[id]
        if (view === undefined) return []
        return [
          {
            id,
            group: groupOf(view.change.action),
            decision: view.decision,
            settled: mode === 'plan' || view.status !== 'pending'
          }
        ]
      }),
    [order, views, mode]
  )
  const pending = items.filter((item) => item.settled !== true).length
  const undoable = order.filter(
    (id) => views[id]?.status === 'applied' && canUndo(views[id].change.action)
  ).length

  const closeButton = (
    <button
      type="button"
      onClick={close}
      disabled={busy}
      className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-60"
    >
      {pending === 0 || mode === 'plan' ? 'Done' : 'Close'}
    </button>
  )

  return (
    <>
      {(plan !== null && plan.reply !== '') || (plan !== null && plan.skipped.length > 0) ? (
        <div className="shrink-0 px-3 pt-1 text-sm">
          {plan.reply !== '' ? (
            <p className="m-0" data-testid="organise-reply">
              {plan.reply}
            </p>
          ) : null}
          {plan.skipped.length > 0 ? (
            <details className="mt-1 text-xs text-fg-muted">
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
      ) : null}
      {items.length === 0 ? (
        <>
          <p className="m-0 px-3 py-3 text-sm text-fg-muted" data-testid="organise-nothing">
            Nothing to change: everything already looks organised.
          </p>
          <div className="flex shrink-0 justify-end border-t border-line px-3 py-2">
            {closeButton}
          </div>
        </>
      ) : (
        <ReviewDeck
          label="Organise changes"
          items={items}
          groups={GROUPS}
          renderCard={(id) => <ChangeCard id={id} />}
          onDecide={decide}
          onEdit={mode === 'plan' ? undefined : setEditing}
          canEdit={(id) => {
            const kind = useOrganiseStore.getState().views[id]?.change.action.kind
            return kind !== undefined && EDITABLE.has(kind)
          }}
          apply={
            mode === 'plan'
              ? undefined
              : { label: (n) => `Apply ${n} accepted`, onApply: () => void applyAccepted() }
          }
          applyOnFinish
          busy={busy}
          compact
          autoFocus={autoFocus}
          footer={
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="tabular-nums" data-testid="organise-cost">
                <RequestCost request={{ model: model ?? '', costUsd, usage, cached }} />
              </span>
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
            </span>
          }
          actions={closeButton}
        />
      )}
    </>
  )
}

const STATUS_TEXT = {
  applied: 'Applied',
  undone: 'Undone',
  applying: 'Applying…',
  failed: 'Failed'
} as const

/** One change on the deck: what it does, before → after, why, where it stands, and its edit form. */
function ChangeCard({ id }: { id: string }): React.JSX.Element | null {
  const view = useOrganiseStore((s) => s.views[id])
  const views = useOrganiseStore((s) => s.views)
  const mode = useOrganiseStore((s) => s.mode)
  const busy = useOrganiseStore((s) => s.busy)
  const editing = useOrganiseStore((s) => s.editingId === id)
  const undo = useOrganiseStore((s) => s.undo)
  const categories = useCategoryStore((s) => s.categories)
  if (view === undefined) return null
  const { change, status } = view
  const proposedName = (categoryId: string): string | undefined => {
    const proposal = Object.values(views).find(
      (other) => other.change.action.kind === 'category' && other.change.action.id === categoryId
    )?.change.action
    return proposal?.kind === 'category' ? proposal.name : undefined
  }
  const categoryName = (categoryId: string): string =>
    proposedName(categoryId) ?? categoryOf(categoryId, categories).name
  const label = describeOrganiseAction(change.action, categoryName)
  return (
    <div className="flex flex-col gap-2" data-testid="organise-change" data-status={status}>
      <p
        className={`m-0 text-base font-medium ${status === 'undone' ? 'text-fg-muted line-through' : ''}`}
      >
        {label}
      </p>
      <Preview action={change.action} />
      {change.reason !== '' ? (
        <p className="m-0 text-sm text-fg-muted">
          <span className="font-medium">Why: </span>
          {change.reason}
        </p>
      ) : null}
      {status !== 'pending' ? (
        <p className="m-0 flex items-center gap-2 text-xs">
          <span className={status === 'applied' ? 'text-success' : 'text-fg-muted'}>
            {STATUS_TEXT[status]}
          </span>
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
        </p>
      ) : mode === 'auto' && needsAsk(change.action) ? (
        <p className="m-0 text-xs text-fg-muted">Asks first: nothing undoes this one.</p>
      ) : null}
      {view.error !== null ? (
        <p className="m-0 text-xs text-danger" role="alert">
          {view.error}
        </p>
      ) : null}
      {editing ? <EditForm id={id} action={change.action} /> : null}
    </div>
  )
}

const tagName = (name: string): string => `#${name}`
const NO_ALIASES: readonly string[] = []

/** Before → after, where a change has more to show than its one line. */
function Preview({ action }: { action: OrganiseAction }): React.JSX.Element | null {
  const categories = useCategoryStore((s) => s.categories)
  const sheetKind = useEntityStore((s) =>
    action.kind === 'sheet' ? (s.byId[action.entityId]?.kind ?? null) : null
  )
  const targetAliases = useTagStore((s) =>
    action.kind === 'mergeTags' ? (s.byId[action.target.id]?.aliases ?? NO_ALIASES) : NO_ALIASES
  )
  switch (action.kind) {
    case 'mergeTags':
    case 'mergeSheets': {
      const name = action.kind === 'mergeTags' ? tagName : (n: string): string => n
      const aliases = [
        ...targetAliases,
        ...action.sources.map((source) =>
          source.name
            .split('-')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ')
        )
      ]
      return (
        <div className="flex flex-col items-start gap-1 rounded-md bg-surface-raised px-3 py-2 text-sm">
          <span>{[action.target, ...action.sources].map((n) => name(n.name)).join(' + ')}</span>
          <span aria-hidden="true" className="text-fg-muted">
            ↓
          </span>
          <span className="font-medium">
            {name(action.target.name)}
            {action.kind === 'mergeTags' ? (
              <span className="font-normal text-fg-muted">{` (aliases: ${aliases.join(', ')})`}</span>
            ) : null}
          </span>
        </div>
      )
    }
    case 'deleteTag':
      return (
        <p className="m-0 text-sm">
          <del className="text-fg-subtle">{tagName(action.name)}</del>
        </p>
      )
    case 'deleteSheet':
      return (
        <p className="m-0 text-sm">
          <del className="text-fg-subtle">{action.name}</del>
        </p>
      )
    case 'notes':
      return (
        <div className="flex flex-col gap-1 text-xs">
          {action.before.trim() !== '' ? (
            <del className="text-fg-subtle">{clip(action.before)}</del>
          ) : null}
          <ul className="m-0 pl-4 text-fg-muted">
            {action.points.map((point, i) => (
              <li key={i}>{clip(point)}</li>
            ))}
          </ul>
        </div>
      )
    case 'tag': {
      const rows: { label: string; before: string; after: string }[] = []
      const { patch, before } = action
      if (patch.name !== undefined) {
        rows.push({ label: 'Name', before: tagName(before.name ?? ''), after: tagName(patch.name) })
      }
      if (patch.category !== undefined) {
        rows.push({
          label: 'Category',
          before: before.category === undefined ? '' : TAG_CATEGORY_LABEL[before.category],
          after: TAG_CATEGORY_LABEL[patch.category]
        })
      }
      if (patch.parentId !== undefined) {
        rows.push({
          label: 'Under',
          before: action.beforeParentName === null ? 'top level' : tagName(action.beforeParentName),
          after: action.parentName === null ? 'top level' : tagName(action.parentName)
        })
      }
      if (patch.aliases !== undefined) {
        rows.push({
          label: 'Aliases',
          before: (before.aliases ?? []).join(', '),
          after: patch.aliases.join(', ')
        })
      }
      return <Rows rows={rows} />
    }
    case 'sheet': {
      const category = categoryOf(action.patch.kind ?? sheetKind ?? '', categories)
      const rows = Object.entries(action.patch.fields ?? {}).map(([fieldId, after]) => ({
        label: categoryFieldLabel(category, fieldId),
        before: action.before.fields?.[fieldId] ?? '',
        after
      }))
      if (action.patch.name !== undefined) {
        rows.unshift({ label: 'Name', before: action.before.name ?? '', after: action.patch.name })
      }
      if (action.patch.body !== undefined) {
        rows.push({
          label: 'Page',
          before: action.before.body ?? '',
          after: action.patch.body ?? ''
        })
      }
      return <Rows rows={rows} />
    }
    case 'createSheet':
      return (
        <Rows
          rows={Object.entries(action.fields).map(([fieldId, after]) => ({
            label: categoryFieldLabel(categoryOf(action.category, categories), fieldId),
            before: '',
            after
          }))}
        />
      )
    case 'category':
      return action.fields.length > 0 ? (
        <p className="m-0 text-sm text-fg-muted">{`Fields: ${action.fields.join(', ')}`}</p>
      ) : null
    case 'binder':
      return null
  }
}

function Rows({
  rows
}: {
  rows: { label: string; before: string; after: string }[]
}): React.JSX.Element | null {
  if (rows.length === 0) return null
  return (
    <dl className="m-0 flex flex-col gap-1 text-sm">
      {rows.map((row) => (
        <div key={row.label} className="flex gap-1.5">
          <dt className="shrink-0 text-fg-muted">{row.label}:</dt>
          <dd className="m-0 min-w-0">
            {row.before.trim() !== '' ? (
              <>
                <del className="text-fg-subtle">{clip(row.before)}</del>
                <span aria-hidden="true" className="text-fg-muted">
                  {' → '}
                </span>
              </>
            ) : null}
            <ins className="text-accent no-underline">{clip(row.after)}</ins>
          </dd>
        </div>
      ))}
    </dl>
  )
}

const FIELD =
  'min-w-0 rounded-md border border-line bg-surface px-2 py-1 text-sm outline-none focus:border-accent'

/**
 * The deck's Edit (E): adjust a change before accepting it — another keeper for a merge, another
 * name, another tag category. Save replaces the change; the author still accepts it.
 */
function EditForm({ id, action }: { id: string; action: OrganiseAction }): React.JSX.Element {
  const editChange = useOrganiseStore((s) => s.editChange)
  const setEditing = useOrganiseStore((s) => s.setEditing)
  const currentCategory = useTagStore((s) =>
    action.kind === 'tag' ? (s.byId[action.tagId]?.category ?? null) : null
  )
  const merged =
    action.kind === 'mergeTags' || action.kind === 'mergeSheets'
      ? [action.target, ...action.sources]
      : []
  const [keep, setKeep] = useState(merged[0]?.id ?? '')
  const initialName =
    action.kind === 'tag'
      ? (action.patch.name ?? action.name)
      : action.kind === 'sheet'
        ? (action.patch.name ?? action.name)
        : action.kind === 'createSheet' || action.kind === 'category'
          ? action.name
          : ''
  const [name, setName] = useState(initialName)
  const [category, setCategory] = useState<TagCategory | null>(
    action.kind === 'tag' ? (action.patch.category ?? currentCategory) : null
  )
  const nameId = useId()

  const save = (): void => {
    const trimmed = name.trim()
    switch (action.kind) {
      case 'mergeTags':
      case 'mergeSheets': {
        const target = merged.find((n) => n.id === keep) ?? action.target
        const sources = merged.filter((n) => n.id !== target.id)
        editChange(id, { ...action, target, sources })
        return
      }
      case 'tag': {
        const patch = { ...action.patch }
        const before = { ...action.before }
        const next = toTagName(trimmed)
        if (next !== '' && next !== action.name) {
          patch.name = next
          before.name = action.name
        } else {
          delete patch.name
          delete before.name
        }
        if (category !== null && category !== currentCategory) {
          patch.category = category
          if (currentCategory !== null) before.category = currentCategory
        } else {
          delete patch.category
          delete before.category
        }
        editChange(id, { ...action, patch, before })
        return
      }
      case 'sheet': {
        const patch = { ...action.patch }
        const before = { ...action.before }
        if (trimmed !== '' && trimmed !== action.name) {
          patch.name = trimmed
          before.name = action.name
        } else {
          delete patch.name
          delete before.name
        }
        editChange(id, { ...action, patch, before })
        return
      }
      case 'createSheet':
      case 'category':
        if (trimmed !== '') editChange(id, { ...action, name: trimmed })
        return
      default:
        setEditing(null)
    }
  }

  return (
    <form
      className="flex flex-col gap-2 rounded-md border border-accent p-3"
      data-testid="organise-edit"
      onSubmit={(event) => {
        event.preventDefault()
        save()
      }}
    >
      {merged.length > 0 ? (
        <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
          <legend className="mb-1 text-xs font-medium text-fg-muted">Keep</legend>
          {merged.map((n) => (
            <label key={n.id} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`${id}-keep`}
                checked={keep === n.id}
                onChange={() => setKeep(n.id)}
              />
              {action.kind === 'mergeTags' ? tagName(n.name) : n.name}
            </label>
          ))}
        </fieldset>
      ) : null}
      {action.kind === 'tag' ||
      action.kind === 'sheet' ||
      action.kind === 'createSheet' ||
      action.kind === 'category' ? (
        <label htmlFor={nameId} className="flex flex-col gap-1 text-xs text-fg-muted">
          Name
          <input
            id={nameId}
            className={FIELD}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
      ) : null}
      {action.kind === 'tag' ? (
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Category
          <select
            className={FIELD}
            value={category ?? ''}
            onChange={(event) => {
              const parsed = TagCategory.safeParse(event.target.value)
              if (parsed.success) setCategory(parsed.data)
            }}
          >
            {TAG_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {TAG_CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="flex gap-2">
        <button
          type="submit"
          className="rounded-md bg-accent px-3 py-1 text-sm font-medium text-accent-fg hover:bg-accent-hover"
        >
          Save
        </button>
        <button
          type="button"
          className="rounded-md border border-line px-3 py-1 text-sm hover:bg-surface"
          onClick={() => setEditing(null)}
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
