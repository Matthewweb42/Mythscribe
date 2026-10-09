import { z } from 'zod'
import { FactOrigin, FactStatus, type Fact } from './facts'

/**
 * Plot threads (F-9.14, decision D6): a thread is a record in the built-in `thread` category
 * (fields kind, description, intended payoff), and what happens to it is dated facts on that
 * record: `thread:opened`, `thread:advanced`, `thread:resolved`, `thread:dropped`, each read from
 * a scene with its quote (or dated by the author). The thread's status is derived, never stored:
 * the last canon event in reading order decides it. This file owns the vocabulary and the pure
 * derivation both sides read.
 */

export const THREAD_EVENTS = ['opened', 'advanced', 'resolved', 'dropped'] as const
export const ThreadEvent = z.enum(THREAD_EVENTS)
export type ThreadEvent = z.infer<typeof ThreadEvent>

export const THREAD_EVENT_LABEL: Readonly<Record<ThreadEvent, string>> = {
  opened: 'Opened',
  advanced: 'Advanced',
  resolved: 'Resolved',
  dropped: 'Dropped'
}

export const THREAD_STATUSES = ['open', 'resolved', 'dropped'] as const
export const ThreadStatus = z.enum(THREAD_STATUSES)
export type ThreadStatus = z.infer<typeof ThreadStatus>

export const THREAD_STATUS_LABEL: Readonly<Record<ThreadStatus, string>> = {
  open: 'Open',
  resolved: 'Resolved',
  dropped: 'Dropped'
}

/** The story-bible category id of thread records. */
export const THREAD_KIND = 'thread'

/** Longest note on a thread event (the open question, or what moved). */
export const THREAD_NOTE_MAX = 160

const THREAD_PREFIX = 'thread:'

/** The fact attribute an event is stored under: `thread:opened`. */
export function threadAttribute(event: ThreadEvent): string {
  return `${THREAD_PREFIX}${event}`
}

/** The event of a thread fact's attribute, or null for an attribute that is not one. */
export function threadEventOf(attribute: string): ThreadEvent | null {
  if (!attribute.startsWith(THREAD_PREFIX)) return null
  const parsed = ThreadEvent.safeParse(attribute.slice(THREAD_PREFIX.length))
  return parsed.success ? parsed.data : null
}

/**
 * Where an event sits among the events one scene states for the same thread (F-9.14): an
 * opening or an advance before a resolution or a drop, whatever order they were stored in, so a
 * scene that moves a thread and then closes it always reads as closing it.
 */
export function threadEventRank(event: ThreadEvent): number {
  return event === 'resolved' || event === 'dropped' ? 1 : 0
}

/** One event of a thread as the Threads section lists it. */
export const ThreadEventView = z.object({
  factId: z.string(),
  event: ThreadEvent,
  /** The open question, or what moved; '' for none. */
  note: z.string(),
  nodeId: z.string().nullable(),
  quote: z.string().nullable(),
  origin: FactOrigin,
  status: FactStatus
})
export type ThreadEventView = z.infer<typeof ThreadEventView>

/** One thread as `thread:list` answers it. */
export const ThreadView = z.object({
  entityId: z.string(),
  name: z.string(),
  origin: FactOrigin,
  status: ThreadStatus,
  /** The newest open question an opening event stated; '' for none. */
  question: z.string(),
  /** The setup: the first canon opening (else the first canon event); null for none. */
  setup: ThreadEventView.nullable(),
  /** The payoff: the canon resolution or drop that decided the status; null while open. */
  payoff: ThreadEventView.nullable(),
  /** Every visible event, in reading order. */
  events: z.array(ThreadEventView)
})
export type ThreadView = z.infer<typeof ThreadView>

export interface ThreadRecordInput {
  id: string
  name: string
  origin: 'author' | 'ai'
}

/**
 * The threads as of the end of the book, in reading order of their setups (a thread with no event
 * last, by name). Pure. `facts` are any facts; only visible thread events of the given records
 * count. The status is the last canon event's: resolved or dropped close a thread, an opening or
 * an advance (re)opens it; a thread with no canon event is open (decided by Claude, unconfirmed).
 * Within one scene the stored order holds, except that a resolution or a drop comes last
 * (`threadEventRank`).
 * Plan and idea events are listed but never decide it.
 */
export function deriveThreads(
  records: readonly ThreadRecordInput[],
  facts: readonly Fact[],
  order: readonly string[]
): ThreadView[] {
  const index = new Map(order.map((id, at) => [id, at]))
  const end = order.length
  const at = (event: ThreadEventView): number =>
    event.nodeId === null ? -1 : (index.get(event.nodeId) ?? end)
  const byRecord = new Map<string, ThreadEventView[]>()
  for (const fact of facts) {
    if (fact.hidden) continue
    const event = threadEventOf(fact.attribute)
    if (event === null) continue
    const list = byRecord.get(fact.entityId) ?? []
    list.push({
      factId: fact.id,
      event,
      note: fact.value,
      nodeId: fact.nodeId,
      quote: fact.quote,
      origin: fact.origin,
      status: fact.status
    })
    byRecord.set(fact.entityId, list)
  }
  const views = records.map((record): ThreadView => {
    const events = (byRecord.get(record.id) ?? [])
      .map((event, input) => ({ event, input }))
      .sort(
        (a, b) =>
          at(a.event) - at(b.event) ||
          threadEventRank(a.event.event) - threadEventRank(b.event.event) ||
          a.input - b.input
      )
      .map(({ event }) => event)
    const canon = events.filter((event) => event.status === 'canon')
    const last = canon[canon.length - 1]
    const status: ThreadStatus =
      last?.event === 'resolved' ? 'resolved' : last?.event === 'dropped' ? 'dropped' : 'open'
    const openings = canon.filter((event) => event.event === 'opened')
    const asked = [...openings].reverse().find((event) => event.note.trim() !== '')
    return {
      entityId: record.id,
      name: record.name,
      origin: record.origin,
      status,
      question: asked?.note ?? '',
      setup: openings[0] ?? canon[0] ?? null,
      payoff: status === 'open' ? null : (last ?? null),
      events
    }
  })
  const first = (view: ThreadView): number => {
    const opening = view.events[0]
    return opening === undefined ? Number.MAX_SAFE_INTEGER : at(opening)
  }
  return views.sort((a, b) => first(a) - first(b) || a.name.localeCompare(b.name))
}
