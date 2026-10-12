import { useId } from 'react'
import type { TrueNowView } from '@shared/memory/views'
import { ClaimLine } from '@renderer/features/memory/ClaimLine'
import { useMemoryStore, type SceneEntry } from '@renderer/features/memory/memoryStore'
import { lineText, staleNote, trueNowNote } from '@renderer/features/memory/memoryView'
import { useRecordStore } from '@renderer/features/records/recordStore'

const HEADING = 'm-0 mt-3 mb-1 text-xs font-medium tracking-wide text-fg-muted uppercase'

/**
 * **True now** (F-16.18; design §2.2): for each record Here or Mentioned, what the book has stated
 * up to and including this scene. A lasting value reads "since 12.1" (the scene that set it), a
 * transient one "last stated in 13.4". A line whose sentence changed since it was read is dimmed,
 * "re-checking after you pause", or "reading paused" while reading cannot run (design §2.10).
 * Every line has ⓘ and *Not right* (`ClaimLine`). Nothing shows for a record nothing was read
 * about; an absence is never a line.
 */
export function TrueNow({ entry }: { entry: SceneEntry }): React.JSX.Element | null {
  const headingId = useId()
  const byId = useRecordStore((s) => s.byId)
  const paused = useMemoryStore((s) => s.status?.paused ?? null)
  const order = [
    ...new Set([
      ...entry.here.map((chip) => chip.recordId),
      ...entry.mentioned.map((chip) => chip.recordId)
    ])
  ]
  const groups = order.flatMap((recordId) => {
    const record = byId[recordId]
    const lines = entry.trueNow.filter((line) => line.recordId === recordId)
    return record === undefined || lines.length === 0 ? [] : [{ record, lines }]
  })
  if (groups.length === 0) return null
  const words = (line: TrueNowView): string => {
    const object = line.objectId === null ? null : (byId[line.objectId]?.name ?? null)
    return lineText(line.label, object === null ? line.value : `${line.value} (of ${object})`)
  }
  return (
    <section aria-labelledby={headingId} data-testid="true-now">
      <h3 id={headingId} className={HEADING}>
        True now
      </h3>
      {groups.map(({ record, lines }) => (
        <div key={record.id} role="group" aria-label={`True now: ${record.name}`} className="mb-1">
          <h4 className="m-0 text-xs font-medium">{record.name}</h4>
          <ul className="m-0 list-none p-0">
            {lines.map((line) => (
              <ClaimLine
                key={line.claimId}
                claimId={line.claimId}
                text={words(line)}
                note={trueNowNote(line)}
                stale={line.stale}
                staleNote={staleNote(paused)}
                recordId={line.recordId}
              />
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}
