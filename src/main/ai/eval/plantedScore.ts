import { activeDraftId } from '../../draft/draftStore'
import { lastReading } from '../../memory/reading/readingStore'
import { TEST_BOOK_LABELS } from '../../memory/testBook/labels'
import type { TestBookProject } from '../../memory/testBook/project'
import {
  liveFacts,
  nameOf,
  negativesStored,
  neverRead,
  overlaps,
  sceneOf,
  slotOf
} from './memoryOracle'

/**
 * The live planted-error run's measures (F-16.17; plan P2a §2.7), read from what a reading of the
 * test book stored: its live facts against the labels, and the readings' own yields. Shared by
 * `memory.eval.ts` (the planted-error run, `-- memory`) and `switchover.eval.ts` (the switch-over
 * run, `-- switchover`, whose bars include these on the converted book), so the two runs judge a
 * reading by the same numbers. Test support only: nothing in the app imports it.
 */

/** The live run's pass bars (decided by Claude, unconfirmed; plan P2a §2.7). */
export const PLANTED_PASS_BARS = {
  quotesFound: 0.9,
  verifierPass: 0.8,
  attribution: 0.95,
  literalPrecision: 0.98,
  /** Verified claims on a labelled sentence, with the label's record (2026-10-12 review). */
  supportPrecision: 0.9
} as const

/** A share: how many of how many. */
export interface Part {
  right: number
  of: number
}

export interface PlantedMeasures {
  /** Proposed items whose quote stood in the text (the readings' yields). */
  quotesFound: Part
  /** Items sent to the checker that it passed. */
  verifierPass: Part
  /** Stored facts on a labelled sentence and slot, with the label's subject. */
  attribution: Part
  /** Literal facts that are a labelled fact about the label's record. */
  literalPrecision: Part
  /** Verified facts on a labelled sentence that the label proves, about its record. */
  supportPrecision: Part
  /** Stored facts on no labelled sentence, each as a line to read by hand. */
  unreviewed: string[]
  /** Live facts stored. */
  facts: number
  /** Claims from the scenes never read (the Idea scene, the cut scene, the inactive draft). */
  strays: number
  /** Negatives the labels forbid, stored live. */
  falseAlarms: string[]
  /** Readings cut off at their cap (finish_reason length), and readings. */
  cut: Part
}

const share = (right: number, of: number): Part => ({ right, of })

/** The measures of the book's reading as it is stored now. */
export function plantedMeasures(book: TestBookProject): PlantedMeasures {
  const claims = liveFacts(book)
  // Attribution: stored facts on a labelled quote and slot, with the label's subject.
  const matched = claims.flatMap((claim) => {
    const hit = TEST_BOOK_LABELS.claims.find(
      (label) =>
        label.scene === sceneOf(book, claim.nodeId) &&
        slotOf(label) === claim.slot &&
        overlaps(label.quote, claim.quote)
    )
    return hit === undefined ? [] : [{ claim, label: hit }]
  })
  const attributed = matched.filter(
    ({ claim, label }) => book.records.get(label.record) === claim.recordId
  ).length
  const rightAbout = (claim: (typeof claims)[number]): boolean =>
    matched.some(
      (entry) =>
        entry.claim === claim &&
        entry.label.expect !== 'reject' &&
        book.records.get(entry.label.record) === claim.recordId
    )
  const literal = claims.filter((claim) => claim.proof === 'literal')
  // Support: verified claims on a labelled sentence that the label proves, about its record.
  const verifiedMatched = claims.filter(
    (claim) => claim.proof === 'verified' && matched.some((entry) => entry.claim === claim)
  )
  // Stored claims on no labelled sentence: no bar can judge them, so each is listed for review.
  const nameOfRecord = new Map([...book.records].map(([labelId, id]) => [id, nameOf.get(labelId)]))
  const unreviewed = claims
    .filter((claim) => !matched.some((entry) => entry.claim === claim))
    .map(
      (claim) =>
        `${sceneOf(book, claim.nodeId)} ¶${claim.para} ${nameOfRecord.get(claim.recordId ?? '') ?? '?'} ` +
        `${claim.slot} “${claim.value}” (${claim.proof}, ${claim.voice}, ${claim.mode}) ← “${claim.quote}”`
    )
  // The health gate's measures, from the readings' own yields.
  const readings = [...book.scenes]
    .filter(([id]) => id !== 'h10')
    .flatMap(([, node]) => {
      const reading = lastReading(book.db, node, activeDraftId(book.db))
      return reading === null ? [] : [reading]
    })
  const sum = (pick: (yields: (typeof readings)[number]['yields']) => number): number =>
    readings.reduce((total, reading) => total + pick(reading.yields), 0)
  return {
    quotesFound: share(
      sum((yields) => yields.quotesFound),
      sum((yields) => yields.items)
    ),
    verifierPass: share(
      sum((yields) => yields.verified),
      sum((yields) => yields.verifySent)
    ),
    attribution: share(attributed, matched.length),
    literalPrecision: share(literal.filter(rightAbout).length, literal.length),
    supportPrecision: share(verifiedMatched.filter(rightAbout).length, verifiedMatched.length),
    unreviewed,
    facts: claims.length,
    strays: neverRead(book).length,
    falseAlarms: negativesStored(book, claims),
    cut: share(
      readings.filter((reading) => reading.finishReason === 'length').length,
      readings.length
    )
  }
}

