import { HOW_LABEL } from '@shared/memory/knows'
import type { InstantCard } from '@shared/scribe'
import { holderLine, readersSinceText, type NameOf } from '@renderer/features/memory/knows/knowsView'

/**
 * What every instant card is marked with (design §2.6): an AI-read value, quote checked, with no
 * AI call for this answer (AI rule 1's exception: derived data is marked as AI-made).
 */
export const INSTANT_CARD_LABEL = 'Read by AI from your book · quote checked · no AI call now'
/**
 * A computed age's mark: worked out from a birth year and a story year, not read as one value;
 * from the author's own Pinned birth year and a typed year.
 */
export const AGE_CARD_LABEL = 'Computed from your book · no AI call now'
/** A computed age whose birth year or story year the AI read (quote checked): still AI-made. */
export const AGE_READ_CARD_LABEL =
  'Computed from your book (read by AI · quote checked) · no AI call now'
/** The author's own *Knew before the book* marks answering "does A know X": nothing AI-read. */
export const AUTHOR_CARD_LABEL = 'From what you marked · no AI call now'
/** Who knows a secret, some holders from the author's marks and the rest read by AI. */
export const MIXED_CARD_LABEL =
  'Read by AI from your book (quote checked) and what you marked · no AI call now'

/**
 * The mark under a card: AI-read and quote checked, computed (AI-made when a year in it was read),
 * the author's own marks, or both for a who-knows card whose holders are some of each.
 */
export function instantCardLabel(card: InstantCard): string {
  switch (card.kind) {
    case 'age':
      return card.born.source === 'text' || card.year.kind !== 'typed'
        ? AGE_READ_CARD_LABEL
        : AGE_CARD_LABEL
    case 'knows':
      return card.source === 'author' ? AUTHOR_CARD_LABEL : INSTANT_CARD_LABEL
    case 'whoKnows': {
      const marked = card.holders.some((cell) => cell.source === 'author')
      const read = card.readersSince !== null || card.holders.some((cell) => cell.source !== 'author')
      if (!marked) return INSTANT_CARD_LABEL
      return read ? MIXED_CARD_LABEL : AUTHOR_CARD_LABEL
    }
    case 'slot':
      return INSTANT_CARD_LABEL
  }
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
 * rule 5), which only the drawn card shows (`InstantCard.tsx`); a who-knows card with no holder
 * is no "Who knows" heading with nothing under it (that would read as nobody), just the secret
 * and its readers-since. Pure.
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
      // Readers-since on a card rests on live evidence only (`instant.ts` hands a stale one over).
      const since =
        card.readersSince === null ? null : readersSinceText({ ...card.readersSince, stale: false })
      if (card.holders.length === 0) return since === null ? card.label : `${card.label}: ${since}`
      const holders = card.holders.map((cell) => holderLine(cell, nameOf)).join('; ')
      return `Who knows ${card.label}: ${holders}${since === null ? '' : ` · ${since}`}`
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
