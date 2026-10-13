import { useId, useState } from 'react'
import { KNOWER_KINDS } from '@shared/memory/knows'
import { SECRET_CATEGORY_ID } from '@shared/memory/topics'
import type { KnowsCellView, KnowsGrid as KnowsGridView, SecretView } from '@shared/memory/views'
import { openRecordSheet } from '@renderer/features/records/openRecord'
import { useRecordStore } from '@renderer/features/records/recordStore'
import { ClaimLine } from '../ClaimLine'
import { useKnowsGrid, useMemoryStore } from '../memoryStore'
import { staleNote } from '../memoryView'
import { absenceLine, cellText, holderLine, readersSinceText, type NameOf } from './knowsView'
import { useNameOf } from './useNameOf'

const HEADING = 'm-0 mt-3 mb-1 text-xs font-medium tracking-wide text-fg-muted uppercase'
const SMALL =
  'rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40'
const CELL =
  'w-full min-w-24 rounded px-1 py-0.5 text-left hover:bg-surface-raised aria-pressed:bg-surface-raised'

/** The cell the author opened: a secret's row and a knower's column. */
interface Picked {
  secretId: string
  knowerId: string
}

/**
 * The Book's **Who knows what** grid (F-16.22; design §2.5, P2b-D20) as of the scene the Book tab
 * is read as of: one row per secret readers know by then (newest first; a row's label opens the
 * secret's sheet), one column per character or group with a line or a knew-before mark, plus the
 * scene's POV; the first column stays put while the table scrolls sideways in its own box. A cell
 * reads "overheard 9.3", "suspects 7.1", "believes otherwise 8.2", "knew before 2.1", "knew before
 * the book (you)" or, muted, "learns later (17.3)"; picking one opens it below the grid: ⓘ and *Not
 * right* for a line; *Remove* for the author's mark; for an empty cell ("—", its title the scoped
 * "No scene shows Mara learning this (checked up to 14.2)"), *Knew before the book*.
 */
export function KnowsGrid({ asOf }: { asOf: string | null }): React.JSX.Element {
  const headingId = useId()
  const grid = useKnowsGrid(asOf)
  const nameOf = useNameOf()
  const [picked, setPicked] = useState<Picked | null>(null)
  return (
    <section aria-labelledby={headingId} data-testid="knows-grid">
      <h3 id={headingId} className={HEADING}>
        Who knows what
      </h3>
      {grid === undefined ? (
        <p className="m-0 text-xs text-fg-muted">Reading…</p>
      ) : grid.rows.length === 0 ? (
        <p className="m-0 text-xs text-fg-muted">
          {grid.asOf === null
            ? 'No secret found in the book yet.'
            : 'No secret readers know yet at this scene.'}
        </p>
      ) : (
        <Table grid={grid} nameOf={nameOf} picked={picked} onPick={setPicked} />
      )}
      {grid === undefined || grid.later === 0 ? null : (
        <p className="m-0 mt-1 text-xs text-fg-muted" data-testid="knows-later">
          {grid.later} more later in the book
        </p>
      )}
      {grid === undefined || picked === null ? null : (
        <CellDetail grid={grid} picked={picked} nameOf={nameOf} onDone={() => setPicked(null)} />
      )}
    </section>
  )
}

