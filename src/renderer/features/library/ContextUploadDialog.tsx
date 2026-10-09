import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  canSplit,
  reviewHasChanges,
  type ContextEstimate,
  type ContextReview,
  type ContextReviewEntity,
  type ContextReviewField
} from '@shared/contextLibrary'
import { categoryFieldLabel, categoryOf, type StoryCategory } from '@shared/categories'
import { entityTagName } from '@shared/entities'
import { itemAliases, REVIEW_CHAT_MESSAGE_MAX, REVIEW_NOTES_ID } from '@shared/reviewChat'
import { AiWaitText } from '@renderer/features/ai/AiWaitText'
import { AI_WAIT_CLASS, AI_WAIT_PHRASES } from '@renderer/features/ai/aiWaitPhrases'
import { RequestCost } from '@renderer/features/ai/RequestCost'
import { formatCount, formatUsd } from '@renderer/features/ai/usageFormat'
import { useCategoryStore } from '@renderer/features/entities/categoryStore'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { ReviewDeck } from '@renderer/features/review/ReviewDeck'
import type { ReviewDecision } from '@renderer/features/review/reviewDeckModel'
import { dialogs } from '@renderer/features/shell/dialogs/dialogStore'
import { useLibraryStore, type LibraryFlow } from './libraryStore'
import { categoryOfCard, decidedReview, UPLOAD_GROUPS, uploadReviewItems } from './uploadReview'

const BUTTON =
  'rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-60'
const PRIMARY =
  'rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-60'
const LINK = 'text-xs text-accent hover:underline disabled:opacity-60'

/**
 * The category of a review item (F-9.11): a proposed one of the review, the project's (as the
 * author renamed it), or the library's.
 */
function itemCategory(review: ContextReview, kind: string): StoryCategory {
  const proposed = review.categories.find((category) => category.id === kind)
  return proposed ?? categoryOf(kind, useCategoryStore.getState().categories)
}

