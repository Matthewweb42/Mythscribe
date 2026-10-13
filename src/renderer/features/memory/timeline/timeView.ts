import { slotLabel } from '@shared/memory/slots'
import type { AgeView, BornView, ElapsedHintView, YearView } from '@shared/memory/views'

/**
 * The words of story years and ages (F-16.23; design §2.7 "Years and ages", decision 5, plan P2b
 * §5.2): a Timeline row's year, an elapsed hint, an age as the Timeline and a sheet's Age read it.
 * An age always says "about" when it is computed (a birth year and a story year do not say whether
 * the birthday has passed); a stated age lists the year-crossing hints since and never adds them
 * up. Nothing here reaches a prompt. Pure.
 */

/** An elapsed hint where it is: "“Three winters later” (14.1)". */
export function hintText(hint: ElapsedHintView): string {
  return `“${hint.text}” (${hint.ref})`
}

/**
 * A scene's year: "1811" (typed), "1811 · from 1.1" (carried), "1812 · stated here" (the text's
 * own, this scene only), "flashback · 1798", "year not known since “A year later” (18.1)".
 */
export function yearText(year: YearView, flashback: boolean): string {
  const flash = flashback ? 'flashback · ' : ''
  if (year.kind === 'unknown') {
    return `${flash}${year.hint === null ? 'year not known' : `year not known since ${hintText(year.hint)}`}`
  }
  if (flashback) return `${flash}${year.value}`
  if (year.kind === 'carried') return `${year.value} · from ${year.from.ref}`
  if (year.kind === 'quoted') return `${year.value} · stated here`
  return String(year.value)
}

/**
 * An age: "about 19 · year from 1.1"; "not born yet · year from 1.1"; "19, stated in 2.1 · since
 * then: “Three winters later” (14.1)".
 */
export function ageText(age: AgeView): string {
  if (age.kind === 'computed') return `about ${age.age} · year from ${age.year.from.ref}`
  if (age.kind === 'notBorn') return `not born yet · year from ${age.year.from.ref}`
  const since =
    age.since.length === 0 ? '' : ` · since then: ${age.since.map(hintText).join(', ')}`
  return `${age.value}, stated in ${age.ref}${since}`
}

/** Where a computed age's birth year comes from: "Born: 1792" (a line in the book, ⓘ), or the Pinned page. */
export function bornText(born: BornView): string {
  const line = `${slotLabel('born')}: ${born.year}`
  return born.source === 'pinned' ? `${line} (your Pinned line)` : line
}

/** A stated age's line ("Age: 19"), shown with its scene and ⓘ. */
export function statedText(age: Extract<AgeView, { kind: 'stated' }>): string {
  return `${slotLabel('age')}: ${age.value}`
}
