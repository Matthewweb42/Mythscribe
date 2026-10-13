import { HOW_LABEL } from '@shared/memory/knows'
import type { InstantCard } from '@shared/scribe'
import {
  holderLine,
  noHoldersText,
  readersSinceText,
  scopeText,
  type NameOf
} from '@renderer/features/memory/knows/knowsView'

/**
 * What every instant card is marked with (design §2.6): an AI-read value, quote checked, with no
 * AI call for this answer (AI rule 1's exception: derived data is marked as AI-made).
 */
export const INSTANT_CARD_LABEL = 'Read by AI from your book · quote checked · no AI call now'

/**
 * An instant card's words (F-16.24; plan P3 §4.3: plain text until slice 5 draws the card): "Mara ·
 * Eyes: grey (1.1)", a lasting value "since 12.1", a transient one "last stated in 13.4"; a
 * computed age; "Yes: Orrin overheard it from Tomas (1.1)"; who knows a secret, with the scoped
 * absence line's scope ("(checked up to 1.2)") and readers-since. The only absence words are
 * `knowsView.ts`'s scoped ones (P2b rule 9). Pure.
 */
export function instantCardLine(card: InstantCard, nameOf: NameOf): string {
  switch (card.kind) {
    case 'slot': {
      const where =
        card.since === null
          ? card.ref
          : card.lastStated
            ? `last stated in ${card.since}`
            : `since ${card.since}`
      return `${card.name} · ${card.label}: ${card.value} (${where})`
    }
    case 'age':
      return (
        `${card.name} · Age: about ${card.age} (born ${card.born.year}; ` +
        `year ${card.year.value} from ${card.year.from.ref})`
      )
    case 'knows': {
      const from = card.fromName === null ? '' : ` from ${card.fromName}`
      const how =
        card.source === 'author'
          ? 'knew it before the book'
          : card.how === 'told'
            ? `was told it${card.fromName === null ? '' : ` by ${card.fromName}`}`
            : `${HOW_LABEL[card.how]} it${from}`
      return `Yes: ${card.knowerName} ${how}${card.ref === null ? '' : ` (${card.ref})`}`
    }
    case 'whoKnows': {
      const holders =
        card.holders.length === 0
          ? noHoldersText(card.checkedUpTo)
          : `${card.holders.map((cell) => holderLine(cell, nameOf)).join('; ')} ${scopeText(card.checkedUpTo)}`
      const since =
        card.readersSince === null
          ? ''
          : ` · ${readersSinceText({ ...card.readersSince, stale: false })}`
      return `Who knows ${card.label}: ${holders}${since}`
    }
  }
}

/**
 * The chat turn's text for an instant card: its line, then its label. Slice 5 draws the card from
 * the turn's `card`, never from this text, so turns stored before then still draw.
 */
export function instantCardText(card: InstantCard, nameOf: NameOf): string {
  return `${instantCardLine(card, nameOf)}\n\n${INSTANT_CARD_LABEL}`
}
