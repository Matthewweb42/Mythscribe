import { useEffect } from 'react'
import { Sparkles } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import {
  THREAD_EVENT_LABEL,
  THREAD_KIND,
  THREAD_STATUSES,
  THREAD_STATUS_LABEL,
  type ThreadEventView,
  type ThreadView
} from '@shared/threads'
import { locateText } from '@renderer/features/editor/locateText'
import { openPassage } from '@renderer/features/editor/openPassage'
import { EntityQuickAdd } from '@renderer/features/entities/EntityQuickAdd'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useThreadStore } from './threadStore'

const LINK_BUTTON = 'rounded px-0.5 text-left text-xs text-fg-muted underline hover:text-fg'

/** Goes to the event's passage (or its scene when it has no quote). */
export function goToEvent(event: ThreadEventView): void {
  const { nodeId, quote } = event
  if (nodeId === null) return
  if (quote === null) {
    useTreeStore.getState().select(nodeId)
    return
  }
  void openPassage(nodeId, (doc) => locateText(doc, quote))
}

/**
 * The Threads section (F-9.14, D6): the plot threads of the book, open ones first, then resolved
 * and dropped, each with its open question, where it was set up and where it was paid off (a jump
 * to the passage), and how many times it moved. A thread's status comes from its events (the
 * scenes' readings and the author's own), never typed in. The name opens the thread's sheet,
 * where its events are listed and the author adds one; New thread at the foot makes a sheet.
 */
export function ThreadsTab(): React.JSX.Element {
  const threads = useThreadStore((s) => s.threads)
  const loaded = useThreadStore((s) => s.loaded)
  // The thread sheets as the entity store holds them: a new, renamed, or deleted one reloads.
  const records = useEntityStore(
    useShallow((s) =>
      s.ids.flatMap((id) => {
        const entity = s.byId[id]
        return entity?.kind === THREAD_KIND ? [`${entity.id}:${entity.name}`] : []
      })
    )
  )
  const key = records.join('|')

  useEffect(() => {
    useThreadStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
  }, [key])

  const counts = THREAD_STATUSES.map((status) => ({
    status,
    n: threads.filter((thread) => thread.status === status).length
  })).filter(({ n }) => n > 0)

  return (
    <>
      <div data-testid="threads-tab" className="min-h-0 flex-1 overflow-y-auto">
        {threads.length === 0 ? (
          <p className="m-0 p-3 text-sm text-fg-muted">
            {loaded
              ? 'No threads yet. They appear as the scenes are read, or add one below.'
              : 'Loading…'}
          </p>
        ) : (
          <>
            <p data-testid="threads-counts" className="m-0 px-3 pt-2 pb-1 text-xs text-fg-muted">
              {counts
                .map(({ status, n }) => `${n} ${THREAD_STATUS_LABEL[status].toLowerCase()}`)
                .join(' · ')}
            </p>
            {THREAD_STATUSES.map((status) => {
              const group = threads.filter((thread) => thread.status === status)
              if (group.length === 0) return null
              return (
                <section
                  key={status}
                  aria-label={`${THREAD_STATUS_LABEL[status]} threads`}
                  className="flex flex-col gap-1 px-2 pb-2"
                >
                  <h3 className="m-0 px-1 text-xs font-medium text-fg-muted">
                    {THREAD_STATUS_LABEL[status]}
                  </h3>
                  <ul role="list" className="m-0 flex list-none flex-col gap-1 p-0">
                    {group.map((thread) => (
                      <ThreadRow key={thread.entityId} thread={thread} />
                    ))}
                  </ul>
                </section>
              )
            })}
          </>
        )}
      </div>
      <EntityQuickAdd kind={THREAD_KIND} />
    </>
  )
}

function ThreadRow({ thread }: { thread: ThreadView }): React.JSX.Element {
  const byId = useTreeStore((s) => s.byId)
  const titleOf = (id: string | null): string =>
    id === null ? 'the start' : (byId[id]?.title ?? 'a deleted scene')
  const moves = thread.events.filter((event) => event.event === 'advanced').length
  return (
    <li
      aria-label={thread.name}
      data-status={thread.status}
      className="flex flex-col gap-0.5 rounded-md border border-line px-2 py-1"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {thread.origin === 'ai' ? (
          <span title="Added by AI" className="flex shrink-0 text-accent">
            <Sparkles size={11} aria-label="Added by AI" />
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => useEntityStore.getState().select(thread.entityId)}
          className="min-w-0 truncate text-left text-sm font-medium underline-offset-2 hover:underline"
        >
          {thread.name}
        </button>
        {moves > 0 ? (
          <span className="ml-auto shrink-0 text-[11px] text-fg-subtle">
            {moves === 1 ? '1 move' : `${moves} moves`}
          </span>
        ) : null}
      </div>
      {thread.question !== '' ? (
        <p data-testid="thread-question" className="m-0 text-xs text-fg-muted italic">
          {thread.question}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-2 text-xs text-fg-subtle">
        {thread.setup !== null ? (
          <span>
            Set up in{' '}
            <EventJump event={thread.setup} label={titleOf(thread.setup.nodeId)} />
          </span>
        ) : (
          <span>Not set up in a scene yet</span>
        )}
        {thread.payoff !== null ? (
          <span>
            {THREAD_EVENT_LABEL[thread.payoff.event]} in{' '}
            <EventJump event={thread.payoff} label={titleOf(thread.payoff.nodeId)} />
          </span>
        ) : null}
      </div>
    </li>
  )
}

function EventJump({ event, label }: { event: ThreadEventView; label: string }): React.JSX.Element {
  if (event.nodeId === null) return <span>{label}</span>
  return (
    <button
      type="button"
      title={event.quote ?? undefined}
      onClick={() => goToEvent(event)}
      className={LINK_BUTTON}
    >
      {label}
    </button>
  )
}
