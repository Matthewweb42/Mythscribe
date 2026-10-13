import { KNOWER_KINDS } from '@shared/memory/knows'
import type { InstantCard as InstantCardData } from '@shared/scribe'
import { ClaimLine } from '@renderer/features/memory/ClaimLine'
import { HolderLine } from '@renderer/features/memory/knows/WhoKnowsWhat'
import { readersSinceText, whoKnowsCardAbsence } from '@renderer/features/memory/knows/knowsView'
import { useNameOf } from '@renderer/features/memory/knows/useNameOf'
import { useMemoryStore } from '@renderer/features/memory/memoryStore'
import { staleNote } from '@renderer/features/memory/memoryView'
import { bornText } from '@renderer/features/memory/timeline/timeView'
import { ageLine, instantCardLabel, knowsLine, slotLine } from './instantCardText'
import { formatCents } from './usageFormat'

const NAME = 'm-0 text-xs font-medium text-fg-muted'

/**
 * An instant card in the chat (F-16.24, design §2.6, plan P3 §5): a question the memory already
 * answers, drawn from the turn's `card` with no AI call. A value ("Eyes: grey (1.1)", "since 12.1",
 * "last stated in 13.4") and a yes ("Yes: Orrin overheard it from Tomas (1.1)", with its quote) are
 * AI lines with ⓘ (the quote with *Go there*, the reading and its cost) and *Not right*
 * (`ClaimLine`); a computed age shows the AI-read birth year it counts from the same way; who knows
 * a secret lists its holders the same way (a partial line, suspects or believes otherwise, muted,
 * as the sheet lists it) with "readers since 1.1", then, muted, the scoped line from `checkedUpTo`
 * that `knowsView.ts` words ("No other scene shows anyone learning it (checked up to 14.2)"), the
 * only absence the chat shows. Under it the mark ("Read by AI from your book · quote checked · no
 * AI call now", or the computed, the author's or the mixed one, `instantCardLabel`), and "read your
 * latest change first · 0.1¢" when a changed window was read before the card.
 */
export function InstantCard({ card }: { card: InstantCardData }): React.JSX.Element {
  return (
    <div
      data-testid="instant-card"
      data-kind={card.kind}
      className="flex min-w-0 flex-col gap-1 rounded-md border border-line px-2 py-1.5"
    >
      <CardBody card={card} />
      <p data-testid="instant-card-label" className="m-0 text-[11px] text-fg-subtle">
        {instantCardLabel(card)}
      </p>
      {card.readFirst === null ? null : (
        <p data-testid="instant-card-read-first" className="m-0 text-[11px] text-fg-subtle">
          read your latest change first · {formatCents(card.readFirst.costUsd)}
        </p>
      )}
    </div>
  )
}

function CardBody({ card }: { card: InstantCardData }): React.JSX.Element {
  const nameOf = useNameOf()
  const paused = useMemoryStore((s) => s.status?.paused ?? null)
  switch (card.kind) {
    case 'slot':
      return (
        <>
          <p className={NAME}>{card.name}</p>
          <ClaimLine as="div" claimId={card.claimId} text={slotLine(card)} recordId={card.recordId} />
        </>
      )
    case 'age':
      return (
        <>
          <p className={NAME}>{card.name}</p>
          <p className="m-0 text-sm">{ageLine(card)}</p>
          {/* The birth year it counts from, as the sheet's Age shows it: an AI-read one with ⓘ
              and Not right, so a year put on the wrong character can be disputed here. */}
          {card.born.source === 'text' && card.born.claimId !== null ? (
            <ClaimLine
              as="div"
              claimId={card.born.claimId}
              text={bornText(card.born)}
              note={card.born.ref}
              staleNote={staleNote(paused)}
              recordId={card.recordId}
            />
          ) : null}
        </>
      )
    case 'knows':
      return (
        <>
          {card.claimId === null ? (
            <p className="m-0 text-sm">{knowsLine(card)}</p>
          ) : (
            <ClaimLine
              as="div"
              claimId={card.claimId}
              text={knowsLine(card)}
              recordId={card.knowerId}
              notAboutKinds={KNOWER_KINDS}
            />
          )}
          {card.quote === null ? null : (
            <q data-testid="instant-card-quote" className="text-xs text-fg-muted italic">
              {card.quote}
            </q>
          )}
        </>
      )
    case 'whoKnows':
      return (
        <>
          <div className="flex flex-wrap items-baseline gap-x-1">
            <p className="m-0 text-sm font-medium">Who knows {card.label}</p>
            {/* Live only: `instant.ts` hands a readers-since resting on re-checked evidence over. */}
            {card.readersSince === null ? null : (
              <span data-testid="readers-since" className="text-xs text-fg-muted">
                {readersSinceText({ ...card.readersSince, stale: false })}
              </span>
            )}
          </div>
          {card.holders.length === 0 ? null : (
            <ul className="m-0 list-none p-0" aria-label={`Who knows ${card.label}`}>
              {card.holders.map((cell) => (
                <HolderLine key={cell.knowerId} cell={cell} nameOf={nameOf} paused={paused} />
              ))}
            </ul>
          )}
          <p data-testid="instant-card-absence" className="m-0 text-xs text-fg-muted italic">
            {whoKnowsCardAbsence(card.holders.length, card.checkedUpTo)}
          </p>
        </>
      )
  }
}
