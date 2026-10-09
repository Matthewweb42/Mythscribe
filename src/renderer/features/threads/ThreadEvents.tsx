import { useId, useState } from 'react'
import { Sparkles } from 'lucide-react'
import type { Fact } from '@shared/facts'
import type { Entity } from '@shared/ipc/contract'
import {
  deriveThreads,
  THREAD_EVENTS,
  THREAD_EVENT_LABEL,
  THREAD_NOTE_MAX,
  THREAD_STATUS_LABEL,
  ThreadEvent
} from '@shared/threads'
import { useFactStore } from '@renderer/features/entities/factStore'
import type { StoryClock } from '@renderer/features/entities/factView'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { goToEvent } from './ThreadsTab'

const LABEL = 'text-xs font-medium text-fg-muted'
const BUTTON =
  'rounded-md border border-line px-2 py-0.5 text-xs hover:bg-surface-raised disabled:opacity-60 disabled:hover:bg-transparent'
const CONTROL = 'min-w-0 rounded-md border border-line bg-bg px-1.5 py-0.5 text-xs'

/**
 * A thread's events on its sheet (F-9.14): its derived status, then every event in reading order,
 * the AI's marked with a jump to the passage and Hide, the author's with Remove, and a row to add
 * the author's own event at a scene (the open scene by default).
 */
export function ThreadEvents({
  entity,
  facts,
  clock
}: {
  entity: Entity
  facts: readonly Fact[]
  clock: StoryClock
}): React.JSX.Element {
  const [view] = deriveThreads(
    [{ id: entity.id, name: entity.name, origin: entity.origin }],
    facts,
    clock.order
  )
  const events = view?.events ?? []
  return (
    <section aria-label="Thread events" className="flex flex-col gap-1.5">
      <h3 className={`m-0 font-normal ${LABEL}`}>
        Thread events · {THREAD_STATUS_LABEL[view?.status ?? 'open']}
      </h3>
      {events.length === 0 ? (
        <p className="m-0 text-xs text-fg-subtle">No events yet.</p>
      ) : (
        <ul role="list" className="m-0 flex list-none flex-col gap-1 p-0">
          {events.map((event) => (
            <li
              key={event.factId}
              aria-label={`${THREAD_EVENT_LABEL[event.event]}${event.note === '' ? '' : `: ${event.note}`}`}
              className="flex flex-wrap items-baseline gap-x-2 rounded-md border border-line px-2 py-1"
            >
              {event.origin === 'ai' ? (
                <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-accent">
                  <Sparkles size={11} aria-hidden="true" />
                  AI
                </span>
              ) : (
                <span className="shrink-0 text-[11px] text-fg-subtle">Yours</span>
              )}
              <span className="text-sm font-medium">{THREAD_EVENT_LABEL[event.event]}</span>
              {event.note !== '' ? (
                <span className="min-w-0 flex-1 text-sm wrap-anywhere">{event.note}</span>
              ) : null}
              <span className="text-xs text-fg-subtle">
                {event.nodeId === null ? 'From the start' : clock.titleOf(event.nodeId)}
              </span>
              {event.nodeId !== null && event.quote !== null ? (
                <button
                  type="button"
                  title={event.quote}
                  onClick={() => goToEvent(event)}
                  className="text-xs text-fg-muted underline hover:text-fg"
                >
                  Go to passage
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  const store = useFactStore.getState()
                  const task =
                    event.origin === 'ai'
                      ? store.setHidden([event.factId], true)
                      : store.remove(event.factId)
                  task.catch((err: unknown) => toast.error(describeError(err)))
                }}
                className={`ml-auto ${BUTTON}`}
              >
                {event.origin === 'ai' ? 'Hide' : 'Remove'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <AddThreadEvent entity={entity} clock={clock} />
    </section>
  )
}

function AddThreadEvent({
  entity,
  clock
}: {
  entity: Entity
  clock: StoryClock
}): React.JSX.Element {
  const uid = useId()
  const [event, setEvent] = useState<ThreadEvent>('opened')
  const [scene, setScene] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  // The open scene (else the latest written one) until the author picks another.
  const at = scene ?? clock.nowId ?? ''

  const add = async (): Promise<void> => {
    setBusy(true)
    try {
      await useFactStore.getState().create({
        kind: 'threadEvent',
        entityId: entity.id,
        event,
        note: note.trim(),
        nodeId: at === '' ? null : at
      })
      setNote('')
    } catch (err) {
      toast.error(describeError(err))
    }
    setBusy(false)
  }

  return (
    <div role="group" aria-label="Add a thread event" className="flex flex-wrap items-center gap-1">
      <label htmlFor={`${uid}-event`} className="sr-only">
        Event
      </label>
      <select
        id={`${uid}-event`}
        value={event}
        onChange={(change) => {
          const next = ThreadEvent.safeParse(change.target.value)
          if (next.success) setEvent(next.data)
        }}
        className={CONTROL}
      >
        {THREAD_EVENTS.map((each) => (
          <option key={each} value={each}>
            {THREAD_EVENT_LABEL[each]}
          </option>
        ))}
      </select>
      <label htmlFor={`${uid}-scene`} className="sr-only">
        Scene
      </label>
      <select
        id={`${uid}-scene`}
        value={at}
        onChange={(change) => setScene(change.target.value)}
        className={`${CONTROL} flex-1 basis-24`}
      >
        <option value="">From the start</option>
        {clock.order.map((sceneId) => (
          <option key={sceneId} value={sceneId}>
            {clock.titleOf(sceneId)}
          </option>
        ))}
      </select>
      <input
        aria-label="Event note"
        placeholder="Note (optional)"
        value={note}
        maxLength={THREAD_NOTE_MAX}
        onChange={(change) => setNote(change.target.value)}
        className={`${CONTROL} flex-1 basis-24`}
      />
      <button type="button" disabled={busy} onClick={() => void add()} className={BUTTON}>
        Add
      </button>
    </div>
  )
}
