import { useState } from 'react'
import { Info } from 'lucide-react'
import { ClaimInfoCard } from './ClaimInfo'
import { NotRightChoices } from './NotRight'

const SMALL =
  'rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg aria-expanded:bg-surface-raised aria-expanded:text-fg'

/**
 * One AI line (F-16.18): its words, a note ("since 12.1"), and, every time, **ⓘ** (where it comes
 * from: `ClaimInfoCard`) and **Not right** (`NotRightChoices`). A stale line (its sentence changed
 * since it was read) is dimmed with why ("re-checking after you pause", or "reading paused").
 */
export function ClaimLine({
  claimId,
  text,
  note = null,
  stale = false,
  staleNote = null,
  recordId,
  as: Tag = 'li'
}: {
  claimId: string
  /** The line's words ("Eyes: grey"). */
  text: string
  note?: string | null
  stale?: boolean
  staleNote?: string | null
  /** Whose line it is (Not about offers the others). */
  recordId: string | null
  as?: 'li' | 'div'
}): React.JSX.Element {
  const [open, setOpen] = useState<'info' | 'notRight' | null>(null)
  const toggle = (which: 'info' | 'notRight'): void =>
    setOpen((current) => (current === which ? null : which))
  return (
    <Tag
      data-testid="claim-line"
      data-stale={stale ? 'true' : undefined}
      className="flex min-w-0 flex-wrap items-baseline gap-x-1 py-0.5 text-sm"
    >
      <span className={stale ? 'text-fg-muted opacity-60' : undefined}>{text}</span>
      {note === null ? null : <span className="text-xs text-fg-muted">{note}</span>}
      {stale && staleNote !== null ? (
        <span className="text-xs text-fg-subtle italic">{staleNote}</span>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          aria-label={`Where this comes from: ${text}`}
          title="Where this comes from"
          aria-expanded={open === 'info'}
          onClick={() => toggle('info')}
          className={`${SMALL} flex items-center`}
        >
          <Info size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-expanded={open === 'notRight'}
          onClick={() => toggle('notRight')}
          className={SMALL}
        >
          Not right
        </button>
      </span>
      {open === 'info' ? <ClaimInfoCard claimId={claimId} /> : null}
      {open === 'notRight' ? (
        <NotRightChoices claimId={claimId} recordId={recordId} onDone={() => setOpen(null)} />
      ) : null}
    </Tag>
  )
}