const fieldLabel = (
  review: ContextReview,
  item: ContextReviewEntity,
  field: ContextReviewField
): string => categoryFieldLabel(itemCategory(review, item.kind), field.field)

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
 * review — since 2026-10-08 on the review deck, one card at a time: each proposed category, each
 * sheet to create or fill (its fields, each conflict with both values side by side, the matches
 * merged across files with Split, its tag and picture), and Project notes. A accepts, S skips
 * for later, E opens the card's finer choices (which fields, details, pictures, the tag). Nothing
 * starts accepted and nothing is written until Apply (or the last card, with nothing skipped);
 * Cancel and Escape drop it all.
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
    // The review's deck takes the focus itself, so its keys work at once.
    if (flow.stage !== 'review') panel.current?.focus()
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
        className={`flex max-h-[85vh] overflow-y-auto max-w-[95vw] flex-col rounded-lg border border-line bg-surface-raised shadow-panel outline-none ${flow.stage === 'review' ? 'w-[860px]' : 'w-[520px]'}`}
      >
        <div className="shrink-0 border-b border-line px-5 pt-4 pb-3">
          <h2 id={titleId} className="m-0 text-base font-semibold">
            {flow.stage === 'review' ? 'Review before it lands' : 'Sort into the story bible'}
          </h2>
          {flow.stage === 'review' ? (
            <>
              <p className="mt-1 mb-0 text-sm text-fg-muted">
                One card at a time: A accepts, S skips, E picks the details. Nothing is written
                until you apply.
              </p>
              <p className="mt-1 mb-0 text-xs text-fg-subtle" data-testid="library-review-summary">
                {summaryLine(flow.review)}
              </p>
            </>
          ) : null}
        </div>
        {flow.stage === 'review' ? (
          <Review review={flow.review} busy={flow.busy} decisions={flow.decisions} />
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
          <p className={`m-0 ${AI_WAIT_CLASS}`} role="status">
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
          flow.progress === null ? (
            <AiWaitText
              phrases={[
                `Reading ${formatCount(flow.estimate.chunks, 'request')}…`,
                ...AI_WAIT_PHRASES.contextSort.slice(1)
              ]}
              testId="library-progress"
            />
          ) : (
            <p
              className={`m-0 tabular-nums ${AI_WAIT_CLASS}`}
              role="status"
              data-testid="library-progress"
            >
              {`Request ${flow.progress.done} of ${flow.progress.total} · ${formatUsd(flow.progress.costUsd)} so far`}
            </p>
          )
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

function Review({
  review,
  busy,
  decisions
}: {
  review: ContextReview
  busy: boolean
  decisions: Readonly<Record<string, ReviewDecision>>
}): React.JSX.Element {
  const discard = useLibraryStore((s) => s.discard)
  const apply = useLibraryStore((s) => s.apply)
  const decide = useLibraryStore((s) => s.decide)
  const asking = useLibraryStore((s) => s.chat.requestId !== null)
  const [editing, setEditing] = useState<string | null>(null)
  const items = useMemo(() => uploadReviewItems(review, decisions), [review, decisions])
  const existing = useEntityStore((s) => s.byId)
  const writes = reviewHasChanges(decidedReview(review, decisions, Object.values(existing)))
  const onEdit = useCallback(
    (id: string) => {
      // A proposed category's one adjustable part is its name; a sheet shows its finer choices.
      const categoryId = categoryOfCard(id)
      if (categoryId === null) {
        setEditing((now) => (now === id ? null : id))
        return
      }
      const category = review.categories.find((c) => c.id === categoryId)
      if (category !== undefined) void renameProposedCategory(category.id, category.name)
    },
    [review.categories]
  )
  return (
    <>
      <ReviewDeck
        label="Upload review"
        items={items}
        groups={UPLOAD_GROUPS}
        renderCard={(id) => (
          <ReviewCard review={review} id={id} busy={busy} editing={editing === id} />
        )}
        onDecide={(ids, decision) => {
          setEditing(null)
          decide(ids, decision)
        }}
        onEdit={onEdit}
        canEdit={(id) => id !== REVIEW_NOTES_ID}
        apply={{
          label: (n) => `Apply ${n} accepted`,
          onApply: () => void apply(),
          disabled: asking || !writes
        }}
        applyOnFinish
        busy={busy}
        autoFocus
        footer={
          <span className="tabular-nums" data-testid="library-review-cost">
            <RequestCost
              request={{
                model: review.model,
                costUsd: review.costUsd,
                usage: review.usage,
                cached: false
              }}
            />
          </span>
        }
        actions={
          <button
            type="button"
            data-testid="library-discard"
            disabled={busy}
            onClick={discard}
            className={BUTTON}
          >
            Cancel
          </button>
        }
      />
      <ReviewChat busy={busy} />
    </>
  )
}

/** One card of the deck: a proposed category, a sheet, or Project notes. */
function ReviewCard({
  review,
  id,
  busy,
  editing
}: {
  review: ContextReview
  id: string
  busy: boolean
  editing: boolean
}): React.JSX.Element | null {
  const changed = useLibraryStore((s) => s.chat.changed.includes(id))
  const categoryId = categoryOfCard(id)
  if (categoryId !== null) {
    const category = review.categories.find((c) => c.id === categoryId)
    return category === undefined ? null : (
      <CategoryCard review={review} category={category} busy={busy} />
    )
  }
  if (id === REVIEW_NOTES_ID) return <NotesCard review={review} changed={changed} />
  const item = review.entities.find((entity) => entity.id === id)
  return item === undefined ? null : (
    <EntityCard review={review} item={item} busy={busy} changed={changed} editing={editing} />
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

/** The badge on a card the last chat change touched (F-9.9). */
function ChangedBadge(): React.JSX.Element {
  return (
    <span
      className="rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-fg"
      data-testid="library-item-changed"
    >
      Changed
    </span>
  )
}

/**
 * A new category the AI proposes (F-9.11): its fields and how many sheets it would hold. Accept
 * creates it at Apply; Rename (E) changes its name first; Decline (or leaving it unaccepted at
 * Apply) files its sheets under World, their fields World lacks going to their details.
 */
/** Asks for a proposed category's new name (the card's Rename…, and E on its card). */
async function renameProposedCategory(categoryId: string, current: string): Promise<void> {
  const taken = useCategoryStore.getState().categories.map((other) => other.name.toLowerCase())
  const name = await dialogs.prompt({
    title: 'Rename the proposed category',
    initialValue: current,
    confirmLabel: 'Rename',
    validate: (value) =>
      value.trim() === ''
        ? 'A category needs a name.'
        : taken.includes(value.trim().toLowerCase())
          ? 'The story bible already has a category of that name.'
          : null
  })
  if (name !== null) useLibraryStore.getState().renameCategory(categoryId, name)
}

function CategoryCard({
  review,
  category,
  busy
}: {
  review: ContextReview
  category: ContextReview['categories'][number]
  busy: boolean
}): React.JSX.Element {
  const declineCategory = useLibraryStore((s) => s.declineCategory)
  const count = review.entities.filter((item) => item.kind === category.id).length
  const fields = category.fields.filter((field) => field.id !== 'notes')
  return (
    <div className="flex flex-col gap-2" data-testid="library-proposed-category">
      <p className="m-0 text-base font-medium">Proposed new category: {category.name}</p>
      <p className="m-0 text-sm text-fg-muted">
        {formatCount(count, 'sheet')}
        {fields.length > 0 ? ` · fields: ${fields.map((f) => f.label).join(', ')}` : ''}
      </p>
      <p className="m-0 text-xs text-fg-muted">
        Accept creates it in the story bible. Decline, or leaving it unaccepted, files its sheets
        under World.
      </p>
      <div className="flex gap-3">
        <button
          type="button"
          className={LINK}
          disabled={busy}
          onClick={() => void renameProposedCategory(category.id, category.name)}
        >
          Rename…
        </button>
        <button
          type="button"
          className={LINK}
          disabled={busy}
          onClick={() => declineCategory(category.id)}
        >
          Decline
        </button>
      </div>
    </div>
  )
}

function EntityCard({
  review,
  item,
  busy,
  changed,
  editing
}: {
  review: ContextReview
  item: ContextReviewEntity
  busy: boolean
  changed: boolean
  editing: boolean
}): React.JSX.Element {
  const aliases = itemAliases(item)
  const editItem = useItemEdit(item.id)
  const split = useLibraryStore((s) => s.split)
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
  const fills = item.fields.filter((field) => field.existing === null)
  const conflicts = item.fields.filter((field) => field.existing !== null)
  return (
    <div
      className="flex flex-col gap-2"
      data-testid="library-item"
      data-item-name={item.name}
      data-changed={changed ? 'true' : undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base font-medium">{item.name}</span>
        <span className="text-xs text-fg-muted">
          {itemCategory(review, item.kind).noun} ·{' '}
          {item.existingId === null ? 'new sheet' : 'existing sheet'}
        </span>
        {changed ? <ChangedBadge /> : null}
      </div>
      {aliases.length > 0 ? (
        <p className="m-0 text-xs text-fg-muted" data-testid="library-item-aliases">
          {`Also called: ${aliases.join(', ')}`}
        </p>
      ) : null}
      {item.records.length > 1 || (item.existingId !== null && item.records.length > 0) ? (
        <p className="m-0 text-xs text-fg-subtle" data-testid="library-matches">
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
      <div className="flex flex-col gap-1.5">
        {item.tag !== null && tagName !== '' ? (
          editing ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={item.tag}
                disabled={busy}
                onChange={(event) =>
                  editItem((current) => ({ ...current, tag: event.target.checked }))
                }
              />
              {`Tag #${tagName}`}
            </label>
          ) : item.tag ? (
            <p className="m-0 text-sm">{`Tag #${tagName}`}</p>
          ) : null
        ) : null}
        {fills.map((field) => {
          const index = item.fields.indexOf(field)
          return editing ? (
            <label key={field.field} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={field.include}
                disabled={busy}
                onChange={(event) => setField(index, { include: event.target.checked })}
              />
              <span>
                <span className="font-medium">{fieldLabel(review, item, field)}: </span>
                <span className="whitespace-pre-wrap">{field.upload}</span>
              </span>
            </label>
          ) : field.include ? (
            <p key={field.field} className="m-0 text-sm">
              <span className="font-medium">{fieldLabel(review, item, field)}: </span>
              <ins className="whitespace-pre-wrap text-accent no-underline">{field.upload}</ins>
            </p>
          ) : null
        })}
        {conflicts.map((field) => {
          const index = item.fields.indexOf(field)
          return (
            <fieldset
              key={field.field}
              className="m-0 rounded-md border border-warning p-2"
              data-testid="library-conflict"
              disabled={busy}
            >
              <legend className="px-1 text-xs font-medium text-warning">
                {`${fieldLabel(review, item, field)}: conflict, pick one`}
              </legend>
              <div className="grid grid-cols-1 gap-2 @md:grid-cols-2">
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
        })}
        {item.details.length > 0 && (editing || item.includeDetails) ? (
          <label className="flex items-start gap-2 text-sm">
            {editing ? (
              <input
                type="checkbox"
                className="mt-1"
                checked={item.includeDetails}
                disabled={busy}
                onChange={(event) =>
                  editItem((current) => ({ ...current, includeDetails: event.target.checked }))
                }
              />
            ) : null}
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
        {item.images.map((image) =>
          editing ? (
            <label key={image.fileId} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={image.include}
                disabled={busy}
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
          ) : image.include ? (
            <p key={image.fileId} className="m-0 text-sm">
              {`Picture: ${image.fileName}${image.replaces ? ' (replaces the current one)' : ''}`}
            </p>
          ) : null
        )}
      </div>
      {!editing &&
      (item.fields.some((field) => field.existing === null && !field.include) ||
        item.images.some((image) => !image.include) ||
        (item.details.length > 0 && !item.includeDetails)) ? (
        <p className="m-0 text-xs text-fg-subtle">Some parts are left out; E shows them.</p>
      ) : null}
    </div>
  )
}

function NotesCard({
  review,
  changed
}: {
  review: ContextReview
  changed: boolean
}): React.JSX.Element {
  return (
    <div
      className="flex flex-col gap-2"
      data-testid="library-notes"
      data-changed={changed ? 'true' : undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base font-medium">Project notes</span>
        <span className="text-xs text-fg-muted">
          World tab · {review.notes.existingId === null ? 'new page' : 'added to the page'}
        </span>
        {changed ? <ChangedBadge /> : null}
      </div>
      {review.notes.paragraphs.map((paragraph) => (
        <p key={paragraph} className="m-0 text-sm whitespace-pre-wrap text-fg-muted">
          {paragraph}
        </p>
      ))}
    </div>
  )
}

/**
 * The review chat (F-9.9): a message box under the review. The author says what to change
 * ("merge Rynna and High Crown Falsire", "Kael is a place"); the AI's operations land on the
 * review at once, each listed under its reply (skipped ones with why), the cards they touched
 * marked Changed, and Undo puts the review back. Nothing is written until Apply.
 */
function ReviewChat({ busy }: { busy: boolean }): React.JSX.Element {
  const chat = useLibraryStore((s) => s.chat)
  const send = useLibraryStore((s) => s.sendReviewChat)
  const stop = useLibraryStore((s) => s.cancelReviewChat)
  const undo = useLibraryStore((s) => s.undoReviewChat)
  const [draft, setDraft] = useState('')
  const log = useRef<HTMLOListElement>(null)
  const asking = chat.requestId !== null
  const inputId = useId()

  useEffect(() => {
    const el = log.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.entries.length])

  const submit = (): void => {
    if (asking || busy || draft.trim() === '') return
    const message = draft
    setDraft('')
    void send(message)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    } else if (event.key === 'Escape' && asking) {
      // Escape stops the answer under way rather than closing the whole review.
      event.preventDefault()
      event.stopPropagation()
      stop()
    }
  }

  return (
    <div className="shrink-0 border-t border-line px-5 pt-2 pb-3" data-testid="review-chat">
      {chat.entries.length > 0 ? (
        <ol
          ref={log}
          className="m-0 mb-2 max-h-40 list-none overflow-y-auto p-0 text-sm"
          aria-live="polite"
          data-testid="review-chat-log"
        >
          {chat.entries.map((entry) => (
            <li
              key={entry.id}
              className="m-0 mb-1.5"
              data-testid="review-chat-entry"
              data-role={entry.role}
            >
              <span
                className={
                  entry.role === 'user'
                    ? 'font-medium'
                    : entry.failed
                      ? 'text-danger'
                      : 'text-fg-muted'
                }
              >
                {entry.role === 'user' ? 'You: ' : 'AI: '}
                {entry.text}
              </span>
              {entry.changes.length > 0 ? (
                <ul className="m-0 mt-0.5 list-disc pl-5 text-xs">
                  {entry.changes.map((change, i) => (
                    <li
                      key={i}
                      className={change.skipped ? 'text-fg-subtle' : ''}
                      data-testid="review-chat-change"
                      data-skipped={change.skipped ? 'true' : undefined}
                    >
                      {change.text}
                    </li>
                  ))}
                </ul>
              ) : null}
              {entry.request !== null ? (
                <span className="block text-xs text-fg-subtle tabular-nums">
                  <RequestCost request={entry.request} />
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      <label htmlFor={inputId} className="mb-1 block text-xs text-fg-muted">
        Tell the AI what to change. You see every change before you apply.
      </label>
      <div className="flex items-end gap-2">
        <textarea
          id={inputId}
          rows={2}
          value={draft}
          maxLength={REVIEW_CHAT_MESSAGE_MAX}
          disabled={busy}
          placeholder="“Merge Rynna and High Crown Falsire”, “Kael is a place, not a character”…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          data-testid="review-chat-input"
          className="min-h-0 flex-1 resize-none rounded-md border border-line bg-surface px-2 py-1.5 text-sm outline-none focus:border-accent"
        />
        {chat.undo !== null && !asking ? (
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={undo}
            data-testid="review-chat-undo"
          >
            Undo
          </button>
        ) : null}
        {asking ? (
          <button type="button" className={BUTTON} onClick={stop} data-testid="review-chat-stop">
            Stop
          </button>
        ) : (
          <button
            type="button"
            className={BUTTON}
            disabled={busy || draft.trim() === ''}
            onClick={submit}
            data-testid="review-chat-send"
          >
            Send
          </button>
        )}
      </div>
      {asking ? (
        <p className="m-0 mt-1 text-xs text-fg-muted" role="status">
          The AI is changing the review…
        </p>
      ) : null}
    </div>
  )
}