function Table({
  grid,
  nameOf,
  picked,
  onPick
}: {
  grid: KnowsGridView
  nameOf: NameOf
  picked: Picked | null
  onPick: (picked: Picked | null) => void
}): React.JSX.Element {
  return (
    <div
      role="region"
      aria-label="Who knows what, by secret and person"
      tabIndex={0}
      className="max-w-full overflow-x-auto rounded-md border border-line"
    >
      <table className="border-collapse text-xs">
        <thead>
          <tr>
            <th
              scope="col"
              className="sticky left-0 z-10 border-b border-line bg-panel px-1 py-0.5 text-left font-medium"
            >
              Secret
            </th>
            {grid.columns.map((id) => (
              <th
                key={id}
                scope="col"
                className="border-b border-line px-1 py-0.5 text-left font-medium whitespace-nowrap"
              >
                {nameOf(id)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.rows.map((row) => (
            <tr key={row.recordId}>
              <th
                scope="row"
                className="sticky left-0 z-10 bg-panel px-1 py-0.5 text-left align-top font-normal"
              >
                <button
                  type="button"
                  className="text-left hover:underline"
                  title={row.readersSince === null ? undefined : readersSinceText(row.readersSince)}
                  onClick={() => openRecordSheet(row.recordId, SECRET_CATEGORY_ID)}
                >
                  {row.label}
                </button>
              </th>
              {grid.columns.map((knowerId) => (
                <td key={knowerId} className="px-0.5 py-0.5 align-top">
                  <KnowsCell
                    row={row}
                    knowerId={knowerId}
                    nameOf={nameOf}
                    checkedUpTo={grid.checkedUpTo}
                    pressed={picked?.secretId === row.recordId && picked.knowerId === knowerId}
                    onPick={() =>
                      onPick(
                        picked?.secretId === row.recordId && picked.knowerId === knowerId
                          ? null
                          : { secretId: row.recordId, knowerId }
                      )
                    }
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** A knower's cell in a secret's row; "—" with the scoped absence as its title when it has none. */
export function KnowsCell({
  row,
  knowerId,
  nameOf,
  checkedUpTo,
  pressed,
  onPick
}: {
  row: SecretView
  knowerId: string
  nameOf: NameOf
  checkedUpTo: KnowsGridView['checkedUpTo']
  pressed: boolean
  onPick: () => void
}): React.JSX.Element {
  const cell = row.cells.find((each) => each.knowerId === knowerId)
  const name = nameOf(knowerId)
  if (cell === undefined) {
    const absent = absenceLine(name, checkedUpTo)
    return (
      <button
        type="button"
        aria-pressed={pressed}
        aria-label={`${name}, ${row.label}: ${absent}`}
        title={absent}
        onClick={onPick}
        className={`${CELL} text-fg-subtle`}
      >
        —
      </button>
    )
  }
  const text = cellText(cell)
  const muted = cell.later || cell.line === 'partial' || cell.stale
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={`${name}, ${row.label}: ${text}`}
      onClick={onPick}
      data-later={cell.later ? 'true' : undefined}
      className={`${CELL} whitespace-nowrap ${muted ? 'text-fg-muted' : ''} ${cell.stale ? 'opacity-60' : ''}`}
    >
      {text}
    </button>
  )
}

/** The picked cell, opened below the grid with what can be done there. */
function CellDetail({
  grid,
  picked,
  nameOf,
  onDone
}: {
  grid: KnowsGridView
  picked: Picked
  nameOf: NameOf
  onDone: () => void
}): React.JSX.Element | null {
  const paused = useMemoryStore((s) => s.status?.paused ?? null)
  const kind = useRecordStore((s) => s.byId[picked.knowerId]?.kind)
  const [busy, setBusy] = useState(false)
  const row = grid.rows.find((each) => each.recordId === picked.secretId)
  if (row === undefined) return null
  const cell: KnowsCellView | undefined = row.cells.find(
    (each) => each.knowerId === picked.knowerId
  )
  const mark = async (knew: boolean): Promise<void> => {
    setBusy(true)
    const done = await useMemoryStore.getState().knewBefore(row.recordId, picked.knowerId, knew)
    setBusy(false)
    if (done) onDone()
  }
  return (
    <div
      role="group"
      aria-label={`${nameOf(picked.knowerId)} and ${row.label}`}
      data-testid="knows-cell-detail"
      className="mt-1 flex flex-wrap items-center gap-1 rounded-md border border-line bg-surface px-2 py-1.5 text-xs"
    >
      {cell === undefined ? (
        <>
          <span className="text-fg-muted italic">
            {absenceLine(nameOf(picked.knowerId), grid.checkedUpTo)}
          </span>
          {kind !== undefined && KNOWER_KINDS.includes(kind) ? (
            <button type="button" className={SMALL} disabled={busy} onClick={() => void mark(true)}>
              Knew before the book
            </button>
          ) : null}
        </>
      ) : cell.claimId === null ? (
        <>
          <span>{holderLine(cell, nameOf)}</span>
          <button type="button" className={SMALL} disabled={busy} onClick={() => void mark(false)}>
            Remove
          </button>
        </>
      ) : (
        <ClaimLine
          as="div"
          claimId={cell.claimId}
          text={holderLine(cell, nameOf)}
          stale={cell.stale}
          staleNote={staleNote(paused)}
          recordId={cell.knowerId}
          notAboutKinds={KNOWER_KINDS}
          muted={cell.line === 'partial' || cell.later}
        />
      )}
    </div>
  )
}
