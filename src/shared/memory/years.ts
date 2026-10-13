import type { ReadingOrder } from './asOf'
import type { ClaimMode, ClaimState, ClaimVoice } from './claims'
import { ageAt } from '../timeline'
import { locateInText } from './quote'
import type {
  AgeSinceView,
  AgeView,
  BornView,
  ElapsedHintView,
  KnownYearView,
  YearView
} from './views'

/**
 * Story years and ages (F-16.23; design §2.7 "Years and ages", decision 5), pure:
 * - a typed story year carries forward, skipping flashbacks, until the next typed year or an
 *   elapsed hint that can cross a year (P2b-D14);
 * - a year the text states (the card's verified `year`) applies to its own scene only;
 * - an age is the birth year plus the scene's year ("about 19, year from 1.1"); otherwise the last
 *   stated age, with the year-crossing hints and the year changes since listed, never added up;
 * - an elapsed hint is shown in the book's words (its quote), never the reader's value, and ends
 *   the carry when either its value or its quote can cross a year (a vague value cannot keep a
 *   false carry).
 * Ages always say "about" (P2b-D15): a birth year and a story year do not say whether the birthday
 * has passed. Nothing here is sent to a model.
 */

/** Counts written as words, one to nineteen (and "a", "an", "dozen"). */
const UNITS: Readonly<Record<string, number>> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  dozen: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19
}

/** The tens written as words; "twenty-four" and "twenty four" add a unit to them. */
const TENS: Readonly<Record<string, number>> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100
}

/** A count in one word: digits, a unit, a tens word, or a hyphenated "twenty-four"; else null. */
function countWord(word: string): number | null {
  if (/^\d+$/.test(word)) return Number(word)
  const unit = UNITS[word]
  if (unit !== undefined) return unit
  const tens = TENS[word]
  if (tens !== undefined) return tens
  const [head = '', tail = '', ...rest] = word.split('-')
  const compound = TENS[head]
  const ones = UNITS[tail]
  return rest.length === 0 && compound !== undefined && ones !== undefined && ones < 10
    ? compound + ones
    : null
}

/**
 * The count of months a span names, from the words before "month(s)": a number in digits or words
 * ("18", "fifteen", "twenty-four", "twenty four", "an eighteen-month"); `few` for "a few" or "a
 * couple of" (under six); `vague` for none or a vague one ("Months later", "some", "several",
 * "many", "the months that followed").
 */
function monthCount(before: string): number | 'few' | 'vague' {
  const words = before
    .split(/[^a-z0-9-]+/)
    .map((word) => word.replace(/^-+|-+$/g, ''))
    .filter((word) => word !== '')
  if (words.at(-1) === 'of') words.pop()
  const last = words.at(-1)
  if (last === undefined) return 'vague'
  if (last === 'few' || last === 'couple') return 'few'
  const count = countWord(last)
  if (count === null) return 'vague'
  const tens = TENS[words.at(-2) ?? '']
  return tens !== undefined && count < 10 ? tens + count : count
}

/** Units that cross a year whatever their count: years, seasons, decades, generations. */
const YEAR_UNITS =
  /\b(?:years?|twelvemonths?|winters?|summers?|springs?|autumns?|seasons?|decades?|generations?|lifetimes?)\b/

/** A long span with no number: "long after", "much later", "long afterwards". */
const LONG_VAGUE = /\b(?:long after(?:wards?)?|much later|long years|ages later)\b/

/** A month span: "month" (counted only) or "months". */
const MONTHS = /\bmonth(s?)\b/g

/**
 * Whether an elapsed hint can cross a year (P2b-D14), so it ends the year carry and is listed for
 * ages: years, winters, summers, springs, autumns, seasons, decades or generations ("Three winters
 * later", "a year later", "years later"), six months or more in digits or words ("six months",
 * "18 months later", "Fifteen months later", "twenty-four months"), a month span with no count or
 * a vague one ("Months later", "some months": unknown is safe, a false carry is not), or a long
 * vague span ("long after", "much later"). Hours, days, weeks, fewer than six months ("a few
 * months", "two months"), "that month", "the next morning" or "that evening" do not.
 */
