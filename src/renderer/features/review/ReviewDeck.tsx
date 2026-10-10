import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import {
  deckCounts,
  deckOrder,
  groupOpenIds,
  groupStats,
  inFilter,
  neighbour,
  nextOpen,
  withDecision,
  type ReviewDecision,
  type ReviewDeckGroup,
  type ReviewDeckItem,
  type ReviewFilter
} from './reviewDeckModel'

const BUTTON =
  'inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-50'
const PRIMARY =
  'inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50'
const LINK = 'text-xs text-accent hover:underline disabled:opacity-50 disabled:no-underline'
const KBD = 'rounded border border-current/40 px-1 font-mono text-[0.7rem] leading-4 opacity-80'

const DECISION_LABEL: Record<Exclude<ReviewDecision, 'pending'>, string> = {
  accepted: 'Accepted',
  skipped: 'Skipped',
  rejected: 'Rejected'
}

export interface ReviewDeckApply {
  /** The button's text for this many accepted items ("Apply 3 accepted"). */
  label: (accepted: number) => string
  onApply: () => void
  disabled?: boolean
}

export interface ReviewDeckProps {
  /** The deck's accessible name ("Organise changes"). */
  label: string
  items: readonly ReviewDeckItem[]
  groups: readonly ReviewDeckGroup[]
  /** The card body of one item: what, why, before → after (and the edit form while editing). */
  renderCard: (id: string) => ReactNode
  /** Records a decision for items (one, or a group's). The deck moves on by itself. */
  onDecide: (ids: string[], decision: ReviewDecision) => void
  /** E: adjust the item before accepting (the screen shows its edit form); no Edit without it. */
  onEdit?: (id: string) => void
  /** Whether the item has anything to adjust; every item when absent. */
  canEdit?: (id: string) => boolean
  /** R: reject outright (edit passes); without it Skip is the only way past an item. */
  reject?: boolean
  /** The Skip button's word ("Skip", or "Later" where skipping keeps the item for later). */
  skipLabel?: string
  /** The Accept button's word ("Accept"; "Done" on the To do list, F-9.16). */
  acceptLabel?: string
  /** The Reject button's word ("Reject"; "Dismiss" on the To do list, F-9.16). */
  rejectLabel?: string
  /** The Edit button's word ("Edit"; "Write a line" on the To do list, F-9.16). */
  editLabel?: string
  /** Offer "Accept group" (the default); off where each item needs its own look (the To do list). */
  groupAccept?: boolean
  /** The footer's Apply button; none where accepting applies at once (edit passes). */
  apply?: ReviewDeckApply
  /** Apply by itself once every item is decided and none was skipped. */
  applyOnFinish?: boolean
  /**
   * Told once every item is decided, skipped ones included (Organise applies and closes,
   * 2026-10-10); takes the place of `applyOnFinish`.
   */
  onFinish?: () => void
  /**
   * The cards start decided (the upload review: everything starts accepted, 2026-10-10), so the
   * deck steps through every card in order, not only the waiting ones: a decision moves to the
   * next card, the progress is how far along the author is, and the end (with `applyOnFinish`)
   * comes after the last card.
   */
  stepEvery?: boolean
  /** Told whenever the item on show changes (edit passes jump the editor to it). */
  onCurrent?: (id: string | null) => void
  /** While true, nothing can be decided (a write is under way). */
  busy?: boolean
  /** Always show the groups as a dropdown (a strip above the editor); otherwise only when narrow. */
  compact?: boolean
  /** The item to show first (a deck shown again where the author left it); the first waiting otherwise. */
  initialId?: string | null
  /** Focus the deck when it mounts, so the keys work at once. */
  autoFocus?: boolean
  /** Left of the footer (the cost line). */
  footer?: ReactNode
  /** Buttons of the footer before Apply (Close). */
  actions?: ReactNode
  testId?: string
}

/** Input types that are not text: a key on a checkbox or a radio still decides. */
const NOT_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'])

/** Whether a key event comes from a field the author types in, where letters are text. */
function typing(event: KeyboardEvent): boolean {
  const target = event.target
  if (!(target instanceof HTMLElement)) return false
  if (target instanceof HTMLInputElement) return !NOT_TEXT.has(target.type)
  return (
    target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  )
}

