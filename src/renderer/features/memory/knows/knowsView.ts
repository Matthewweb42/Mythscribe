import { HOW_LABEL, FROM_HOWS } from '@shared/memory/knows'
import type {
  KnowsCellView,
  SceneRefView,
  SecretView,
  SinceView,
  TensionLine,
  TopicQuoteView
} from '@shared/memory/views'
import { formatCents } from '@renderer/features/ai/usageFormat'
import { shortDate } from '../memoryView'

/**
 * The words of who knows what (F-16.22; design §2.5, plan P2b §4.2): how a holder's line, a grid
 * cell, a tension line, "readers since" and ⓘ on a secret read. Absence is never a fact (P2b rule
 * 9): main's views carry only what was proved and `checkedUpTo`, and this file is the one place the
 * scoped words "No scene shows Mara learning this (checked up to 14.2)" are made. Nothing here
 * reaches a prompt. Pure.
 */

/** A record's name, or a stand-in when it is gone. */
export type NameOf = (recordId: string | null) => string

/** "(checked up to 14.2)", or "(not checked yet)" while the book's first scene is unread. */
export function scopeText(checkedUpTo: SceneRefView | null): string {
  return checkedUpTo === null ? '(not checked yet)' : `(checked up to ${checkedUpTo.ref})`
}

/** The muted scoped line: "No scene shows Mara learning this (checked up to 14.2)". */
export function absenceLine(name: string, checkedUpTo: SceneRefView | null): string {
  return `No scene shows ${name} learning this ${scopeText(checkedUpTo)}`
}

/** "readers since 1.1". */
export function readersSinceText(since: SinceView): string {
  return `readers since ${since.ref}`
}

/**
 * How a knower knows: "overheard from Tomas", "told by Orrin", "knew before", "suspects",
 * "believes otherwise"; the author's mark: "knew before the book".
 */
export function howText(cell: KnowsCellView, nameOf: NameOf): string {
  if (cell.source === 'author') return 'knew before the book'
  const words = HOW_LABEL[cell.how]
  if (cell.fromId === null || !FROM_HOWS.includes(cell.how)) return words
  return cell.how === 'told'
    ? `told by ${nameOf(cell.fromId)}`
    : `${words} from ${nameOf(cell.fromId)}`
}

/**
 * A holder's line in This scene and on a secret's sheet: "Orrin: overheard from Tomas (1.1)";
 * the author's mark: "Tomas: knew before the book (you said)".
 */
export function holderLine(cell: KnowsCellView, nameOf: NameOf): string {
  const name = nameOf(cell.knowerId)
  if (cell.source === 'author') return `${name}: knew before the book (you said)`
  return `${name}: ${howText(cell, nameOf)} (${cell.ref ?? ''})`
}

/** A knower's own line on its sheet: "the sold map: overheard from Tomas", noted "1.1". */
export function knowsLineText(label: string, cell: KnowsCellView, nameOf: NameOf): string {
  return `${label}: ${howText(cell, nameOf)}`
}

/** A line that never counts, apart: "the sold map: Tomas says it (refers to it)", rumoured, dreamt. */
export function otherKnowsText(label: string, cell: KnowsCellView, nameOf: NameOf): string {
  const how = HOW_LABEL[cell.how]
  if (cell.voice === 'dialogue') return `${label}: ${nameOf(cell.speakerId)} says it (${how})`
  if (cell.voice === 'thought') return `${label}: ${nameOf(cell.speakerId)} thinks it (${how})`
  if (cell.voice === 'rumour') return `${label}: as rumour (${how})`
  if (cell.mode === 'dream') return `${label}: in a dream (${how})`
  if (cell.mode === 'hypothetical') return `${label}: only supposed (${how})`
  return `${label}: ${how}`
}

/**
 * A grid cell: "overheard 9.3", "suspects 7.1", "believes otherwise 8.2", "knew before 2.1" (the
 * text says so), "knew before the book (you)", "learns later (17.3)".
 */
export function cellText(cell: KnowsCellView): string {
  if (cell.source === 'author') return 'knew before the book (you)'
  if (cell.later) return `learns later (${cell.ref ?? ''})`
  return `${HOW_LABEL[cell.how]} ${cell.ref ?? ''}`.trim()
}

/**
 * A tension line (P2b-D21), its "has none" scoped by what was checked: "Readers know the sold map
 * (since 1.1); no scene shows Mara (POV) learning it (checked up to 1.2)", or "Orrin knows the sold
 * map; no scene shows Lise learning it (checked up to 1.2)".
 */
export function tensionText(
  line: TensionLine,
  nameOf: NameOf,
  checkedUpTo: SceneRefView | null
): string {
  const scope = scopeText(checkedUpTo)
  if (line.kind === 'readersKnow') {
    const since = line.since === null ? '' : ` (since ${line.since.ref})`
    return `Readers know ${line.label}${since}; no scene shows ${nameOf(line.recordId)} (POV) learning it ${scope}`
  }
  return `${nameOf(line.holderId)} knows ${line.label}; no scene shows ${nameOf(line.recordId)} learning it ${scope}`
}

/** "+ 9 more in Book". */
export const moreText = (more: number): string => `+ ${more} more in Book`

/** A sidebar row's note for a secret: "readers since 5.2 · 3 know"; "not in the book yet". */
export function secretSummary(secret: SecretView | undefined): string {
  if (secret === undefined) return ''
  const holders = secret.cells.filter((cell) => !cell.later && cell.line === 'counts').length
  const since =
    secret.readersSince === null ? 'not in the book yet' : readersSinceText(secret.readersSince)
  return holders === 0 ? since : `${since} · ${holders} know`
}

/**
 * ⓘ on a reveal: where it is and how it was checked; a merged one says it was judged the same
 * ("also read as “the map sale” in 1.2: judged the same by a second AI read"); the reading's cost.
 */
export function revealLines(quote: TopicQuoteView, kind: 'secret' | 'thread'): string[] {
  const lines =
    quote.role === 'merged'
      ? [`also read as “${quote.label}” in ${quote.ref}: judged the same by a second AI read`]
      : [
          `${kind === 'secret' ? 'Revealed' : 'Opened'} in ${quote.ref} ¶${quote.para + 1}`,
          'checked by a second AI read'
        ]
  if (quote.reading !== null) {
    lines.push(
      `read on ${shortDate(new Date(quote.reading.created))}; that reading cost ${formatCents(quote.reading.costUsd)} (${quote.reading.model})`
    )
  }
  if (quote.stale) lines.push('its sentence changed since: re-checking')
  return lines
}
