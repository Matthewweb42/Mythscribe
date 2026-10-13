import { useState } from 'react'
import { KNOWER_KINDS } from '@shared/memory/knows'
import type { KnowsSheetLine } from '@shared/memory/views'
import { ClaimLine } from '@renderer/features/memory/ClaimLine'
import { knowsLineText, otherKnowsText } from '@renderer/features/memory/knows/knowsView'
import { useNameOf } from '@renderer/features/memory/knows/useNameOf'
import { useMemoryStore, useSheetMemory } from '@renderer/features/memory/memoryStore'
import { staleNote } from '@renderer/features/memory/memoryView'
import { AsOfPicker } from './AsOfPicker'
import { useAsOf } from './asOf'

const HEADING = 'm-0 text-xs font-semibold tracking-wide text-fg-muted uppercase'
const GROUP = 'm-0 mt-2 mb-0.5 text-[11px] font-medium text-fg-muted'
const SMALL =
  'rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40'

/**
 * A character's or group's **Knows, as of [scene ▾]** (F-16.22; design §2.7, plan P2b §4.2): its
 * line about each secret as of the scene, each with ⓘ and *Not right* ("the sold map: overheard
 * from Tomas", noted "1.1"; half-knowing ones muted), the author's *Knew before the book* marks
 * with *Remove*, the lines that never count apart (someone else's words, a rumour, a dream), and
 * "2 more later in the book". Never a line for a secret it has none for.
 */
export function KnowsSection({ recordId }: { recordId: string }): React.JSX.Element {
  const { asOf, scenes, setAsOf } = useAsOf()
  const sheet = useSheetMemory(recordId, asOf)
  const knows = sheet?.knows ?? null
  const nameOf = useNameOf()
  const paused = useMemoryStore((s) => s.status?.paused ?? null)
  const empty =
    knows !== null && knows.lines.length === 0 && knows.others.length === 0 && knows.later === 0
  return (
    <section aria-label="Knows" className="flex flex-col gap-1" data-testid="knows-section">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className={HEADING}>Knows</h3>
        <AsOfPicker scenes={scenes} value={asOf} onChange={setAsOf} />
      </div>
      {sheet === undefined ? (
        <p className="m-0 text-xs text-fg-muted">Reading…</p>
      ) : knows === null || empty ? (
        <p className="m-0 text-xs text-fg-muted">No lines about secrets up to here.</p>
      ) : (
        <>
          <ul className="m-0 list-none p-0">
            {knows.lines.map((line) =>
              line.cell.claimId === null ? (
                <AuthorMark key={line.secretId} line={line} recordId={recordId} />
              ) : (
                <ClaimLine
                  key={line.secretId}
                  claimId={line.cell.claimId}
                  text={knowsLineText(line.label, line.cell, nameOf)}
                  note={line.cell.ref}
                  stale={line.cell.stale}
                  staleNote={staleNote(paused)}
                  recordId={recordId}
                  notAboutKinds={KNOWER_KINDS}
                  muted={line.cell.line === 'partial'}
                />
              )
            )}
          </ul>
          {knows.others.length === 0 ? null : (
            <div role="group" aria-label="Not counted as knowing" className="opacity-75">
              <h4 className={GROUP}>Not counted as knowing</h4>
              <ul className="m-0 list-none p-0">
                {knows.others.map((line) =>
                  line.cell.claimId === null ? null : (
                    <ClaimLine
                      key={line.cell.claimId}
                      claimId={line.cell.claimId}
                      text={otherKnowsText(line.label, line.cell, nameOf)}
                      note={line.cell.ref}
                      stale={line.cell.stale}
                      staleNote={staleNote(paused)}
                      recordId={recordId}
                      notAboutKinds={KNOWER_KINDS}
                      muted
                    />
                  )
                )}
              </ul>
            </div>
          )}
          {knows.later === 0 ? null : (
            <p className="m-0 mt-1 text-xs text-fg-muted" data-testid="knows-later-lines">
              {knows.later} more later in the book
            </p>
          )}
        </>
      )}
    </section>
  )
}

/** The author's *Knew before the book* on a secret, with *Remove*. */
function AuthorMark({
  line,
  recordId
}: {
  line: KnowsSheetLine
  recordId: string
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <li className="flex items-baseline gap-1 py-0.5 text-sm">
      <span>{line.label}: knew before the book (you said)</span>
      <button
        type="button"
        className={`${SMALL} ml-auto`}
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void useMemoryStore
            .getState()
            .knewBefore(line.secretId, recordId, false)
            .finally(() => setBusy(false))
        }}
      >
        Remove
      </button>
    </li>
  )
}
