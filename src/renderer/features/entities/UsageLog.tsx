import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Entity } from '@shared/ipc/contract'
import { useSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import { useHeldSceneMeta } from '@renderer/features/editor/useHeldSceneMeta'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { listOutline } from '@renderer/features/outline/outlineRows'
import { useDocumentTagStore } from '@renderer/features/tags/documentTagStore'
import { useMentionStore } from '@renderer/features/tags/mentionStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import {
  documentsInTreeOrder,
  nodeHeading,
  type TagSceneRow
} from '@renderer/features/tags/tagUsage'
import { useTimelineStore } from '@renderer/features/timeline/timelineStore'
import { linkedEventId, nodesByEvent, type EventOf } from '@renderer/features/timeline/timelineView'
import {
  appearancesOf,
  appearsBy,
  inStoryOrder,
  locationConflicts,
  scenesSetAt
} from '@renderer/features/timeline/usageLog'
import { SceneRowButton } from './SceneRowButton'
import { inScenesLabel } from './entityView'
import { useEntityUsage } from './useEntityUsage'

type LogOrder = 'reading' | 'story'

const ORDERS: readonly { order: LogOrder; label: string }[] = [
  { order: 'reading', label: 'Reading order' },
  { order: 'story', label: 'Story order' }
]

const LABEL = 'text-xs font-medium text-fg-muted'
const EMPTY = 'm-0 text-xs text-fg-muted'

/** One log row: the F-9.4 scene row, plus whether the document's POV names the entity. */
interface LogRow extends TagSceneRow {
  nodeId: string
  pov: boolean
}

/**
 * The appearance and location logs of a character or setting page (F-11.2c), in place of the
 * F-9.4 Scenes section: "Appearances" lists every document the entity tag is linked to or its
 * name was scanned in (F-4.12) — in tree order, so the manuscript reads in reading order — and,
 * for a character, every manuscript document whose POV names it; a setting also lists the
 * "Scenes set here" (its name in Location). Rows are the F-9.4 rows (`SceneRowButton`: parent
 * folder, Tagged, ×count, jump to the first mention) with a "POV" badge. Both lists read in
 * reading order or in story order (grouped by the scenes' timeline events, the rest after). For
 * a character, a note flags each event where it appears in scenes with different locations;
 * display only, nothing is stored. Holds the manuscript documents' scene metadata while on screen.
 */
