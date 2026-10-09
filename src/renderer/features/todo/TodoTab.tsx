import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { TODO_KINDS, TODO_KIND_LABEL, type TodoItem, type TodoKind } from '@shared/todo'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { goToTodo, openContinuityFix } from './todoJump'
import { useTodoStore } from './todoStore'

const ACTION =
  'rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-60'

/** Runs a store action and toasts its failure. */
const run = (action: Promise<void>): void => {
  action.catch((err: unknown) => toast.error(describeError(err)))
}

/**
 * The To do section (F-9.16): what the book leaves unexplained, contradicted, unfinished, or
 * unstated, grouped by kind with the counts. Each item says why it was flagged and jumps to its
 * passage; Done ("handled") and Dismiss ("not a problem") settle it for good, with an Undo for
 * the last one. "Go through one by one" (or a click on an item) shows them on the review deck
 * above the editor (`TodoReviewStrip`). Nothing here writes to a scene.
 */
export function TodoTab(): React.JSX.Element {
  const items = useTodoStore((s) => s.items)
  const counts = useTodoStore((s) => s.counts)
  const loaded = useTodoStore((s) => s.loaded)
  const settled = useTodoStore((s) => s.settled)
  const pending = useTodoStore((s) => s.pending)
  const [filter, setFilter] = useState<TodoKind | 'all'>('all')

  useEffect(() => {
    run(useTodoStore.getState().load())
  }, [])

  const shown = filter === 'all' ? items : items.filter((item) => item.kind === filter)

  return (
    <div data-testid="todo-tab" className="min-h-0 flex-1 overflow-y-auto p-2">
      <p className="m-0 mb-2 text-xs text-fg-muted">
        What the book leaves unexplained, contradicted, unfinished, or unstated. Suggestions are
        options for you to choose from, never facts.
      </p>
      {items.length > 0 ? (
        <button
          type="button"
          data-testid="todo-go-through"
          onClick={() => useTodoStore.getState().startReview()}
          className="mb-2 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg hover:bg-accent-hover"
        >
          Go through one by one ({items.length})
        </button>
      ) : null}
      {items.length > 0 ? (
        <label className="mb-2 flex items-center gap-1.5 text-xs text-fg-muted">
          Show
          <select
            aria-label="Show kind"
            value={filter}
            onChange={(event) => setFilter(event.target.value as TodoKind | 'all')}
            className="rounded border border-line bg-surface px-1 py-0.5 text-xs text-fg"
          >
            <option value="all">All kinds ({items.length})</option>
            {TODO_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {TODO_KIND_LABEL[kind]} ({counts[kind]})
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {settled === null ? null : (
        <div
          role="status"
          data-testid="todo-undo"
          className="mb-2 flex items-center gap-1.5 rounded-md bg-surface-raised px-2 py-1 text-xs"
        >
          <span className="min-w-0 flex-1 truncate" title={settled.subject}>
            {settled.status === 'done' ? 'Done' : 'Dismissed'}: {settled.subject}
          </span>
          {settled.reopenable ? (
            <button
              type="button"
              disabled={pending.includes(settled.id)}
              onClick={() => run(useTodoStore.getState().undo())}
              className={ACTION}
            >
              Undo
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Close"
            onClick={() => useTodoStore.getState().forgetSettled()}
            className={ACTION}
          >
            ×
          </button>
        </div>
      )}
      {shown.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">
          {loaded ? 'Nothing to figure out right now.' : 'Loading…'}
        </p>
      ) : (
        TODO_KINDS.map((kind) => {
          const group = shown.filter((item) => item.kind === kind)
          if (group.length === 0) return null
          return (
            <section
              key={kind}
              aria-label={TODO_KIND_LABEL[kind]}
              className="mb-3 flex flex-col gap-1"
            >
              <h3 className="m-0 px-1 text-xs font-medium text-fg-muted">
                {TODO_KIND_LABEL[kind]} ({group.length})
              </h3>
              <ul role="list" className="m-0 flex list-none flex-col gap-1.5 p-0">
                {group.map((item) => (
                  <TodoRow key={item.id} item={item} busy={pending.includes(item.id)} />
                ))}
              </ul>
            </section>
          )
        })
      )}
    </div>
  )
}

function TodoRow({ item, busy }: { item: TodoItem; busy: boolean }): React.JSX.Element {
  const title = useTreeStore((s) =>
    item.nodeId === null ? null : (s.byId[item.nodeId]?.title ?? null)
  )
  return (
    <li
      aria-label={item.subject}
      data-testid="todo-item"
      data-rule={item.rule}
      className="flex flex-col gap-1 rounded-md border border-line px-2 py-1.5"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {item.source === 'ai' ? (
          <span title="Found by the AI check" className="flex shrink-0 text-accent">
            <Sparkles size={11} aria-label="Found by the AI check" />
          </span>
        ) : null}
        <button
          type="button"
          title={`Go through from ${item.subject}`}
          onClick={() => useTodoStore.getState().startReview(item.id)}
          className="min-w-0 flex-1 truncate text-left text-sm font-medium underline-offset-2 hover:underline"
        >
          {item.subject}
        </button>
      </div>
      <p className="m-0 text-xs text-fg-muted">{item.why}</p>
      {item.quote === null ? null : (
        <q title={item.quote} className="line-clamp-2 text-xs break-words text-fg-subtle italic">
          {item.quote}
        </q>
      )}
      <div className="flex flex-wrap items-center gap-1">
        {item.nodeId === null ? null : (
          <button
            type="button"
            aria-label={`Go to passage in ${title ?? 'the scene'}`}
            onClick={() => goToTodo(item)}
            className={ACTION}
          >
            Go to passage
          </button>
        )}
        {item.rule === 'continuity' ? (
          <button type="button" onClick={() => openContinuityFix(item)} className={ACTION}>
            Open the fix
          </button>
        ) : null}
        <span className="ml-auto flex gap-1">
          <button
            type="button"
            disabled={busy}
            aria-label={`Done: ${item.subject}`}
            onClick={() => run(useTodoStore.getState().settle(item.id, 'done'))}
            className={ACTION}
          >
            Done
          </button>
          <button
            type="button"
            disabled={busy}
            aria-label={`Dismiss: ${item.subject}`}
            title="Not a problem: it will not come back"
            onClick={() => run(useTodoStore.getState().settle(item.id, 'dismissed'))}
            className={ACTION}
          >
            Dismiss
          </button>
        </span>
      </div>
    </li>
  )
}
