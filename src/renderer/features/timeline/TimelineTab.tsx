import { useEffect, useId, useMemo, useState, type DragEvent, type KeyboardEvent } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import {
  TIMELINE_LABEL_MAX,
  TIMELINE_NOTE_MAX,
  TIMELINE_WHEN_MAX,
  parseYear,
  type TimelineEvent
} from '@shared/timeline'
import { useSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { useHeldSceneMeta } from '@renderer/features/editor/useHeldSceneMeta'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { NodeTitleButton } from '@renderer/features/outline/BeatsView'
import { listOutline } from '@renderer/features/outline/outlineRows'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useDocumentTagStore } from '@renderer/features/tags/documentTagStore'
import { useMentionStore } from '@renderer/features/tags/mentionStore'
import { describeError } from '@renderer/lib/errors'
import {
  ageText,
  eventAges,
  linkedEventId,
  nodesByEvent,
  readingOrderRows,
  unplacedCount,
  yearWarnings,
  type EventAge,
  type EventOf
} from './timelineView'
import { useTimelineStore } from './timelineStore'
import { appearsBy, locationConflicts, type LocationConflict } from './usageLog'

type TimelineView = 'events' | 'reading'

const VIEWS: readonly { view: TimelineView; label: string }[] = [
  { view: 'events', label: 'Events' },
  { view: 'reading', label: 'Reading order' }
]

const FIELD =
  'min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-px text-xs leading-5 disabled:opacity-50'
const TEXT_BUTTON =
  'rounded-md border border-line px-2 py-0.5 text-xs hover:bg-surface-raised disabled:opacity-40 disabled:hover:bg-transparent'
const ICON_BUTTON =
  'rounded-md p-1 text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40'

/**
 * The Timeline tab of the sidebar (F-11.2). Two views, switched in memory: **Events** lists the
 * project's events in story order (the author's order), each with its "when", year, note, and the
 * manuscript nodes linked to it in reading order; events are added with the form on top, edited
 * in place, deleted after a confirmation (linked scenes keep their text), and reordered by drag
 * or Alt+ArrowUp/Down. An event whose year is lower than an earlier event's is flagged. **Reading
 * order** lists the manuscript documents in reading order, each placed on a track by its event's
 * position, and marks a document set earlier than one read before it ("Earlier"). Both views
 * hold every manuscript node's scene metadata while on screen (`useHeldSceneMeta`), which is
 * where the links live (`SceneMeta.eventId`); a scene is linked from the metadata pane's picker.
 * An event with a year lists the ages of the characters in its scenes (F-11.2b: tag-linked or
 * named as POV, with a whole-number Born), so the Events view reads every document's tags.
 * An event whose scenes put one character in two different locations says so (F-11.2c, display
 * only: tag linked, mentioned, or POV; Locations compared by name key), so the Events view also
 * reads the recorded mentions of every document on an event.
 */