export function elapsedBreaks(hint: string): boolean {
  const text = hint.toLowerCase().replace(/[‘’]/g, "'")
  if (YEAR_UNITS.test(text) || LONG_VAGUE.test(text)) return true
  for (const match of text.matchAll(MONTHS)) {
    const count = monthCount(text.slice(0, match.index))
    if (typeof count === 'number' ? count >= 6 : count === 'vague' && match[1] === 's') {
      return true
    }
  }
  return false
}

/** The one 3- or 4-digit year a value names ("1812", "the spring of 1812"); null for none or two. */
export function yearIn(text: string): number | null {
  const found = [...text.matchAll(/(?<![\p{L}\p{N}])(\d{3,4})(?![\p{L}\p{N}])/gu)].map((match) =>
    Number(match[1])
  )
  return found.length === 1 ? (found[0] ?? null) : null
}

/** A card's elapsed hint as it stands on the text: the reader's value, its quote and paragraph. */
export interface ElapsedSource {
  value: string
  quote: string
  para: number
}

/**
 * An elapsed hint's words as the book has them: the value where the quote contains it, in any
 * case ("Three winters later" in "Three winters later, Mara found the heir."), else the whole
 * quote. The reader's own words are never shown as the book's.
 */
export function hintWords(source: ElapsedSource): string {
  const quote = source.quote.trim()
  const lower = quote.toLowerCase()
  // Lower case keeps the offsets only where it keeps the length (it does for nearly every text).
  const at =
    lower.length === quote.length
      ? locateInText(lower, source.value.toLowerCase())
      : locateInText(quote, source.value)
  return at === null ? quote : quote.slice(at.start, at.end)
}

/** One readable scene as `storyYears` reads it, in reading order. */
export interface YearRow {
  nodeId: string
  ref: string
  /** The author's typed story year (scene details). */
  typedYear: number | null
  /** The held card's year field, when it stands on the text and was verified. */
  quotedYear: string | null
  /** The held card says (verified) the scene is a flashback. */
  flashback: boolean
  /** The held card's elapsed hint, when it stands on the text ("Three winters later"). */
  elapsed: ElapsedSource | null
}

/** A scene's year and its elapsed hint as `storyYears` answers them. */
export interface StoryYear {
  nodeId: string
  ref: string
  year: YearView
  flashback: boolean
  elapsed: ElapsedHintView | null
}

/**
 * Every readable scene's story year (decision 5), in reading order:
 * - a flashback takes neither the carry nor ends it; its own typed or quoted year applies to it
 *   alone (else not known);
 * - a typed year is the scene's (`typed`) and starts the carry from it;
 * - otherwise an elapsed hint that crosses a year ends the carry; a quoted year is the scene's
 *   (`quoted`, its scene only); else the carry (`carried`, from its scene); else not known, with
 *   the hint that ended the carry (null before the first typed year).
 */
export function storyYears(rows: readonly YearRow[]): StoryYear[] {
  let carry: KnownYearView | null = null
  let ended: ElapsedHintView | null = null
  return rows.map((row) => {
    const here = { nodeId: row.nodeId, ref: row.ref }
    const source = row.elapsed
    const elapsed: ElapsedHintView | null =
      source === null || source.quote.trim() === ''
        ? null
        : {
            text: hintWords(source),
            quote: source.quote,
            para: source.para,
            ...here,
            breaks: elapsedBreaks(source.value) || elapsedBreaks(source.quote)
          }
    const quoted = row.quotedYear === null ? null : yearIn(row.quotedYear)
    let year: YearView
    if (row.flashback) {
      year =
        row.typedYear !== null
          ? { kind: 'typed', value: row.typedYear, from: here }
          : quoted !== null
            ? { kind: 'quoted', value: quoted, from: here }
            : { kind: 'unknown', hint: null }
    } else if (row.typedYear !== null) {
      year = { kind: 'typed', value: row.typedYear, from: here }
      carry = { kind: 'carried', value: row.typedYear, from: here }
      ended = null
    } else {
      if (elapsed?.breaks === true) {
        carry = null
        ended = elapsed
      }
      year =
        quoted !== null
          ? { kind: 'quoted', value: quoted, from: here }
          : (carry ?? { kind: 'unknown', hint: ended })
    }
    return { nodeId: row.nodeId, ref: row.ref, year, flashback: row.flashback, elapsed }
  })
}

