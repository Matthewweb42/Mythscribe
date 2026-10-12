import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { categoryOf } from '@shared/categories'
import { type FilingItem, type FilingReview } from '@shared/filing'
import { REVIEW_CHAT_MESSAGE_MAX } from '@shared/reviewChat'
import { AI_WAIT_CLASS } from '@renderer/features/ai/aiWaitPhrases'
import { RequestCost } from '@renderer/features/ai/RequestCost'
import { formatCount, formatUsd } from '@renderer/features/ai/usageFormat'
import { useCategoryStore } from '@renderer/features/entities/categoryStore'
import {
  categoryOfCard,
  filingReviewItems,
  FILING_GROUPS
} from '@renderer/features/library/uploadReview'
import { ReviewDeck } from '@renderer/features/review/ReviewDeck'
import { useFilingStore, type FilingFlow } from './filingStore'
import { filingEstimateLine, filingSummaryLine } from './filingView'

const BUTTON =
  'rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-60'
const PRIMARY =
  'rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-60'

/**
 * Filing a Research page into Pinned (F-16.9): the estimate to confirm, the pass with Stop, and
 * the review on the deck (New records, Additions, Conflicts, New categories; everything starts
 * accepted, S skips a card) with the review chat under it. A conflict keeps Pinned's line unless
 * the author picks the upload's. Nothing is written until Apply. Escape stops the pass, or closes
 * what is open.
 */
export function FilingDialog(): React.JSX.Element | null {
  const flow = useFilingStore((s) => s.flow)
  if (flow === null) return null
  return <Dialog flow={flow} />
}