export function TimelineTab(): React.JSX.Element {
  const [view, setView] = useState<TimelineView>('events')
  const events = useTimelineStore((s) => s.events)
  const rootIds = useTreeStore((s) => s.rootIds)
  const childrenOf = useTreeStore((s) => s.childrenOf)
  const sectionOf = useTreeStore((s) => s.sectionOf)
  const byId = useTreeStore((s) => s.byId)
  const metas = useSceneMetaStore((s) => s.docs)
  const ids = useMemo(
    () => listOutline(rootIds, childrenOf, sectionOf).map((row) => row.id),
    [rootIds, childrenOf, sectionOf]
  )
  useHeldSceneMeta(ids)

  const eventOf: EventOf = (id) => linkedEventId(events, metas[id]?.content?.eventId)
  const documentIds = ids.filter((id) => byId[id]?.kind === 'document')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <div
          role="group"
          aria-label="Timeline view"
          className="flex shrink-0 gap-0.5 rounded-md border border-line p-0.5"
        >
          {VIEWS.map((option) => (
            <button
              key={option.view}
              type="button"
              aria-pressed={option.view === view}
              onClick={() => setView(option.view)}
              className="rounded px-2 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg aria-pressed:bg-surface-raised aria-pressed:text-fg"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {view === 'events' ? (
        <EventsView ids={ids} documentIds={documentIds} eventOf={eventOf} />
      ) : (
        <ReadingOrderView documentIds={documentIds} eventOf={eventOf} />
      )}
    </div>
  )
}

/** The text of the four event fields while a form edits them; the year stays text until saved. */
interface EventDraft {
  label: string
  when: string
  year: string
  note: string
}

const EMPTY_DRAFT: EventDraft = { label: '', when: '', year: '', note: '' }

const draftOf = (event: TimelineEvent): EventDraft => ({
  label: event.label,
  when: event.when,
  year: event.year === null ? '' : String(event.year),
  note: event.note
})

/** The draft as event fields, or null while it cannot be saved (no label, or a year that is not a whole number). */
function fieldsOf(draft: EventDraft): Omit<TimelineEvent, 'id'> | null {
  const label = draft.label.trim()
  const year = parseYear(draft.year)
  if (label === '' || year === 'invalid') return null
  return { label, when: draft.when.trim(), year, note: draft.note }
}

/** The events view: the add form, the events in story order, and how many documents sit on none. */
function EventsView({
  ids,
  documentIds,
  eventOf
}: {
  ids: readonly string[]
  documentIds: readonly string[]
  eventOf: EventOf
}): React.JSX.Element {
  const events = useTimelineStore((s) => s.events)
  const move = useTimelineStore((s) => s.move)
  const metas = useSceneMetaStore((s) => s.docs)
  const entityIds = useEntityStore((s) => s.ids)
  const entitiesById = useEntityStore((s) => s.byId)
  const tagIdsByNode = useDocumentTagStore((s) => s.tagIdsByNode)
  const mentionsByNode = useMentionStore((s) => s.byNode)
  useEffect(() => {
    useDocumentTagStore
      .getState()
      .loadAll()
      .catch((err: unknown) => toast.error(describeError(err)))
  }, [])
  /** The position of the event being dragged, and the one it is over. */
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const linked = nodesByEvent(events, ids, eventOf)
  const warned = yearWarnings(events)
  const entities = useMemo(
    () => entityIds.flatMap((id) => entitiesById[id] ?? []),
    [entityIds, entitiesById]
  )
  const povOf = (id: string): string | undefined => metas[id]?.content?.pov
  const ages = eventAges(events, linked, entities, (id) => tagIdsByNode[id], povOf)
  // F-11.2c: the recorded mentions of the documents on an event, for the location conflicts;
  // keyed by the joined ids so a re-render with the same links asks for nothing.
  const linkedDocuments = documentIds.filter((id) => eventOf(id) !== undefined).join('\n')
  useEffect(() => {
    if (linkedDocuments === '') return
    const mentions = useMentionStore.getState()
    for (const id of linkedDocuments.split('\n')) {
      mentions.loadForNode(id).catch((err: unknown) => toast.error(describeError(err)))
    }
  }, [linkedDocuments])
  const conflicts = new Map<string, LocationConflict[]>()
  for (const conflict of locationConflicts(
    events,
    nodesByEvent(events, documentIds, eventOf),
    entities.filter((entity) => entity.kind === 'character'),
    appearsBy(
      (id) => tagIdsByNode[id],
      (tagId, nodeId) => mentionsByNode[nodeId]?.some((row) => row.tagId === tagId) === true,
      povOf
    ),
    (id) => metas[id]?.content?.location
  )) {
    conflicts.set(conflict.eventId, [...(conflicts.get(conflict.eventId) ?? []), conflict])
  }
  const endDrag = (): void => {
    setDragFrom(null)
    setDragOver(null)
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
      <AddEventForm />
      {events.length === 0 ? (
        <p className="m-0 py-2 text-xs text-fg-muted">No events yet.</p>
      ) : (
        <ol aria-label="Timeline events" className="m-0 flex list-none flex-col gap-1 p-0">
          {events.map((event, index) => (
            <EventItem
              key={event.id}
              event={event}
              nodeIds={linked.get(event.id) ?? []}
              ages={ages.get(event.id) ?? []}
              conflicts={conflicts.get(event.id) ?? []}
              warning={warned.has(event.id)}
              onStep={(step) => void move(index, index + step)}
              drag={{
                dropTarget: dragFrom !== null && dragFrom !== index && dragOver === index,
                onDragStart: (dragEvent) => {
                  dragEvent.dataTransfer.effectAllowed = 'move'
                  dragEvent.dataTransfer.setData('text/plain', event.id)
                  setDragFrom(index)
                },
                onDragOver: (dragEvent) => {
                  // Only an event of this list may land here.
                  if (dragFrom === null) return
                  dragEvent.preventDefault()
                  dragEvent.dataTransfer.dropEffect = 'move'
                  if (dragOver !== index) setDragOver(index)
                },
                onDragLeave: () => {
                  if (dragOver === index) setDragOver(null)
                },
                onDrop: (dragEvent) => {
                  if (dragFrom === null) return
                  dragEvent.preventDefault()
                  void move(dragFrom, index)
                  endDrag()
                },
                onDragEnd: endDrag
              }}
            />
          ))}
        </ol>
      )}
      <p data-testid="timeline-unplaced" className="m-0 pt-2 text-xs text-fg-muted">
        Not on the timeline: {unplacedCount(events, documentIds, eventOf)}
      </p>
    </div>
  )
}

/** The four fields of an event form; the label is required, the rest optional. */
function EventFields({
  draft,
  onChange
}: {
  draft: EventDraft
  onChange: (draft: EventDraft) => void
}): React.JSX.Element {
  const id = useId()
  const row = (
    key: keyof EventDraft,
    label: string,
    max: number,
    placeholder: string
  ): React.JSX.Element => (
    <div className="flex items-center gap-2">
      <label htmlFor={`${id}-${key}`} className="w-12 shrink-0 text-xs text-fg-muted">
        {label}
      </label>
      <input
        id={`${id}-${key}`}
        type="text"
        inputMode={key === 'year' ? 'numeric' : undefined}
        value={draft[key]}
        maxLength={max}
        placeholder={placeholder}
        onChange={(event) => onChange({ ...draft, [key]: event.target.value })}
        className={FIELD}
      />
    </div>
  )
  return (
    <>
      {row('label', 'Event', TIMELINE_LABEL_MAX, 'What happens')}
      {row('when', 'When', TIMELINE_WHEN_MAX, 'e.g. Spring, Day 3')}
      {row('year', 'Year', 12, 'Story year, optional')}
      <div className="flex items-start gap-2">
        <label
          htmlFor={`${id}-note`}
          className="w-12 shrink-0 pt-px text-xs leading-5 text-fg-muted"
        >
          Note
        </label>
        <textarea
          id={`${id}-note`}
          rows={2}
          value={draft.note}
          maxLength={TIMELINE_NOTE_MAX}
          onChange={(event) => onChange({ ...draft, note: event.target.value })}
          className={`${FIELD} resize-none`}
        />
      </div>
    </>
  )
}

/** The form that appends an event to the end of the timeline. */
function AddEventForm(): React.JSX.Element {
  const loaded = useTimelineStore((s) => s.loaded)
  const add = useTimelineStore((s) => s.add)
  const [draft, setDraft] = useState<EventDraft>(EMPTY_DRAFT)
  const fields = fieldsOf(draft)
  return (
    <form
      aria-label="Add event"
      className="flex flex-col gap-1 border-b border-line py-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (fields === null) return
        void add({ id: crypto.randomUUID(), ...fields }).then((stored) => {
          if (stored) setDraft(EMPTY_DRAFT)
        })
      }}
    >
      <EventFields draft={draft} onChange={setDraft} />
      <button
        type="submit"
        disabled={!loaded || fields === null}
        className={`self-end ${TEXT_BUTTON}`}
      >
        Add event
      </button>
    </form>
  )
}