/**
 * The review deck (2026-10-08, the author's "one decision at a time"): one focused card per
 * change with big Accept / Skip / Edit (and Reject where it applies) buttons and their keys
 * (A / S / E / R, ← and → to step), a progress bar, and a groups rail to jump around with
 * "Accept group". Skipped items stay reviewable (the Skipped filter). Nothing is applied by the
 * deck itself: decisions go to the screen's store, and Apply (or reaching the end with nothing
 * skipped, when `applyOnFinish`) applies the accepted ones. In a narrow window, or `compact`,
 * the rail becomes a dropdown. One component for Organise, the upload review, and edit passes.
 */
export function ReviewDeck(props: ReviewDeckProps): React.JSX.Element {
  const { items, groups, onDecide, busy = false, apply, onCurrent } = props
  const stepEvery = props.stepEvery === true
  const root = useRef<HTMLDivElement>(null)
  const ordered = useMemo(() => deckOrder(items, groups), [items, groups])
  const [filter, setFilter] = useState<ReviewFilter>('all')
  // undefined: the first item still waiting; null: the end (everything reviewed).
  const [currentId, setCurrentId] = useState<string | null | undefined>(
    props.initialId ?? undefined
  )
  const current = ordered.find((item) => item.id === currentId) ?? null
  // Not chosen yet: the first one still waiting, or the first of all when none waits (a plan
  // that only describes, an Auto run that applied everything). An item that left the list
  // (merged away, re-planned by the chat): the first one still waiting.
  const shownId =
    current !== null
      ? current.id
      : currentId === null
        ? null
        : (nextOpen(ordered, null, filter) ??
          (currentId === undefined ? (ordered[0]?.id ?? null) : null))
  const shown = ordered.find((item) => item.id === shownId) ?? null
  const counts = deckCounts(items)
  const stats = groupStats(items, groups)
  const group = shown === null ? null : (groups.find((g) => g.id === shown.group) ?? null)
  const inGroup = shown === null ? [] : ordered.filter((item) => item.group === shown.group)
  const position = shown === null ? 0 : inGroup.findIndex((item) => item.id === shown.id) + 1
  const groupOpen = shown === null ? [] : groupOpenIds(items, shown.group)

  const autoFocus = props.autoFocus === true
  useEffect(() => {
    if (autoFocus) root.current?.focus()
  }, [autoFocus])

  useEffect(() => {
    onCurrent?.(shownId)
  }, [shownId, onCurrent])

  // A decision made from inside the card (after ticking a box) unmounts the card and drops the
  // focus to the page: take it back, so the keys keep working on the next card.
  useEffect(() => {
    const active = document.activeElement
    if (active === null || active === document.body) root.current?.focus({ preventScroll: true })
  }, [shownId])

  const go = (id: string | null): void => setCurrentId(id)

  const decide = (ids: string[], decision: ReviewDecision): void => {
    if (busy || ids.length === 0) return
    const after = deckOrder(withDecision(items, ids, decision), groups)
    onDecide(ids, decision)
    const from = shown?.id ?? null
    const moves = from !== null && ids.includes(from)
    let next: string | null = null
    if (moves) {
      next =
        stepEvery && filter === 'all'
          ? neighbour(after, from, 1, 'all')
          : nextOpen(after, from, filter)
      if (next === null && filter === 'skipped') {
        setFilter('all')
        next = nextOpen(after, from, 'all')
      }
      go(next)
    }
    const done = deckCounts(after)
    const finished = stepEvery ? moves && next === null : done.open === 0
    if (props.onFinish !== undefined) {
      if (finished) props.onFinish()
      return
    }
    if (props.applyOnFinish === true && apply !== undefined && apply.disabled !== true) {
      if (finished && done.skipped === 0 && done.accepted > 0) apply.onApply()
    }
  }

  const step = (direction: -1 | 1): void => {
    const next = neighbour(ordered, shown?.id ?? null, direction, filter)
    if (next !== null) go(next)
  }

  const jumpToGroup = (groupId: string): void => {
    setFilter('all')
    const mine = ordered.filter((item) => item.group === groupId)
    go(nextOpen(mine, null, 'all') ?? mine[0]?.id ?? null)
  }

  const showSkipped = (): void => {
    if (filter === 'skipped') {
      setFilter('all')
      return
    }
    const first = ordered.find((item) => inFilter(item, 'skipped'))
    if (first === undefined) return
    setFilter('skipped')
    go(first.id)
  }

  const decidable = shown !== null && shown.settled !== true
  const editable = decidable && props.onEdit !== undefined && (props.canEdit?.(shown.id) ?? true)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.ctrlKey || event.metaKey || event.altKey || typing(event)) return
    const key = event.key.toLowerCase()
    let handled = true
    if (key === 'arrowleft') step(-1)
    else if (key === 'arrowright') step(1)
    else if (!decidable || shown === null) handled = false
    else if (key === 'a') decide([shown.id], 'accepted')
    else if (key === 's') decide([shown.id], 'skipped')
    else if (key === 'r' && props.reject === true) decide([shown.id], 'rejected')
    else if (key === 'e' && editable && !busy) props.onEdit?.(shown.id)
    else handled = false
    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  // Stepping through every card, the progress is the cards passed; otherwise the ones decided.
  const reviewed = !stepEvery
    ? counts.reviewed
    : shown === null
      ? counts.total
      : ordered.findIndex((item) => item.id === shown.id)
  const progress = counts.total === 0 ? 0 : Math.round((reviewed / counts.total) * 100)
  const progressBar = (
    <div
      role="progressbar"
      aria-label="Reviewed"
      aria-valuemin={0}
      aria-valuemax={counts.total}
      aria-valuenow={reviewed}
      aria-valuetext={`${reviewed} of ${counts.total} reviewed`}
      data-testid="review-progress"
      className="flex items-center gap-2 text-xs text-fg-muted tabular-nums"
    >
      <span className="h-1.5 min-w-12 flex-1 overflow-hidden rounded-full bg-surface">
        <span className="block h-full rounded-full bg-accent" style={{ width: `${progress}%` }} />
      </span>
      <span>{`${progress}%`}</span>
    </div>
  )

  const skippedToggle =
    counts.skipped > 0 || filter === 'skipped' ? (
      <button
        type="button"
        className={LINK}
        aria-pressed={filter === 'skipped'}
        data-testid="review-skipped-filter"
        onClick={showSkipped}
      >
        {filter === 'skipped' ? 'Show all' : `Skipped (${counts.skipped})`}
      </button>
    ) : null

  const acceptGroup =
    shown !== null && group !== null && props.groupAccept !== false ? (
      <button
        type="button"
        className={LINK}
        disabled={busy || groupOpen.length === 0}
        data-testid="review-accept-group"
        onClick={() => decide(groupOpen, 'accepted')}
      >
        {`Accept group (${groupOpen.length}) ▸`}
      </button>
    ) : null

  const compactClass = props.compact === true ? 'hidden' : 'hidden @2xl:flex'
  const dropdownClass = props.compact === true ? 'flex' : 'flex @2xl:hidden'

  return (
    <div
      ref={root}
      role="region"
      aria-label={props.label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-testid={props.testId ?? 'review-deck'}
      className={`@container flex flex-1 flex-col outline-none ${props.compact === true ? 'min-h-0' : 'min-h-72'}`}
    >
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Groups"
          data-testid="review-rail"
          className={`${compactClass} w-56 shrink-0 flex-col gap-1 border-r border-line p-3`}
        >
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {stats.map(({ group: g, total, reviewed }) => (
              <li key={g.id}>
                <button
                  type="button"
                  data-testid="review-group"
                  data-group={g.id}
                  aria-current={shown?.group === g.id ? 'true' : undefined}
                  onClick={() => jumpToGroup(g.id)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-surface ${shown?.group === g.id ? 'bg-surface font-medium' : ''}`}
                >
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${shown?.group === g.id ? 'bg-accent' : 'bg-transparent'}`}
                  />
                  <span className="min-w-0 flex-1 truncate">{g.label}</span>
                  <span className="text-xs text-fg-muted tabular-nums">{`${reviewed}/${total}`}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-col items-start gap-1.5">
            {acceptGroup}
            {skippedToggle}
          </div>
          <div className="mt-auto pt-3">{progressBar}</div>
        </nav>
        <section className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <div className={`${dropdownClass} flex-wrap items-center gap-x-3 gap-y-1.5`}>
            <select
              aria-label="Group"
              data-testid="review-group-select"
              value={shown?.group ?? ''}
              onChange={(event) => jumpToGroup(event.target.value)}
              className="min-w-0 rounded-md border border-line bg-surface px-2 py-1 text-sm"
            >
              {shown === null ? <option value="">Choose a group</option> : null}
              {stats.map(({ group: g, total, reviewed }) => (
                <option key={g.id} value={g.id}>{`${g.label} ${reviewed}/${total}`}</option>
              ))}
            </select>
            {acceptGroup}
            {skippedToggle}
            <div className="min-w-32 flex-1">{progressBar}</div>
          </div>
          {shown === null ? (
            <Done
              accepted={counts.acceptedTotal}
              skipped={counts.skipped}
              total={counts.total}
              onReviewSkipped={showSkipped}
            />
          ) : (
            <article
              data-testid="review-card"
              data-item-id={shown.id}
              data-decision={shown.settled === true ? 'settled' : shown.decision}
              className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
            >
              <header className="flex flex-wrap items-center gap-2">
                <h3 className="m-0 text-sm font-semibold" data-testid="review-position">
                  {`${group?.noun ?? group?.label ?? ''} ${position} of ${inGroup.length}`}
                </h3>
                {shown.settled !== true && shown.decision !== 'pending' ? (
                  <span
                    className="rounded-full border border-line px-2 py-0.5 text-xs text-fg-muted"
                    data-testid="review-decision"
                  >
                    {DECISION_LABEL[shown.decision]}
                  </span>
                ) : null}
                {filter === 'skipped' ? (
                  <span className="text-xs text-fg-subtle">Skipped items</span>
                ) : null}
              </header>
              <div key={shown.id} className="min-w-0">
                {props.renderCard(shown.id)}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {decidable ? (
                  <>
                    <button
                      type="button"
                      className={PRIMARY}
                      disabled={busy}
                      data-testid="review-accept"
                      onClick={() => decide([shown.id], 'accepted')}
                    >
                      <kbd className={KBD}>A</kbd>
                      {props.acceptLabel ?? 'Accept'}
                    </button>
                    <button
                      type="button"
                      className={BUTTON}
                      disabled={busy}
                      data-testid="review-skip"
                      onClick={() => decide([shown.id], 'skipped')}
                    >
                      <kbd className={KBD}>S</kbd>
                      {props.skipLabel ?? 'Skip'}
                    </button>
                    {editable ? (
                      <button
                        type="button"
                        className={BUTTON}
                        disabled={busy}
                        data-testid="review-edit"
                        onClick={() => props.onEdit?.(shown.id)}
                      >
                        <kbd className={KBD}>E</kbd>
                        {props.editLabel ?? 'Edit'}
                      </button>
                    ) : null}
                    {props.reject === true ? (
                      <button
                        type="button"
                        className={BUTTON}
                        disabled={busy}
                        data-testid="review-reject"
                        onClick={() => decide([shown.id], 'rejected')}
                      >
                        <kbd className={KBD}>R</kbd>
                        {props.rejectLabel ?? 'Reject'}
                      </button>
                    ) : null}
                  </>
                ) : null}
                <span className="ml-auto flex gap-1">
                  <button
                    type="button"
                    className="rounded-md p-1 text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40"
                    aria-label="Previous"
                    data-testid="review-prev"
                    disabled={neighbour(ordered, shown.id, -1, filter) === null}
                    onClick={() => step(-1)}
                  >
                    <ChevronLeft size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="rounded-md p-1 text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40"
                    aria-label="Next"
                    data-testid="review-next"
                    disabled={neighbour(ordered, shown.id, 1, filter) === null}
                    onClick={() => step(1)}
                  >
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                </span>
              </div>
            </article>
          )}
        </section>
      </div>
      {apply !== undefined || props.footer !== undefined || props.actions !== undefined ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-4 py-2.5">
          <div className="min-w-0 flex-1 text-xs text-fg-subtle">{props.footer}</div>
          {props.actions}
          {apply !== undefined ? (
            <button
              type="button"
              className={PRIMARY}
              disabled={busy || counts.accepted === 0 || apply.disabled === true}
              data-testid="review-apply"
              onClick={apply.onApply}
            >
              {apply.label(counts.accepted)}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function Done({
  accepted,
  skipped,
  total,
  onReviewSkipped
}: {
  accepted: number
  skipped: number
  total: number
  onReviewSkipped: () => void
}): React.JSX.Element {
  return (
    <div
      data-testid="review-done"
      role="status"
      className="flex flex-col items-start gap-2 rounded-lg border border-line bg-surface p-4 text-sm"
    >
      <p className="m-0 font-medium">
        {total === 0 ? 'Nothing to review.' : `All ${total} reviewed.`}
      </p>
      {total > 0 ? (
        <p className="m-0 text-fg-muted">{`${accepted} accepted · ${skipped} skipped`}</p>
      ) : null}
      {skipped > 0 ? (
        <button
          type="button"
          className={LINK}
          data-testid="review-review-skipped"
          onClick={onReviewSkipped}
        >
          {`Review the skipped ${skipped === 1 ? 'one' : skipped}`}
        </button>
      ) : null}
    </div>
  )
}
