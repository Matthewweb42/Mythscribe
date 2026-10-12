import { useId, useMemo, useState } from 'react'
import type { SheetLineView, SheetMemory } from '@shared/memory/views'
import { isManuscriptDocument, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { ClaimLine } from '@renderer/features/memory/ClaimLine'
import { useMemoryStore, useSheetMemory } from '@renderer/features/memory/memoryStore'
import { lineText, otherLineText, staleNote } from '@renderer/features/memory/memoryView'
import { listOutline } from '@renderer/features/outline/outlineRows'
import { useRecordStore } from './recordStore'

const HEADING = 'm-0 text-xs font-semibold tracking-wide text-fg-muted uppercase'
const GROUP = 'm-0 mt-2 mb-0.5 text-[11px] font-medium text-fg-muted'

/** The groups in the order a sheet shows them, with their headings. */
const GROUPS: { key: 'fixed' | 'lasting' | 'transient' | 'accumulating'; heading: string }[] = [
  { key: 'fixed', heading: 'Fixed' },
  { key: 'lasting', heading: 'Lasting' },
  { key: 'transient', heading: 'Last seen' },
  { key: 'accumulating', heading: 'Over time' }
]

/** A line's note: "since 12.1", "last stated in 13.4", or the scene it was read from. */
function noteOf(group: (typeof GROUPS)[number]['key'], line: SheetLineView): string {
  if (group === 'lasting' && line.since !== null) return `since ${line.since}`
  if (group === 'transient' && line.since !== null) return `last stated in ${line.since}`
  return line.value.ref
}

/**
 * A sheet's **From the book, as of [scene ▾]** (F-16.18; design §2.2, §2.7): what the active
 * draft's prose states about the record up to and including the scene picked (by default the
 * scene open in the editor, else the end of the book): fixed values (differing ones side by side,
 * "also “grey” 2.1"), lasting ones "since 12.1", transient ones "last stated in 13.4", the ones
 * that accumulate, then **In other voices** muted (what someone says, thinks, remembers, dreams;
 * never state), and "3 more lines later in the book". Every line has ⓘ and *Not right*. Read from
 * main (`memory:sheet`), again when a reading names the record.
 */
export function FromTheBook({ recordId }: { recordId: string }): React.JSX.Element {
  const pickId = useId()
  const open = useTreeStore((s) =>
    s.selectedId !== null && isManuscriptDocument(s, s.selectedId) ? s.selectedId : null
  )
  const [asOf, setAsOf] = useState<string | null>(open)
  const rootIds = useTreeStore((s) => s.rootIds)
  const childrenOf = useTreeStore((s) => s.childrenOf)
  const sectionOf = useTreeStore((s) => s.sectionOf)
  const byId = useTreeStore((s) => s.byId)
  const scenes = useMemo(
    () =>
      listOutline(rootIds, childrenOf, sectionOf).flatMap(({ id }) => {
        const node = byId[id]
        return node !== undefined && isManuscriptDocument({ byId, sectionOf }, id)
          ? [{ id, title: node.title.trim() === '' ? 'Untitled scene' : node.title }]
          : []
      }),
    [rootIds, childrenOf, sectionOf, byId]
  )
  const picked = asOf !== null && scenes.some((scene) => scene.id === asOf) ? asOf : null
  const sheet = useSheetMemory(recordId, picked)
  return (
    <section aria-label="From the book" className="flex flex-col gap-1" data-testid="from-the-book">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className={HEADING}>From the book</h3>
        <label htmlFor={pickId} className="text-xs text-fg-muted">
          as of
        </label>
        <select
          id={pickId}
          value={picked ?? ''}
          onChange={(event) => setAsOf(event.target.value === '' ? null : event.target.value)}
          className="max-w-56 min-w-0 rounded-md border border-line bg-bg px-1 py-0.5 text-xs"
        >
          <option value="">the end of the book</option>
          {scenes.map((scene) => (
            <option key={scene.id} value={scene.id}>
              {scene.title}
            </option>
          ))}
        </select>
      </div>
      {sheet === undefined ? (
        <p className="m-0 text-xs text-fg-muted">Reading…</p>
      ) : (
        <SheetLines sheet={sheet} />
      )}
    </section>
  )
}

function SheetLines({ sheet }: { sheet: SheetMemory }): React.JSX.Element {
  const records = useRecordStore((s) => s.byId)
  const paused = useMemoryStore((s) => s.status?.paused ?? null)
  const nameOf = (id: string | null): string | null =>
    id === null ? null : (records[id]?.name ?? null)
  const valueWords = (value: string, objectId: string | null): string => {
    const object = nameOf(objectId)
    return object === null ? value : `${value} (of ${object})`
  }
  const empty = GROUPS.every(({ key }) => sheet[key].length === 0) && sheet.others.length === 0
  return (
    <>
      {empty ? (
        <p className="m-0 text-xs text-fg-muted">
          {sheet.asOf === null
            ? 'Nothing read about them yet.'
            : 'Nothing read about them up to this scene.'}
        </p>
      ) : null}
      {GROUPS.map(({ key, heading }) =>
        sheet[key].length === 0 ? null : (
          <div key={key} role="group" aria-label={heading}>
            <h4 className={GROUP}>{heading}</h4>
            <ul className="m-0 list-none p-0">
              {sheet[key].map((line) => (
                <li key={line.value.claimId} className="list-none">
                  <ClaimLine
                    as="div"
                    claimId={line.value.claimId}
                    text={lineText(line.label, valueWords(line.value.value, line.objectId))}
                    note={noteOf(key, line)}
                    stale={line.value.stale}
                    staleNote={staleNote(paused)}
                    recordId={sheet.recordId}
                  />
                  {line.also.map((also) => (
                    <div key={also.claimId} className="pl-4">
                      <ClaimLine
                        as="div"
                        claimId={also.claimId}
                        text={`also “${also.value}”`}
                        note={also.ref}
                        stale={also.stale}
                        staleNote={staleNote(paused)}
                        recordId={sheet.recordId}
                      />
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        )
      )}
      {sheet.others.length === 0 ? null : (
        <div role="group" aria-label="In other voices" className="opacity-75">
          <h4 className={GROUP}>In other voices</h4>
          <ul className="m-0 list-none p-0">
            {sheet.others.map((line) => (
              <ClaimLine
                key={line.claimId}
                claimId={line.claimId}
                text={otherLineText(
                  { ...line, value: valueWords(line.value, line.objectId) },
                  nameOf(line.speakerId)
                )}
                note={line.ref}
                stale={line.stale}
                staleNote={staleNote(paused)}
                recordId={sheet.recordId}
              />
            ))}
          </ul>
        </div>
      )}
      {sheet.later === 0 ? null : (
        <p className="m-0 mt-1 text-xs text-fg-muted" data-testid="later-lines">
          {sheet.later} more line{sheet.later === 1 ? '' : 's'} later in the book
        </p>
      )}
    </>
  )
}