/** What the list hands every event for drag and drop. */
interface EventDrag {
  dropTarget: boolean
  onDragStart: (event: DragEvent<HTMLLIElement>) => void
  onDragOver: (event: DragEvent<HTMLLIElement>) => void
  onDragLeave: () => void
  onDrop: (event: DragEvent<HTMLLIElement>) => void
  onDragEnd: () => void
}

/** One event of the list: read view or its edit form, its linked nodes, and its year warning. */
function EventItem({
  event,
  nodeIds,
  ages,
  conflicts,
  warning,
  onStep,
  drag
}: {
  event: TimelineEvent
  nodeIds: readonly string[]
  ages: readonly EventAge[]
  conflicts: readonly LocationConflict[]
  warning: boolean
  onStep: (step: -1 | 1) => void
  drag: EventDrag
}): React.JSX.Element {
  const update = useTimelineStore((s) => s.update)
  const remove = useTimelineStore((s) => s.remove)
  const [draft, setDraft] = useState<EventDraft | null>(null)
  const fields = draft === null ? null : fieldsOf(draft)

  const onKeyDown = (keyEvent: KeyboardEvent<HTMLLIElement>): void => {
    // Only the item itself moves: Alt+Arrow inside a field keeps its usual meaning.
    if (keyEvent.target !== keyEvent.currentTarget || !keyEvent.altKey) return
    if (keyEvent.key !== 'ArrowUp' && keyEvent.key !== 'ArrowDown') return
    keyEvent.preventDefault()
    onStep(keyEvent.key === 'ArrowUp' ? -1 : 1)
  }

  const onDelete = async (): Promise<void> => {
    const ok = await dialogs.confirm({
      title: `Delete "${event.label}"?`,
      message:
        'Scenes on this event keep their timeline text, but are no longer on the timeline. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true
    })
    if (ok) await remove(event.id)
  }

  return (
    <li
      data-testid="timeline-event"
      data-event={event.id}
      data-warning={warning || undefined}
      data-drop-target={drag.dropTarget}
      aria-label={event.label}
      tabIndex={0}
      draggable={draft === null}
      onKeyDown={onKeyDown}
      onDragStart={drag.onDragStart}
      onDragOver={drag.onDragOver}
      onDragLeave={drag.onDragLeave}
      onDrop={drag.onDrop}
      onDragEnd={drag.onDragEnd}
      className="flex flex-col gap-0.5 rounded-md border border-line bg-bg p-2 data-[drop-target=true]:border-accent"
    >
      {draft !== null ? (
        <form
          aria-label="Edit event"
          className="flex flex-col gap-1"
          onSubmit={(submit) => {
            submit.preventDefault()
            if (fields === null) return
            void update(event.id, fields).then((stored) => {
              if (stored) setDraft(null)
            })
          }}
        >
          <EventFields draft={draft} onChange={setDraft} />
          <div className="flex justify-end gap-1">
            <button type="button" onClick={() => setDraft(null)} className={TEXT_BUTTON}>
              Cancel
            </button>
            <button type="submit" disabled={fields === null} className={TEXT_BUTTON}>
              Save
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex items-start gap-1">
            <div className="min-w-0 flex-1 cursor-grab">
              <p className="m-0 truncate text-sm font-medium">{event.label}</p>
              {event.when || event.year !== null ? (
                <p className="m-0 text-xs text-fg-muted">
                  {[event.when, event.year === null ? '' : `Year ${event.year}`]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              aria-label={`Edit ${event.label}`}
              title="Edit"
              onClick={() => setDraft(draftOf(event))}
              className={ICON_BUTTON}
            >
              <Pencil size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={`Delete ${event.label}`}
              title="Delete"
              onClick={() => void onDelete()}
              className={ICON_BUTTON}
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </div>
          {warning ? (
            <p className="m-0 text-xs text-warning">Year is before an earlier event</p>
          ) : null}
          {event.note ? (
            <p className="m-0 line-clamp-2 text-xs text-fg-muted">{event.note}</p>
          ) : null}
          {ages.length > 0 ? (
            <p data-testid="event-ages" className="m-0 text-xs text-fg-muted">
              Ages: {ages.map((age) => `${age.name} ${ageText(age.age)}`).join(', ')}
            </p>
          ) : null}
          {conflicts.map((conflict) => (
            <p
              key={conflict.entityId}
              role="note"
              data-testid="event-conflict"
              className="m-0 text-xs text-warning"
            >
              {conflict.name}: {conflict.locations.join(', ')}
            </p>
          ))}
        </>
      )}
      {nodeIds.length > 0 ? (
        <ul aria-label={`On ${event.label}`} className="m-0 flex list-none flex-col p-0 pl-2">
          {nodeIds.map((id) => (
            <li key={id} className="flex min-w-0">
              <NodeTitleButton id={id} />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}

/** The documents in reading order, each placed on a track by its event's position in the timeline. */
function ReadingOrderView({
  documentIds,
  eventOf
}: {
  documentIds: readonly string[]
  eventOf: EventOf
}): React.JSX.Element {
  const events = useTimelineStore((s) => s.events)
  if (documentIds.length === 0) {
    return <p className="m-0 p-3 text-sm text-fg-muted">The manuscript is empty.</p>
  }
  const rows = readingOrderRows(events, documentIds, eventOf)
  const last = Math.max(events.length - 1, 1)
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
      <ol aria-label="Reading order" className="m-0 flex list-none flex-col gap-1 p-0">
        {rows.map((row) => {
          const event = row.eventIndex === null ? undefined : events[row.eventIndex]
          return (
            <li
              key={row.id}
              data-testid="timeline-row"
              data-node={row.id}
              data-flashback={row.flashback || undefined}
              className="flex flex-col gap-0.5"
            >
              <div className="flex min-w-0 items-center gap-1">
                <NodeTitleButton id={row.id} />
                {row.flashback ? (
                  <span className="shrink-0 rounded bg-surface-raised px-1 text-xs text-warning">
                    Earlier
                  </span>
                ) : null}
                <span className="ml-auto min-w-0 truncate text-xs text-fg-muted">
                  {event?.label ?? '—'}
                </span>
              </div>
              <div aria-hidden="true" className="relative mx-1 h-1 rounded bg-surface-raised">
                {row.eventIndex === null ? null : (
                  <span
                    className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent"
                    style={{ left: `${(row.eventIndex / last) * 100}%` }}
                  />
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
