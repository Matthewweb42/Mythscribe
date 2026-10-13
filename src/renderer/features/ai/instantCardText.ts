import { HOW_LABEL } from '@shared/memory/knows'
import type { InstantCard } from '@shared/scribe'
import { holderLine, readersSinceText, type NameOf } from '@renderer/features/memory/knows/knowsView'

/**
 * What every instant card is marked with (design §2.6): an AI-read value, quote checked, with no
 * AI call for this answer (AI rule 1's exception: derived data is marked as AI-made).
 */
export const INSTANT_CARD_LABEL = 'Read by AI from your book · quote checked · no AI call now'
/** A computed age's mark: worked out from a birth year and a story year, not read as one value. */
export const AGE_CARD_LABEL = 'Computed from your book · no AI call now'
/** The author's own *Knew before the book* mark answering "does A know X": nothing AI-read. */
export const AUTHOR_CARD_LABEL = 'From what you marked · no AI call now'

/** The mark under a card: AI-read and quote checked, computed, or the author's own mark. */
export function instantCardLabel(card: InstantCard): string {
  if (card.kind === 'age') return AGE_CARD_LABEL
  if (card.kind === 'knows' && card.source === 'author') return AUTHOR_CARD_LABEL
  return INSTANT_CARD_LABEL
}

/** A value with where the book says it: "Eyes: grey (1.1)", "(since 12.1)", "(last stated in 13.4)". */
export function slotLine(card: Extract<InstantCard, { kind: 'slot' }>): string {
  const where =
    card.since === null
      ? card.ref
      : card.lastStated
        ? `last stated in ${card.since}`
        : `since ${card.since}`
  return `${card.label}: ${card.value} (${where})`
}

/** A computed age: "Age: about 19 (born 1795; year 1814 from 1.2)". */
export function ageLine(card: Extract<InstantCard, { kind: 'age' }>): string {
  return `Age: about ${card.age} (born ${card.born.year}; year ${card.year.value} from ${card.year.from.ref})`
}

/** "Yes: Orrin overheard it from Tomas (1.1)"; the author's mark "Yes: Tomas knew it before the book". */
export function knowsLine(card: Extract<InstantCard, { kind: 'knows' }>): string {
  const from = card.fromName === null ? '' : ` from ${card.fromName}`
  const how =
    card.source === 'author'
      ? 'knew it before the book'
      : card.how === 'told'
        ? `was told it${card.fromName === null ? '' : ` by ${card.fromName}`}`
        : `${HOW_LABEL[card.how]} it${from}`
  return `Yes: ${card.knowerName} ${how}${card.ref === null ? '' : ` (${card.ref})`}`
}

/**
 * An instant card as the chat turn's text (F-16.24): "Mara · Eyes: grey (1.1)", a computed age,
 * "Yes: Orrin overheard it from Tomas (1.1)", who knows a secret with its holders and
 * readers-since. The turn's text rides along with later requests as conversation history, so it
 * holds positive lines only: never the scoped absence line nor `checkedUpTo` (P2b rule 9, P3
 * rule 5), which only the drawn card shows (`InstantCard.tsx`). Pure.
 */
export function instantCardLine(card: InstantCard, nameOf: NameOf): string {
  switch (card.kind) {
    case 'slot':
      return `${card.name} · ${slotLine(card)}`
    case 'age':
      return `${card.name} · ${ageLine(card)}`
    case 'knows':
      return knowsLine(card)
    case 'whoKnows': {
      const holders =
        card.holders.length === 0
          ? ''
          : `: ${card.holders.map((cell) => holderLine(cell, nameOf)).join('; ')}`
      const since =
        card.readersSince === null
          ? ''
          : ` · ${readersSinceText({ ...card.readersSince, stale: false })}`
      return `Who knows ${card.label}${holders}${since}`
    }
  }
}

/**
 * The chat turn's text for an instant card: its line, then its mark. The chat draws the card from
 * the turn's `card` (slice 5), never from this text.
 */
export function instantCardText(card: InstantCard, nameOf: NameOf): string {
  return `${instantCardLine(card, nameOf)}\n\n${instantCardLabel(card)}`
}
