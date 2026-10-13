import { useId, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { TimelineRow } from '@shared/memory/views'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useRecordStore } from '@renderer/features/records/recordStore'
import { useNameOf } from '../knows/useNameOf'
import { useTimeline } from '../memoryStore'
import { ageText, hintText, yearText } from './timeView'

const HEADING = 'm-0 mt-3 mb-1 text-xs font-medium tracking-wide text-fg-muted uppercase'

/**
 * The Book's **Timeline** (F-16.23; design §2.7 "Years and ages", decision 5, plan P2b §5.2): one
 * row per readable scene in reading order (Idea scenes and scenes left out of compile are not
 * rows), with its reference and title, its story year ("1811" typed, "1811 · from 1.1" carried,
 * "1812 · stated here", "flashback · 1798", "year not known since “A year later” (18.1)"), the
 * elapsed hint the scene quotes, the typed time, and the ages of who is Here ("Mara about 19");
 * *Ages of [record ▾]* shows one character's age in every row instead. A row opens its scene. Local
 * and free: computed from typed details and what the reader proved.
 */
export function TimelineView(): React.JSX.Element {
  const headingId = useId()
  const pickId = useId()
  const [recordId, setRecordId] = useState<string | null>(null)
  const characters = useRecordStore(
    useShallow((s) =>
      s.ids
        .flatMap((id) => s.byId[id] ?? [])
        .filter((record) => record.kind === 'character')
        .sort((a, b) => a.name.localeCompare(b.name))
    )
  )
  const picked = recordId !== null && characters.some((each) => each.id === recordId) ? recordId : null
  const timeline = useTimeline(picked)
  return (
    <section aria-labelledby={headingId} data-testid="timeline">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 id={headingId} className={HEADING}>
          Timeline
        </h3>
        <label htmlFor={pickId} className="text-xs text-fg-muted">
          Ages of
        </label>
        <select
          id={pickId}
          value={picked ?? ''}
          onChange={(event) => setRecordId(event.target.value === '' ? null : event.target.value)}
          className="max-w-40 min-w-0 rounded-md border border-line bg-bg px-1 py-0.5 text-xs"
        >
          <option value="">who is Here</option>
          {characters.map((record) => (
            <option key={record.id} value={record.id}>
              {record.name}
            </option>
          ))}
        </select>
      </div>
      {timeline === undefined ? (
        <p className="m-0 text-xs text-fg-muted">Reading…</p>
      ) : timeline.rows.length === 0 ? (
        <p className="m-0 text-xs text-fg-muted">No scene in the book yet.</p>
      ) : (
        <ol className="m-0 list-none p-0" aria-label="Scenes in story order">
          {timeline.rows.map((row) => (
            <Row key={row.nodeId} row={row} />
          ))}
        </ol>
      )}
    </section>
  )
}

function Row({ row }: { row: TimelineRow }): React.JSX.Element {
  const nameOf = useNameOf()
  // The scene's own hint is already in "year not known since …".
  const ownHint = row.year.kind === 'unknown' && row.year.hint?.nodeId === row.nodeId
  return (
    <li
      aria-label={`${row.ref} ${row.title}`}
      data-testid="timeline-row"
      className="border-b border-line py-1 last:border-b-0"
    >
      <button
        type="button"
        onClick={() => useTreeStore.getState().select(row.nodeId)}
        className="flex w-full min-w-0 flex-col items-start gap-0.5 rounded-md px-1 text-left hover:bg-surface-raised"
      >
        <span className="flex w-full min-w-0 items-baseline gap-2 text-sm">
          <span className="shrink-0 text-xs text-fg-muted">{row.ref}</span>
          <span className="min-w-0 flex-1 truncate">{row.title}</span>
          <span className="shrink-0 text-xs" data-testid="timeline-year">
            {yearText(row.year, row.flashback)}
          </span>
        </span>
        {row.elapsed === null || ownHint ? null : (
          <span className="text-xs text-fg-muted" data-testid="timeline-hint">
            {hintText(row.elapsed)}
          </span>
        )}
        {row.time === '' ? null : (
          <span className="text-xs text-fg-muted" data-testid="timeline-time">
            {row.time}
          </span>
        )}
        {row.ages.length === 0 ? null : (
          <span className="flex flex-wrap gap-x-2 text-xs">
            {row.ages.map((entry) => (
              <span key={entry.recordId} data-testid="timeline-age">
                {nameOf(entry.recordId)} {ageText(entry.age)}
              </span>
            ))}
          </span>
        )}
      </button>
    </li>
  )
}