export function UsageLog({ entity }: { entity: Entity }): React.JSX.Element {
  const [order, setOrder] = useState<LogOrder>('reading')
  const events = useTimelineStore((s) => s.events)
  const index = useTreeStore(useShallow((s) => ({ rootIds: s.rootIds, childrenOf: s.childrenOf })))
  const sectionOf = useTreeStore((s) => s.sectionOf)
  const byId = useTreeStore((s) => s.byId)
  const metas = useSceneMetaStore((s) => s.docs)
  const tagIdsByNode = useDocumentTagStore((s) => s.tagIdsByNode)
  const tagId = entity.tagId
  const tagName = useTagStore((s) => (tagId === null ? null : (s.byId[tagId]?.name ?? null)))
  const mentions = useMentionStore((s) => (tagId === null ? undefined : s.byTag[tagId]))
  useEntityUsage(tagId)
  const allDocuments = useMemo(() => documentsInTreeOrder(index, byId), [index, byId])
  const manuscript = useMemo(
    () =>
      listOutline(index.rootIds, index.childrenOf, sectionOf)
        .map((row) => row.id)
        .filter((id) => byId[id]?.kind === 'document'),
    [index, sectionOf, byId]
  )
  useHeldSceneMeta(manuscript)

  const byNode = new Map((mentions ?? []).map((row) => [row.nodeId, row]))
  const povOf = (id: string): string | undefined => metas[id]?.content?.pov
  const locationOf = (id: string): string | undefined => metas[id]?.content?.location
  const tagIdsOf = (id: string): string[] | undefined => tagIdsByNode[id]
  const eventOf: EventOf = (id) => linkedEventId(events, metas[id]?.content?.eventId)
  const rowOf = (
    nodeId: string,
    how: { linked: boolean; mentions: number; pov: boolean }
  ): LogRow[] => {
    const heading = nodeHeading(nodeId, byId)
    if (!heading) return []
    const mention = byNode.get(nodeId)
    return [
      {
        id: nodeId,
        nodeId,
        ...heading,
        tagged: how.linked,
        mentionCount: how.mentions,
        // A mention row always carries at least one range; `[0, 0]` would make the jump search.
        first: mention === undefined ? null : (mention.ranges[0] ?? [0, 0]),
        pov: how.pov
      }
    ]
  }

  const appearances = appearancesOf(
    entity,
    allDocuments,
    tagIdsOf,
    (id) => byNode.get(id)?.count ?? 0,
    povOf
  ).flatMap((row) => rowOf(row.nodeId, row.how))
  const setHere =
    entity.kind === 'setting'
      ? scenesSetAt(entity.name, manuscript, locationOf).flatMap((nodeId) =>
          rowOf(nodeId, { linked: false, mentions: 0, pov: false })
        )
      : []
  const conflicts =
    entity.kind === 'character'
      ? locationConflicts(
          events,
          nodesByEvent(events, manuscript, eventOf),
          [entity],
          appearsBy(tagIdsOf, (_tagId, nodeId) => byNode.has(nodeId), povOf),
          locationOf
        )
      : []
  const labelOf = new Map(events.map((event) => [event.id, event.label]))

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className={LABEL}>Log order</span>
        <div
          role="group"
          aria-label="Log order"
          className="flex shrink-0 gap-0.5 rounded-md border border-line p-0.5"
        >
          {ORDERS.map((option) => (
            <button
              key={option.order}
              type="button"
              aria-pressed={option.order === order}
              onClick={() => setOrder(option.order)}
              className="rounded px-2 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg aria-pressed:bg-surface-raised aria-pressed:text-fg"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <LogSection
        title="Appearances"
        rows={appearances}
        order={order}
        eventOf={eventOf}
        tagName={tagName}
        lead={<p className={EMPTY}>{inScenesLabel(appearances.length)}</p>}
      >
        {conflicts.map((conflict) => (
          <p
            key={conflict.eventId}
            role="note"
            data-testid="location-conflict"
            className="m-0 text-xs text-warning"
          >
            At {labelOf.get(conflict.eventId) ?? ''}: {conflict.locations.join(', ')}
          </p>
        ))}
      </LogSection>
      {entity.kind === 'setting' ? (
        <LogSection
          title="Scenes set here"
          rows={setHere}
          order={order}
          eventOf={eventOf}
          tagName={tagName}
          lead={setHere.length === 0 ? <p className={EMPTY}>No scene is set here yet.</p> : null}
        />
      ) : null}
    </div>
  )
}

/** One log: its heading, its lead line and notes, and its rows in reading order or grouped by event. */
function LogSection({
  title,
  rows,
  order,
  eventOf,
  tagName,
  lead,
  children
}: {
  title: string
  rows: readonly LogRow[]
  order: LogOrder
  eventOf: EventOf
  tagName: string | null
  lead: React.ReactNode
  children?: React.ReactNode
}): React.JSX.Element {
  const events = useTimelineStore((s) => s.events)
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h3 className={`m-0 font-normal ${LABEL}`}>{title}</h3>
      {lead}
      {children}
      {rows.length === 0 ? null : order === 'reading' ? (
        <LogRows label={title} rows={rows} tagName={tagName} />
      ) : (
        inStoryOrder(rows, events, eventOf).map((group) => {
          const heading = group.event?.label ?? 'Not on the timeline'
          return (
            <div key={group.event?.id ?? ''} className="flex flex-col">
              <h4 className="m-0 px-2 text-xs font-medium text-fg-subtle">
                {heading}
                {group.event?.when ? ` · ${group.event.when}` : ''}
              </h4>
              <LogRows label={`${title}: ${heading}`} rows={group.rows} tagName={tagName} />
            </div>
          )
        })
      )}
    </section>
  )
}

/** The rows of a log, as the F-9.4 rows plus a "POV" badge. */
function LogRows({
  label,
  rows,
  tagName
}: {
  label: string
  rows: readonly LogRow[]
  tagName: string | null
}): React.JSX.Element {
  return (
    <ul role="list" aria-label={label} className="m-0 list-none p-0">
      {rows.map((row) => (
        <li key={row.nodeId}>
          <SceneRowButton row={row} tagName={tagName}>
            {row.pov ? <span className="shrink-0 text-xs text-fg-subtle">POV</span> : null}
          </SceneRowButton>
        </li>
      ))}
    </ul>
  )
}