function Dialog({ flow }: { flow: FilingFlow }): React.JSX.Element {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const discard = useFilingStore((s) => s.discard)
  const cancelRun = useFilingStore((s) => s.cancelRun)
  const review = flow.stage === 'review'

  useEffect(() => {
    if (!review) panel.current?.focus()
  }, [review])

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
        data-testid="filing-dialog"
        onKeyDown={onKeyDown}
        className={`flex max-h-[88vh] ${review ? 'h-[88vh] w-[760px]' : 'w-[520px]'} max-w-[95vw] flex-col rounded-lg border border-line bg-surface-raised shadow-panel outline-none`}
      >
        <div className="shrink-0 border-b border-line px-5 pt-4 pb-3">
          <h2 id={titleId} className="m-0 text-base font-semibold">
            {review ? 'File into sheets: review' : 'File into sheets'}
          </h2>
          {flow.stage === 'review' ? (
            <p className="mt-1 mb-0 text-xs text-fg-muted" data-testid="filing-summary">
              {`From “${flow.review.docTitle}”: ${filingSummaryLine(flow.review)}`}
            </p>
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

function Status({ flow }: { flow: Exclude<FilingFlow, { stage: 'review' }> }): React.JSX.Element {
  const discard = useFilingStore((s) => s.discard)
  const confirm = useFilingStore((s) => s.confirm)
  const cancelRun = useFilingStore((s) => s.cancelRun)
  return (
    <>
      <div className="flex-1 overflow-y-auto px-5 py-4 text-sm">
        {flow.stage === 'estimating' ? (
          <p className={`m-0 ${AI_WAIT_CLASS}`} role="status">
            Working out what filing would cost…
          </p>
        ) : flow.stage === 'confirm' ? (
          <>
            <p className="m-0">
              The AI reads this page once and proposes lines for your records’ Pinned notes, each
              with the words it came from. What fits no record stays on the page. You review
              everything before it lands, and filing runs once.
            </p>
            <p className="mt-2 mb-0 text-fg-muted tabular-nums" data-testid="filing-estimate">
              {filingEstimateLine(flow.estimate)}
            </p>
          </>
        ) : flow.stage === 'running' ? (
          <p
            className={`m-0 tabular-nums ${AI_WAIT_CLASS}`}
            role="status"
            data-testid="filing-progress"
          >
            {flow.progress === null
              ? `Reading ${formatCount(flow.estimate.chunks, 'request')}…`
              : `Request ${flow.progress.done} of ${flow.progress.total} · ${formatUsd(flow.progress.costUsd)} so far`}
          </p>
        ) : (
          <p className="m-0 text-danger" role="alert" data-testid="filing-error">
            {`${flow.message} ${flow.nextStep}`.trim()}
          </p>
        )}
      </div>
      <div className="flex shrink-0 justify-end gap-2 border-t border-line px-5 py-3">
        {flow.stage === 'running' ? (
          <button type="button" data-testid="filing-stop" onClick={cancelRun} className={BUTTON}>
            Stop
          </button>
        ) : (
          <button type="button" data-testid="filing-cancel" onClick={discard} className={BUTTON}>
            {flow.stage === 'failed' ? 'Close' : 'Cancel'}
          </button>
        )}
        {flow.stage === 'confirm' ? (
          <button
            type="button"
            data-testid="filing-confirm"
            onClick={() => void confirm()}
            className={PRIMARY}
          >
            File with AI
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
  review: FilingReview
  busy: boolean
  decisions: FilingFlowDecisions
}): React.JSX.Element {
  const discard = useFilingStore((s) => s.discard)
  const apply = useFilingStore((s) => s.apply)
  const decide = useFilingStore((s) => s.decide)
  const asking = useFilingStore((s) => s.chat.requestId !== null)
  const items = useMemo(() => filingReviewItems(review, decisions), [review, decisions])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        <ReviewDeck
          label="Filing review"
          items={items}
          groups={FILING_GROUPS}
          renderCard={(id) => <FilingCard review={review} id={id} busy={busy} />}
          onDecide={(ids, decision) => decide(ids, decision)}
          apply={{
            label: (n) => `Apply ${n} accepted`,
            onApply: () => void apply(),
            disabled: asking
          }}
          stepEvery
          busy={busy}
          compact
          autoFocus
          footer={
            <span className="tabular-nums" data-testid="filing-review-cost">
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
              data-testid="filing-discard"
              disabled={busy}
              onClick={discard}
              className={BUTTON}
            >
              Cancel
            </button>
          }
          testId="filing-deck"
        />
      </div>
      <FilingChat busy={busy} />
    </div>
  )
}

type FilingFlowDecisions = Extract<FilingFlow, { stage: 'review' }>['decisions']

function FilingCard({
  review,
  id,
  busy
}: {
  review: FilingReview
  id: string
  busy: boolean
}): React.JSX.Element | null {
  const categories = useCategoryStore((s) => s.categories)
  const categoryId = categoryOfCard(id)
  if (categoryId !== null) {
    const category = review.categories.find((each) => each.id === categoryId)
    if (category === undefined) return null
    return (
      <div className="text-sm" data-testid="filing-card">
        <h3 className="m-0 text-base font-medium">{category.name}</h3>
        <p className="mt-1 mb-0 text-fg-muted">
          A new category for the new records filed under it. Skip it and they go to World.
        </p>
      </div>
    )
  }
  const item = review.items.find((each) => each.id === id)
  if (item === undefined) return null
  const proposed = review.categories.find((each) => each.id === item.categoryId)
  const categoryName = (proposed ?? categoryOf(item.categoryId, categories)).name
  return <ItemCard item={item} categoryName={categoryName} busy={busy} />
}

function ItemCard({
  item,
  categoryName,
  busy
}: {
  item: FilingItem
  categoryName: string
  busy: boolean
}): React.JSX.Element {
  const pick = useFilingStore((s) => s.pickLine)
  const changed = useFilingStore((s) => s.chat.changed.includes(item.id))
  return (
    <div className="text-sm" data-testid="filing-card">
      <h3 className="m-0 text-base font-medium">
        {item.name}
        {changed ? <span className="ml-2 text-xs font-normal text-accent">Changed</span> : null}
      </h3>
      <p className="mt-0.5 mb-0 text-xs text-fg-muted">
        {item.recordId === null ? `New record · ${categoryName}` : `Adds to ${item.name}`}
      </p>
      {item.sameAs !== null ? (
        <p className="mt-2 mb-0 text-xs text-warning" data-testid="filing-same-as">
          {`Filed as “${item.sameAs.given}”: same as ${item.name}? Skip this card if not.`}
        </p>
      ) : null}
      {item.aliases.length > 0 ? (
        <p className="mt-2 mb-0 text-xs">
          <span className="text-fg-muted">New nicknames: </span>
          {item.aliases.join(', ')}
        </p>
      ) : null}
      {item.image !== null ? (
        <p className="mt-1 mb-0 text-xs">
          <span className="text-fg-muted">Picture: </span>
          {item.image.name}
        </p>
      ) : null}
      <ul className="m-0 mt-2 list-none space-y-2 p-0">
        {item.lines.map((line) => (
          <li
            key={line.id}
            className="rounded-md border border-line px-2 py-1.5"
            data-testid="filing-line"
          >
            {line.kind === 'conflict' && line.replaces !== null ? (
              <fieldset className="m-0 border-0 p-0" disabled={busy}>
                <legend className="text-xs text-fg-muted">Pinned and the upload disagree</legend>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`${item.id}:${line.id}`}
                    checked={!line.use}
                    onChange={() => pick(item.id, line.id, false)}
                  />
                  <span>Keep Pinned’s: {line.replaces.text}</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`${item.id}:${line.id}`}
                    checked={line.use}
                    onChange={() => pick(item.id, line.id, true)}
                  />
                  <span>Use the upload’s: {line.text}</span>
                </label>
              </fieldset>
            ) : (
              <p className="m-0">
                {line.text}
                {line.kind === 'update' && line.replaces !== null ? (
                  <span className="ml-1 text-xs text-fg-muted">{`(replaces “${line.replaces.text}”)`}</span>
                ) : null}
              </p>
            )}
            <p className="mt-0.5 mb-0 text-xs text-fg-subtle">{`¶${line.para + 1}: “${line.quote}”`}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}

function FilingChat({ busy }: { busy: boolean }): React.JSX.Element {
  const chat = useFilingStore((s) => s.chat)
  const send = useFilingStore((s) => s.sendChat)
  const cancel = useFilingStore((s) => s.cancelChat)
  const undo = useFilingStore((s) => s.undoChat)
  const [draft, setDraft] = useState('')
  const asking = chat.requestId !== null
  const submit = (): void => {
    const text = draft.trim()
    if (text === '' || asking || busy) return
    setDraft('')
    void send(text)
  }
  return (
    <div className="shrink-0 border-t border-line px-5 py-3" data-testid="filing-chat">
      {chat.entries.length > 0 ? (
        <ul className="m-0 mb-2 max-h-32 list-none space-y-1 overflow-y-auto p-0 text-xs">
          {chat.entries.map((entry) => (
            <li
              key={entry.id}
              className={
                entry.failed ? 'text-danger' : entry.role === 'user' ? 'text-fg' : 'text-fg-muted'
              }
            >
              {entry.text}
              {entry.changes.map((change) => (
                <span
                  key={change.text}
                  className={`block pl-3 ${change.skipped ? 'text-fg-subtle' : ''}`}
                >
                  {change.text}
                </span>
              ))}
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <input
          type="text"
          aria-label="Tell the AI what to change"
          placeholder="Merge the two wights, or leave Mara out…"
          value={draft}
          maxLength={REVIEW_CHAT_MESSAGE_MAX}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-sm"
        />
        {asking ? (
          <button type="button" onClick={cancel} className={BUTTON}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={busy || draft.trim() === ''} className={BUTTON}>
            Send
          </button>
        )}
        <button
          type="button"
          disabled={chat.undo === null || asking || busy}
          onClick={undo}
          className={BUTTON}
        >
          Undo change
        </button>
      </form>
    </div>
  )
}
