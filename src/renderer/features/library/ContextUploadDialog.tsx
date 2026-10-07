import { useEffect, useId, useRef, type KeyboardEvent } from 'react'
import {
  canSplit,
  reviewHasChanges,
  type ContextEstimate,
  type ContextReview,
  type ContextReviewEntity,
  type ContextReviewField
} from '@shared/contextLibrary'
import { ENTITY_FIELDS, ENTITY_KIND_NOUN, entityTagName } from '@shared/entities'
import { RequestCost } from '@renderer/features/ai/RequestCost'
import { formatCount, formatUsd } from '@renderer/features/ai/usageFormat'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { useLibraryStore, type LibraryFlow } from './libraryStore'

const BUTTON =
  'rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-60'
const PRIMARY =
  'rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-60'
const LINK = 'text-xs text-accent hover:underline disabled:opacity-60'

const fieldLabel = (item: ContextReviewEntity, field: ContextReviewField): string =>
  ENTITY_FIELDS[item.kind].find((def) => def.id === field.field)?.label ?? field.field

/** The estimate as one line (CLAUDE.md rule 10: cost is visible before anything is sent). */
function estimateLine(estimate: ContextEstimate): string {
  const requests = formatCount(estimate.chunks, 'request')
  const files = formatCount(estimate.files, 'file')
  const tokens = `≈ ${formatCount(estimate.tokensIn)} tokens in, ${formatCount(estimate.tokensOut)} out`
  const model = estimate.model === '' ? 'the strong model' : estimate.model
  const cost = estimate.priced
    ? `about ${formatUsd(estimate.costUsd)}`
    : 'cost unknown for this model'
  return `${files} · ${requests} to ${model} · ${tokens} · ${cost}`
}

/** What the review would do, as its header's one line. */
function summaryLine(review: ContextReview): string {
  const included = review.entities.filter((item) => item.include)
  const created = included.filter((item) => item.existingId === null).length
  const updated = included.length - created
  const conflicts = included.reduce(
    (sum, item) => sum + item.fields.filter((field) => field.existing !== null).length,
    0
  )
  const parts = [formatCount(created, 'new sheet'), formatCount(updated, 'sheet') + ' to update']
  if (conflicts > 0) parts.push(formatCount(conflicts, 'conflict'))
  if (review.notes.include && review.notes.paragraphs.length > 0) {
    parts.push(`${formatCount(review.notes.paragraphs.length, 'note')} for Project notes`)
  }
  return parts.join(' · ')
}

/**
 * The context library's sorting dialog (F-9.8), open while `libraryStore.flow` is set: the
 * estimate to confirm, the pass's progress with Stop, a failure with its next step, and the
 * review — every sheet to create or fill, each field to fill, each conflict with both values
 * side by side, the matches merged across files (with Split), tags, pictures, and Project notes,
 * all included by default except a conflict's upload value and a picture that would replace
 * one. Nothing is written until Apply; Cancel and Escape drop it all.
 */
export function ContextUploadDialog(): React.JSX.Element | null {
  const flow = useLibraryStore((s) => s.flow)
  if (flow === null) return null
  return <Dialog flow={flow} />
}

function Dialog({ flow }: { flow: LibraryFlow }): React.JSX.Element {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const discard = useLibraryStore((s) => s.discard)
  const cancelRun = useLibraryStore((s) => s.cancelRun)

  useEffect(() => {
    panel.current?.focus()
  }, [flow.stage])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    if (flow.stage === 'running') cancelRun()
    else discard()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="library-dialog"
        onKeyDown={onKeyDown}
        className={`flex max-h-[85vh] max-w-[95vw] flex-col rounded-lg border border-line bg-surface-raised shadow-panel outline-none ${flow.stage === 'review' ? 'w-[760px]' : 'w-[520px]'}`}
      >
        <div className="shrink-0 border-b border-line px-5 pt-4 pb-3">
          <h2 id={titleId} className="m-0 text-base font-semibold">
            {flow.stage === 'review' ? 'Review before it lands' : 'Sort into the story bible'}
          </h2>
          {flow.stage === 'review' ? (
            <>
              <p className="mt-1 mb-0 text-sm text-fg-muted">
                Pick what goes into your sheets. Nothing is written until you apply.
              </p>
              <p className="mt-1 mb-0 text-xs text-fg-subtle" data-testid="library-review-summary">
                {summaryLine(flow.review)}
              </p>
            </>
          ) : null}
        </div>
        {flow.stage === 'review' ? (
          <Review review={flow.review} busy={flow.busy} />
        ) : (
          <Status flow={flow} />
        )}
      </div>
    </div>
  )
}

