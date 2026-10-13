import { useId } from 'react'
import { KNOWER_KINDS } from '@shared/memory/knows'
import type { KnowsCellView, SceneRefView, SceneSecretView } from '@shared/memory/views'
import { ClaimLine } from '../ClaimLine'
import { useMemoryStore, type SceneEntry } from '../memoryStore'
import { staleNote } from '../memoryView'
import {
  absenceLine,
  holderLine,
  moreText,
  readersSinceText,
  tensionText,
  type NameOf
} from './knowsView'
import { TopicInfoButton } from './TopicInfo'
import { useNameOf } from './useNameOf'

const HEADING = 'm-0 mt-3 mb-1 text-xs font-medium tracking-wide text-fg-muted uppercase'
const SMALL =
  'rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40'

/**
 * This scene's **Who knows what** (F-16.22; design §2.5, P2b-D21), after True now: each secret the
 * scene touches, with ⓘ (`TopicInfoButton`) and "readers since 1.1", its holders Here as lines with
 * ⓘ and *Not right* ("Orrin: overheard from Tomas (1.1)"; the author's own "Tomas: knew before the
 * book (you said)"), then, muted, for each one Here with no line that counts, "No scene shows Mara
 * learning this (checked up to 1.2)"; then up to 3 tension lines and "+ N more in Book", which
 * opens the Book tab at the grid. Nothing shows when the scene touches no secret and has no
 * tension. Absence is only ever this scoped, muted line.
 */
export function WhoKnowsWhat({
  entry,
  onOpenBook
}: {
  entry: SceneEntry
  onOpenBook: () => void
}): React.JSX.Element | null {
  const headingId = useId()
  const nameOf = useNameOf()
  const { touched, tension, more, checkedUpTo } = entry.secrets
  if (touched.length === 0 && tension.length === 0) return null
  const here = new Set(entry.here.map((chip) => chip.recordId))
  return (
    <section aria-labelledby={headingId} data-testid="who-knows-what">
      <h3 id={headingId} className={HEADING}>
        Who knows what
      </h3>
      {touched.map((each) => (
        <TouchedSecret
          key={each.secret.recordId}
          touched={each}
          here={here}
          nameOf={nameOf}
          checkedUpTo={checkedUpTo}
        />
      ))}
      {tension.length === 0 ? null : (
        <ul className="m-0 mt-1 list-none p-0" aria-label="Tension">
          {tension.map((line) => (
            <li
              key={`${line.kind}:${line.secretId}:${line.recordId}`}
              data-testid="tension-line"
              data-stale={line.stale ? 'true' : undefined}
              className={`py-0.5 text-xs ${line.stale ? 'text-fg-muted opacity-60' : 'text-fg-muted'}`}
            >
              {tensionText(line, nameOf, checkedUpTo)}
            </li>
          ))}
        </ul>
      )}
      {more === 0 ? null : (
        <button type="button" className={`${SMALL} mt-1`} onClick={onOpenBook}>
          {moreText(more)}
        </button>
      )}
    </section>
  )
}

function TouchedSecret({
  touched,
  here,
  nameOf,
  checkedUpTo
}: {
  touched: SceneSecretView
  here: ReadonlySet<string>
  nameOf: NameOf
  checkedUpTo: SceneRefView | null
}): React.JSX.Element {
  const paused = useMemoryStore((s) => s.status?.paused ?? null)
  const { secret, without } = touched
  const holders = secret.cells.filter((cell) => !cell.later && here.has(cell.knowerId))
  return (
    <div role="group" aria-label={`Who knows ${secret.label}`} className="mb-2">
      <div className="flex flex-wrap items-baseline gap-x-1">
        <h4 className="m-0 text-sm font-medium">{secret.label}</h4>
        {secret.readersSince === null ? null : (
          <span
            className={`text-xs text-fg-muted ${secret.readersSince.stale ? 'opacity-60' : ''}`}
            data-testid="readers-since"
          >
            {readersSinceText(secret.readersSince)}
          </span>
        )}
        <span className="ml-auto" />
        <TopicInfoButton topic={secret} kind="secret" />
      </div>
      <ul className="m-0 list-none p-0">
        {holders.map((cell) => (
          <HolderLine key={cell.knowerId} cell={cell} nameOf={nameOf} paused={paused} />
        ))}
        {without.map((recordId) => (
          <li
            key={recordId}
            data-testid="absence-line"
            className="py-0.5 text-xs text-fg-muted italic"
          >
            {absenceLine(nameOf(recordId), checkedUpTo)}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** One holder: an AI line with ⓘ and *Not right*, or the author's own mark as plain words. */
function HolderLine({
  cell,
  nameOf,
  paused
}: {
  cell: KnowsCellView
  nameOf: NameOf
  paused: Parameters<typeof staleNote>[0]
}): React.JSX.Element {
  if (cell.claimId === null) {
    return (
      <li className="py-0.5 text-sm" data-testid="holder-line">
        {holderLine(cell, nameOf)}
      </li>
    )
  }
  return (
    <ClaimLine
      claimId={cell.claimId}
      text={holderLine(cell, nameOf)}
      stale={cell.stale}
      staleNote={staleNote(paused)}
      recordId={cell.knowerId}
      notAboutKinds={KNOWER_KINDS}
      muted={cell.line === 'partial'}
    />
  )
}