/** A claim as the age rules read it (`born` and `age` slots). */
export interface AgeClaim {
  id: string
  value: string
  voice: ClaimVoice
  mode: ClaimMode
  state: ClaimState
  nodeId: string
  para: number
}

/** Live narration in `now` mode (what may set a birth year or a stated age). */
const stands = (claim: AgeClaim): boolean =>
  claim.state === 'live' && claim.voice === 'narration' && claim.mode === 'now'

/** The claims in readable scenes up to the scene, in reading order. */
function upTo(claims: readonly AgeClaim[], reading: ReadingOrder, atId: string | null): AgeClaim[] {
  const at = atId === null ? Infinity : (reading.at.get(atId) ?? -1)
  return claims
    .flatMap((claim) => {
      const order = reading.order.get(claim.nodeId)
      return order === undefined || order > at ? [] : [{ claim, order }]
    })
    .sort((a, b) => a.order - b.order || a.claim.para - b.claim.para)
    .map((entry) => entry.claim)
}

/**
 * A Pinned line giving a birth year: "Born: 1792", "Born (story year): 1792" (the switch-over's
 * form of the v1 field); never a canon sentence that merely opens with "Born".
 */
const BORN_LINE = /^\s*born(?:\s*\([^)\n]*\))?\s*:\s*(.+)$/i

/** The Pinned paragraphs that give a birth year ("Born: 1792"): what a Pinned save may move. */
export const bornLines = (pinned: readonly string[]): string[] =>
  pinned.filter((paragraph) => BORN_LINE.test(paragraph))

/**
 * A record's birth year as of a scene (P2b-D15): the latest live narration-now `born` claim up to
 * the scene with exactly one year in its value; else a canon Pinned line "Born: 1792" (the
 * switch-over's form of the v1 field, so the ages she had keep working); else null. `pinned` is
 * the record's canon Pinned paragraphs (Not canon ones left out by the caller).
 */
export function birthYear(
  claims: readonly AgeClaim[],
  pinned: readonly string[],
  reading: ReadingOrder,
  atId: string | null
): BornView | null {
  const text = upTo(claims, reading, atId)
    .filter((claim) => stands(claim) && yearIn(claim.value) !== null)
    .at(-1)
  if (text !== undefined) {
    return {
      year: yearIn(text.value) ?? 0,
      source: 'text',
      claimId: text.id,
      nodeId: text.nodeId,
      ref: reading.refs.get(text.nodeId) ?? ''
    }
  }
  for (const paragraph of pinned) {
    const match = BORN_LINE.exec(paragraph)
    const year = match === null ? null : yearIn(match[1] ?? '')
    if (year !== null) return { year, source: 'pinned', claimId: null, nodeId: null, ref: null }
  }
  return null
}

/** The last stated age as of a scene: the latest live narration-now `age` claim up to it. */
export function statedAge(
  claims: readonly AgeClaim[],
  reading: ReadingOrder,
  atId: string | null
): AgeClaim | null {
  return upTo(claims, reading, atId).filter(stands).at(-1) ?? null
}

/** The scene a "since then" entry is in. */
export const sinceNodeId = (entry: AgeSinceView): string =>
  entry.kind === 'hint' ? entry.hint.nodeId : entry.nodeId

/**
 * What changed in the scenes after `fromId` up to and including `atId` (null: the end of the
 * book), in reading order, flashbacks left out: each year-crossing hint, and each typed or quoted
 * year that differs from the year before it ("1820 (1.3)"). What a stated age lists "since then"
 * and never adds up.
 */