function Status({ flow }: { flow: Exclude<LibraryFlow, { stage: 'review' }> }): React.JSX.Element {
  const discard = useLibraryStore((s) => s.discard)
  const confirm = useLibraryStore((s) => s.confirm)
  const cancelRun = useLibraryStore((s) => s.cancelRun)
  const sort = useLibraryStore((s) => s.sort)
  return (
    <>
      <div className="px-5 py-4 text-sm">
        {flow.stage === 'estimating' ? (
          <p className="m-0 text-fg-muted" role="status">
            Working out what sorting would cost…
          </p>
        ) : flow.stage === 'confirm' ? (
          <>
            <p className="m-0">
              The AI reads your documents and proposes sheets, fields, tags, and notes. You review
              everything before it lands.
            </p>
            <p className="mt-2 mb-0 text-fg-muted tabular-nums" data-testid="library-estimate">
              {estimateLine(flow.estimate)}
            </p>
          </>
        ) : flow.stage === 'running' ? (
          <p
            className="m-0 text-fg-muted tabular-nums"
            role="status"
            data-testid="library-progress"
          >
            {flow.progress === null
              ? `Reading ${formatCount(flow.estimate.chunks, 'request')}…`
              : `Request ${flow.progress.done} of ${flow.progress.total} · ${formatUsd(flow.progress.costUsd)} so far`}
          </p>
        ) : (
          <p className="m-0 text-danger" role="alert" data-testid="library-error">
            {`${flow.message} ${flow.nextStep}`.trim()}
          </p>
        )}
      </div>
      <div className="flex shrink-0 justify-end gap-2 border-t border-line px-5 py-3">
        {flow.stage === 'running' ? (
          <button type="button" data-testid="library-stop" onClick={cancelRun} className={BUTTON}>
            Stop
          </button>
        ) : (
          <button type="button" data-testid="library-cancel" onClick={discard} className={BUTTON}>
            {flow.stage === 'failed' ? 'Close' : 'Cancel'}
          </button>
        )}
        {flow.stage === 'confirm' ? (
          <button
            type="button"
            data-testid="library-confirm"
            onClick={() => void confirm()}
            className={PRIMARY}
          >
            Sort with AI
          </button>
        ) : null}
        {flow.stage === 'failed' ? (
          <button
            type="button"
            onClick={() => {
              discard()
              void sort(flow.fileIds)
            }}
            className={PRIMARY}
          >
            Try again
          </button>
        ) : null}
      </div>
    </>
  )
}

function Review({ review, busy }: { review: ContextReview; busy: boolean }): React.JSX.Element {
  const discard = useLibraryStore((s) => s.discard)
  const apply = useLibraryStore((s) => s.apply)
  const edit = useLibraryStore((s) => s.edit)
  const setAll = (include: boolean): void =>
    edit((r) => ({
      ...r,
      entities: r.entities.map((item) => ({ ...item, include })),
      notes: { ...r.notes, include }
    }))
  return (
    <>
      <div className="flex shrink-0 gap-3 px-5 pt-2">
        <button type="button" className={LINK} disabled={busy} onClick={() => setAll(true)}>
          Include everything
        </button>
        <button type="button" className={LINK} disabled={busy} onClick={() => setAll(false)}>
          Include nothing
        </button>
      </div>
      <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-3" data-testid="library-review">
        {review.entities.map((item) => (
          <EntityCard key={item.id} item={item} busy={busy} />
        ))}
        {review.notes.paragraphs.length > 0 ? <NotesCard review={review} busy={busy} /> : null}
      </ul>
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-5 py-3">
        <span
          className="flex-1 text-xs text-fg-subtle tabular-nums"
          data-testid="library-review-cost"
        >
          <RequestCost
            request={{
              model: review.model,
              costUsd: review.costUsd,
              usage: review.usage,
              cached: false
            }}
          />
        </span>
        <button
          type="button"
          data-testid="library-discard"
          disabled={busy}
          onClick={discard}
          className={BUTTON}
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="library-apply"
          disabled={busy || !reviewHasChanges(review)}
          onClick={() => void apply()}
          className={PRIMARY}
        >
          Apply
        </button>
      </div>
    </>
  )
}

/** Replaces one review item through the store. */
function useItemEdit(
  itemId: string
): (change: (item: ContextReviewEntity) => ContextReviewEntity) => void {
  const edit = useLibraryStore((s) => s.edit)
  return (change) =>
    edit((review) => ({
      ...review,
      entities: review.entities.map((item) => (item.id === itemId ? change(item) : item))
    }))
}