export const percentOf = (part: Part): string =>
  part.of === 0 ? 'n/a' : `${((part.right / part.of) * 100).toFixed(1)} %`

/** The bars the measures miss, each as a report line names it. */
export function plantedFailures(measures: PlantedMeasures): string[] {
  const failures: string[] = []
  const bar = (name: string, part: Part, min: number): void => {
    if (part.of > 0 && part.right / part.of < min) {
      failures.push(`${name} ${percentOf(part)} < ${min * 100} %`)
    }
  }
  bar('quotes found', measures.quotesFound, PLANTED_PASS_BARS.quotesFound)
  bar('verifier pass', measures.verifierPass, PLANTED_PASS_BARS.verifierPass)
  bar('attribution precision', measures.attribution, PLANTED_PASS_BARS.attribution)
  bar('literal precision', measures.literalPrecision, PLANTED_PASS_BARS.literalPrecision)
  bar('support precision', measures.supportPrecision, PLANTED_PASS_BARS.supportPrecision)
  if (measures.strays > 0) failures.push(`${measures.strays} claims from never-read scenes`)
  if (measures.falseAlarms.length > 0) {
    failures.push(`${measures.falseAlarms.length} negatives stored live`)
  }
  return failures
}

/** The report's lines for the bars (a Markdown list). */
export function plantedBarLines(measures: PlantedMeasures): string[] {
  const bars = PLANTED_PASS_BARS
  const { falseAlarms } = measures
  return [
    `- Quotes found: ${percentOf(measures.quotesFound)} (bar ${bars.quotesFound * 100} %)`,
    `- Verifier pass: ${percentOf(measures.verifierPass)} (bar ${bars.verifierPass * 100} %)`,
    `- Attribution precision: ${percentOf(measures.attribution)} (bar ${bars.attribution * 100} %)`,
    `- Literal precision: ${percentOf(measures.literalPrecision)} (bar ${bars.literalPrecision * 100} %)`,
    `- Support precision: ${percentOf(measures.supportPrecision)} (bar ${bars.supportPrecision * 100} %; verified claims on labelled sentences, the label's record)`,
    `- Stored on no labelled sentence (unreviewed, listed below): ${measures.unreviewed.length} of ${measures.facts}`,
    `- Claims from never-read scenes: ${measures.strays} (bar 0)`,
    `- Negatives stored live (false alarms): ${falseAlarms.length} (bar 0)${falseAlarms.length > 0 ? `: ${falseAlarms.join('; ')}` : ''}`
  ]
}

/** The report's closing section: the facts no bar judges, to read by hand. */
export function unreviewedLines(measures: PlantedMeasures): string[] {
  return [
    '## Unreviewed: stored on no labelled sentence',
    '',
    'No bar judges these: read each against its quote (a wrong person or an unsupported value is a',
    'failure of the run even when every bar passed).',
    '',
    ...(measures.unreviewed.length === 0
      ? ['None.']
      : measures.unreviewed.map((line) => `- ${line}`))
  ]
}
