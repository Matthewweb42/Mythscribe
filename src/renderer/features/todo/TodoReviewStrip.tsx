import { useCallback, useMemo } from 'react'
import { TODO_KINDS, TODO_KIND_LABEL, TODO_KIND_NOUN } from '@shared/todo'
import { useEditPassStore } from '@renderer/features/editPass/editPassStore'
import { ReviewDeck } from '@renderer/features/review/ReviewDeck'
import type {
  ReviewDecision,
  ReviewDeckGroup,
  ReviewDeckItem
} from '@renderer/features/review/reviewDeckModel'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { TodoCard } from './TodoCard'
import { canAdd } from './todoPick'
import { useTodoStore } from './todoStore'

const GROUPS: ReviewDeckGroup[] = TODO_KINDS.map((kind) => ({
  id: kind,
  label: TODO_KIND_LABEL[kind],
  noun: TODO_KIND_NOUN[kind]
}))

/**
 * Go through the To do list one by one (F-9.16, Q9): the review deck as a strip above the editor,
 * the edit-pass review's pattern. Every card jumps the editor to its passage; A is Done, R is
 * Dismiss (never comes back), S is Later (the item stays), E opens the editable line. The kinds are
 * the deck's groups. An edit pass under review wins the strip.
 */
export function TodoReviewStrip(): React.JSX.Element | null {
  const review = useTodoStore((s) => s.review)
  const open = useTodoStore((s) => s.items)
  const pending = useTodoStore((s) => s.pending)
  const editReview = useEditPassStore((s) => s.review !== null)

  const items = useMemo<ReviewDeckItem[]>(() => {
    if (review === null) return []
    return [
      ...open.map((item) => ({
        id: item.id,
        group: item.kind,
        decision: review.skipped.includes(item.id) ? ('skipped' as const) : ('pending' as const)
      })),
      ...review.decided.map(({ item, status }) => ({
        id: item.id,
        group: item.kind,
        decision: status === 'done' ? ('accepted' as const) : ('rejected' as const),
        settled: true
      }))
    ]
  }, [review, open])
  const onCurrent = useCallback((id: string | null) => {
    useTodoStore.getState().reviewAt(id)
  }, [])

  if (review === null || editReview) return null

  const decide = (ids: string[], decision: ReviewDecision): void => {
    const store = useTodoStore.getState()
    if (decision === 'skipped') {
      store.skipInReview(ids)
      return
    }
    const status = decision === 'accepted' ? 'done' : 'dismissed'
    for (const id of ids) {
      store.settle(id, status).catch((err: unknown) => toast.error(describeError(err)))
    }
  }

  return (
    <div
      className="flex max-h-[55vh] shrink-0 flex-col border-b border-line bg-surface-raised"
      data-testid="todo-review"
    >
      <ReviewDeck
        label="Go through the To do list"
        items={items}
        groups={GROUPS}
        initialId={review.currentId}
        renderCard={(id) => <TodoCard id={id} />}
        onDecide={decide}
        onEdit={(id) => useTodoStore.getState().openComposer(id, '')}
        canEdit={(id) => {
          const item = open.find((each) => each.id === id)
          return item !== undefined && canAdd(item.target)
        }}
        reject
        acceptLabel="Done"
        editLabel="Write a line"
        rejectLabel="Dismiss"
        skipLabel="Later"
        groupAccept={false}
        onCurrent={onCurrent}
        busy={review.currentId !== null && pending.includes(review.currentId)}
        compact
        autoFocus
        actions={
          <button
            type="button"
            className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface"
            data-testid="todo-review-close"
            onClick={() => useTodoStore.getState().endReview()}
          >
            Stop
          </button>
        }
      />
    </div>
  )
}
