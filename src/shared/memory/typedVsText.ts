import { straightenQuotes } from '../critique'
import type { CardField, CardFields } from './claims'
import type { SceneDetails } from './sceneDetails'

/**
 * Decision 4 (F-16.18): the manuscript is canon, so where the text's quoted value disagrees with a
 * typed POV, place, time or year, the text's value shows, with the typed one dimmed ("you typed:
 * the harbour"), and one conflict is asked about once (F-16.18's *Update my detail · Keep mine*).
 * Pure: the card's fields against the scene's typed details.
 *
 * Only what the verifier confirmed counts for POV and year (they feed computation: a POV the AI
 * read never anchors a claim); place and time are compared on their quoted value.
 */

export const TYPED_FIELDS = ['pov', 'place', 'time', 'year'] as const
export type TypedField = (typeof TYPED_FIELDS)[number]

/**
 * `same`: they agree. `textOnly`: only the text says it. `typedOnly`: only the author typed it.
 * `differs`: both say it and disagree. `none`: neither says anything.
 */
export type TypedOutcome = 'same' | 'textOnly' | 'typedOnly' | 'differs' | 'none'

export interface TypedComparison {
  outcome: TypedOutcome
  /** The typed value as shown (a record's name, the place text, the year), or null. */
  typed: string | null
  /** The text's value as shown, or null. */
  text: string | null
  /** The quote the text's value rests on. */
  quote: string | null
}

/** What the comparison needs to know about records: their names, and every name they go by. */
export interface TypedNames {
  nameOf: (recordId: string) => string | null
  aliasesOf: (recordId: string) => readonly string[]
}

/** The form place and time words are compared in: lower case, straight quotes, no articles or punctuation. */
export function foldDetail(text: string): string {
  return straightenQuotes(text.normalize('NFC'))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word !== '' && word !== 'the' && word !== 'a' && word !== 'an')
    .join(' ')
}

/** Whether folded `haystack` holds folded `needle` as whole words. */
function holds(haystack: string, needle: string): boolean {
  if (needle === '' || haystack === '') return false
  return ` ${haystack} `.includes(` ${needle} `)
}

const outcomeOf = (typed: boolean, text: boolean, same: boolean): TypedOutcome => {
  if (!typed && !text) return 'none'
  if (!text) return 'typedOnly'
  if (!typed) return 'textOnly'
  return same ? 'same' : 'differs'
}

const shown = (field: CardField | null, verifiedOnly: boolean): CardField | null =>
  field === null || (verifiedOnly && !field.verified) ? null : field

function comparePov(
  details: SceneDetails,
  card: CardFields | null,
  names: TypedNames
): TypedComparison {
  const field = shown(card?.pov ?? null, true)
  const typed = details.povRecordId
  return {
    outcome: outcomeOf(typed !== null, field !== null, typed === field?.value),
    typed: typed === null ? null : names.nameOf(typed),
    text: field === null ? null : (names.nameOf(field.value) ?? null),
    quote: field?.quote ?? null
  }
}

function comparePlace(
  details: SceneDetails,
  card: CardFields | null,
  names: TypedNames
): TypedComparison {
  const field = shown(card?.where ?? null, false)
  const { recordId, text } = details.place
  const typedNames = [
    ...(recordId === null ? [] : [names.nameOf(recordId) ?? '', ...names.aliasesOf(recordId)]),
    text
  ]
    .map(foldDetail)
    .filter((name) => name !== '')
  const quoted = field === null ? '' : foldDetail(field.value)
  const same = typedNames.some((name) => holds(quoted, name) || holds(name, quoted))
  const typed = recordId === null ? text.trim() : (names.nameOf(recordId) ?? text.trim())
  return {
    outcome: outcomeOf(typedNames.length > 0, field !== null, same),
    typed: typed === '' ? null : typed,
    text: field?.value ?? null,
    quote: field?.quote ?? null
  }
}

function compareTime(details: SceneDetails, card: CardFields | null): TypedComparison {
  const field = shown(card?.when ?? null, false)
  const typed = foldDetail(details.time.text)
  const quoted = field === null ? '' : foldDetail(field.value)
  return {
    outcome: outcomeOf(typed !== '', field !== null, holds(quoted, typed) || holds(typed, quoted)),
    typed: details.time.text.trim() === '' ? null : details.time.text.trim(),
    text: field?.value ?? null,
    quote: field?.quote ?? null
  }
}

function compareYear(details: SceneDetails, card: CardFields | null): TypedComparison {
  const field = shown(card?.year ?? null, true)
  const year = field === null ? null : Number.parseInt(field.value, 10)
  const text = year === null || Number.isNaN(year) ? null : year
  return {
    outcome: outcomeOf(details.storyYear !== null, text !== null, details.storyYear === text),
    typed: details.storyYear === null ? null : String(details.storyYear),
    text: text === null ? null : String(text),
    quote: text === null ? null : (field?.quote ?? null)
  }
}

/** Each typed field against the card's (`card` null: the scene has no card yet). */
export function compareTyped(
  details: SceneDetails,
  card: CardFields | null,
  names: TypedNames
): Record<TypedField, TypedComparison> {
  return {
    pov: comparePov(details, card, names),
    place: comparePlace(details, card, names),
    time: compareTime(details, card),
    year: compareYear(details, card)
  }
}

/** The scene line the v2 prompts and the Story notes block use: the text's value where quoted. */
export interface EffectiveSceneLine {
  pov: string | null
  place: string | null
  time: string | null
  year: string | null
  /** The fields whose value comes from the text (the rest are typed). */
  fromText: TypedField[]
}

/**
 * The effective scene line (decision 4): each field's text value where only the text says it or
 * the text disagrees (`textOnly`, `differs`), else the typed value (the author's own words when
 * they agree).
 */
export function effectiveSceneLine(
  comparison: Record<TypedField, TypedComparison>
): EffectiveSceneLine {
  const fromText: TypedField[] = []
  const pick = (field: TypedField): string | null => {
    const entry = comparison[field]
    if (entry.outcome === 'textOnly' || entry.outcome === 'differs') {
      fromText.push(field)
      return entry.text
    }
    return entry.typed
  }
  return {
    pov: pick('pov'),
    place: pick('place'),
    time: pick('time'),
    year: pick('year'),
    fromText
  }
}