function EntityCard({
  item,
  busy
}: {
  item: ContextReviewEntity
  busy: boolean
}): React.JSX.Element {
  const editItem = useItemEdit(item.id)
  const split = useLibraryStore((s) => s.split)
  const off = busy || !item.include
  const tagName = entityTagName(item.name)
  // Details go to a structured sheet's Notes field, or to a blank sheet's page.
  const blank = useEntityStore((s) =>
    item.existingId === null ? false : s.byId[item.existingId]?.template === 'blank'
  )
  const detailsPlace = blank ? 'the page' : 'Notes'
  const setField = (index: number, patch: Partial<ContextReviewField>): void =>
    editItem((current) => ({
      ...current,
      fields: current.fields.map((field, i) => (i === index ? { ...field, ...patch } : field))
    }))
  return (
    <li
      className="m-0 mb-2 list-none rounded-md border border-line p-3"
      data-testid="library-item"
      data-item-name={item.name}
    >
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          aria-label={`Include ${item.name}`}
          checked={item.include}
          disabled={busy}
          onChange={(event) =>
            editItem((current) => ({ ...current, include: event.target.checked }))
          }
        />
        <span className="text-sm font-medium">{item.name}</span>
        <span className="text-xs text-fg-muted">
          {ENTITY_KIND_NOUN[item.kind]} ·{' '}
          {item.existingId === null ? 'new sheet' : 'existing sheet'}
        </span>
      </div>
      {item.records.length > 1 || (item.existingId !== null && item.records.length > 0) ? (
        <p className="mt-1 mb-0 text-xs text-fg-subtle" data-testid="library-matches">
          {'Matched: '}
          {item.records.map((record) => `“${record.name}” (${record.fileName})`).join(', ')}
          {canSplit(item) ? (
            <>
              {' '}
              <button type="button" className={LINK} disabled={busy} onClick={() => split(item.id)}>
                Split
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      <div className="mt-2 flex flex-col gap-1.5 pl-6">
        {item.tag !== null && tagName !== '' ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={item.tag}
              disabled={off}
              onChange={(event) =>
                editItem((current) => ({ ...current, tag: event.target.checked }))
              }
            />
            {`Tag #${tagName}`}
          </label>
        ) : null}
        {item.fields.map((field, index) =>
          field.existing === null ? (
            <label key={field.field} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={field.include}
                disabled={off}
                onChange={(event) => setField(index, { include: event.target.checked })}
              />
              <span>
                <span className="font-medium">{fieldLabel(item, field)}: </span>
                <span className="whitespace-pre-wrap">{field.upload}</span>
              </span>
            </label>
          ) : (
            <fieldset
              key={field.field}
              className="m-0 rounded-md border border-warning p-2"
              data-testid="library-conflict"
              disabled={off}
            >
              <legend className="px-1 text-xs font-medium text-warning">
                {`${fieldLabel(item, field)}: conflict, pick one`}
              </legend>
              <div className="grid grid-cols-2 gap-2">
                {(['existing', 'upload'] as const).map((choice) => (
                  <label
                    key={choice}
                    className="flex items-start gap-2 rounded-md border border-line p-2 text-sm has-checked:border-accent"
                  >
                    <input
                      type="radio"
                      name={`${item.id}-${field.field}`}
                      className="mt-1"
                      checked={field.choice === choice}
                      onChange={() => setField(index, { choice })}
                    />
                    <span>
                      <span className="block text-xs text-fg-muted">
                        {choice === 'existing' ? 'Keep the sheet’s' : 'Use the upload’s'}
                      </span>
                      <span className="whitespace-pre-wrap">
                        {choice === 'existing' ? field.existing : field.upload}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )
        )}
        {item.details.length > 0 ? (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={item.includeDetails}
              disabled={off}
              onChange={(event) =>
                editItem((current) => ({ ...current, includeDetails: event.target.checked }))
              }
            />
            <span>
              <span className="font-medium">{`Add to ${detailsPlace}: `}</span>
              {item.details.map((detail) => (
                <span key={detail} className="block whitespace-pre-wrap text-fg-muted">
                  {detail}
                </span>
              ))}
            </span>
          </label>
        ) : null}
        {item.images.map((image) => (
          <label key={image.fileId} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={image.include}
              disabled={off}
              onChange={(event) =>
                editItem((current) => ({
                  ...current,
                  images: current.images.map((entry) =>
                    entry.fileId === image.fileId
                      ? { ...entry, include: event.target.checked }
                      : entry
                  )
                }))
              }
            />
            {`Use ${image.fileName} as the picture${image.replaces ? ' (replaces the current one)' : ''}`}
          </label>
        ))}
      </div>
    </li>
  )
}

function NotesCard({ review, busy }: { review: ContextReview; busy: boolean }): React.JSX.Element {
  const edit = useLibraryStore((s) => s.edit)
  return (
    <li
      className="m-0 mb-2 list-none rounded-md border border-line p-3"
      data-testid="library-notes"
    >
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          aria-label="Include Project notes"
          checked={review.notes.include}
          disabled={busy}
          onChange={(event) =>
            edit((r) => ({ ...r, notes: { ...r.notes, include: event.target.checked } }))
          }
        />
        <span className="text-sm font-medium">Project notes</span>
        <span className="text-xs text-fg-muted">
          World tab · {review.notes.existingId === null ? 'new page' : 'added to the page'}
        </span>
      </label>
      <div className="mt-2 pl-6">
        {review.notes.paragraphs.map((paragraph) => (
          <p key={paragraph} className="m-0 mb-1 text-sm whitespace-pre-wrap text-fg-muted">
            {paragraph}
          </p>
        ))}
      </div>
    </li>
  )
}