export function changesSince(
  years: readonly StoryYear[],
  fromId: string,
  atId: string | null
): AgeSinceView[] {
  const from = years.findIndex((row) => row.nodeId === fromId)
  const to = atId === null ? years.length - 1 : years.findIndex((row) => row.nodeId === atId)
  if (from === -1 || to === -1) return []
  const start = years[from]?.year
  let running: number | null = start === undefined || start.kind === 'unknown' ? null : start.value
  const since: AgeSinceView[] = []
  for (const row of years.slice(from + 1, to + 1)) {
    if (row.flashback) continue
    if (row.elapsed?.breaks === true) since.push({ kind: 'hint', hint: row.elapsed })
    const { year } = row
    if ((year.kind === 'typed' || year.kind === 'quoted') && year.value !== running) {
      since.push({ kind: 'year', value: year.value, nodeId: row.nodeId, ref: row.ref })
    }
    running = year.kind === 'unknown' ? null : year.value
  }
  return since
}

/**
 * A character's age as of a scene (decision 5): with a birth year and the scene's known year, the
 * age (`ageAt`; negative is "not born yet"); else the last stated age with what changed since;
 * else, with a birth year, the birth year alone and why the scene's year is not known
 * (`bornOnly`); else null.
 */
export function ageAsOf(input: {
  born: BornView | null
  year: YearView | null
  stated: { claim: AgeClaim; ref: string } | null
  since: readonly AgeSinceView[]
}): AgeView | null {
  const { born, year, stated } = input
  if (born !== null && year !== null && year.kind !== 'unknown') {
    const age = ageAt(born.year, year.value)
    const known = { kind: year.kind, value: year.value, from: year.from }
    return age < 0
      ? { kind: 'notBorn', born, year: known }
      : { kind: 'computed', age, born, year: known }
  }
  if (stated !== null) {
    return {
      kind: 'stated',
      value: stated.claim.value,
      claimId: stated.claim.id,
      nodeId: stated.claim.nodeId,
      ref: stated.ref,
      since: [...input.since]
    }
  }
  if (born === null) return null
  return { kind: 'bornOnly', born, hint: year?.kind === 'unknown' ? year.hint : null }
}

/**
 * One record's age as of a scene, from its `born` and `age` claims, its canon Pinned paragraphs,
 * the book's story years (`storyYears`) and the reading order: what the Timeline, a sheet and
 * P3's navigator read. `atId` null: the end of the book. "The last stated age" is in story time:
 * outside a flashback, an age stated in a flashback (earlier in story time) is left out; in a
 * flashback, only an age stated in that scene stands (else nothing, unless its own year computes
 * one).
 */
export function recordAge(input: {
  born: readonly AgeClaim[]
  ages: readonly AgeClaim[]
  pinned: readonly string[]
  years: readonly StoryYear[]
  reading: ReadingOrder
  atId: string | null
}): AgeView | null {
  const { reading, years, atId } = input
  const at = atId === null ? Infinity : (reading.at.get(atId) ?? -1)
  // The scene's own year: an Idea scene or one left out of compile reads as the one before it.
  const row = years.filter((each) => (reading.order.get(each.nodeId) ?? Infinity) <= at).at(-1)
  const flashbacks = new Set(years.flatMap((each) => (each.flashback ? [each.nodeId] : [])))
  const ages =
    row?.flashback === true
      ? input.ages.filter((claim) => claim.nodeId === row.nodeId)
      : input.ages.filter((claim) => !flashbacks.has(claim.nodeId))
  const stated = statedAge(ages, reading, atId)
  return ageAsOf({
    born: birthYear(input.born, input.pinned, reading, atId),
    year: row?.year ?? null,
    stated: stated === null ? null : { claim: stated, ref: reading.refs.get(stated.nodeId) ?? '' },
    since: stated === null ? [] : changesSince(years, stated.nodeId, row?.nodeId ?? atId)
  })
}
