import { activeDraftId } from '../../draft/draftStore'
import { lastReading } from '../../memory/reading/readingStore'
import { readSlot, slotIsRead } from '@shared/memory/slots'
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

/**
 * The live run's pass bars (plan P2a §2.7, decided by Claude, unconfirmed; plan
 * `ReaderPrecision.md`, 2026-10-14: stored-fact precision is the author's bar, confirmed by her;
 * the checker's pass rate is reported with no bar, decided by Claude, unconfirmed).
 */
export const PLANTED_PASS_BARS = {
  /** Quotes really not in the text: refusals for an invented slot or a quote's length are apart. */
  quotesFound: 0.9,
  attribution: 0.95,
  literalPrecision: 0.98,
  /** Verified claims on a labelled sentence, with the label's record (2026-10-12 review). */
  supportPrecision: 0.9,
  /**
   * The author's bar (2026-10-14): right stored facts over every stored fact, judged by the claim
   * labels or, on unlabelled sentences, by `storedVerdicts`; a fact not judged yet counts wrong.
   */
  storedPrecision: 0.95
} as const

/**
 * Refusals that cost a reply's tokens but are no quote missing from the text (plan
 * `ReaderPrecision.md` step 1): an invented slot, a quote too short or too long, and (plan
 * `ReaderNarrow.md`) a fact in a slot the reader no longer reads. Reported, no bar.
 */
export const COST_REFUSALS = ['slot', 'tooShort', 'tooLong', 'notRead'] as const
/** Refusals for a quote that is really not where the reader said (the quotes-found bar's misses). */
export const QUOTE_MISSES = ['notFound', 'otherParagraph', 'repeated'] as const

/** A stored fact as the precision bar judges it: plain values, so a report's JSON re-scores it. */
export interface StoredFact {
  scene: string
  p: number
  /** The record's label id (`TEST_BOOK_LABELS.records`), or null for a record no label names. */
  record: string | null
  slot: string
  value: string
  quote: string
  voice: string
  mode: string
  proof: string
}

/** How the bar judged one stored fact. */
export type StoredJudgment =
  | { kind: 'label'; right: boolean; id: string }
  | { kind: 'verdict'; right: boolean; call: boolean; reason: string }
  | { kind: 'unjudged' }

/**
 * Judges one stored fact: by the claim label on its sentence and slot when there is one (right
 * when the label is no reject and names its record), else by the hand verdict on its record, slot,
 * value and sentence (`storedVerdicts`; and voice, for a verdict that names one), else not judged
 * yet.
 */
export function judgeStored(fact: StoredFact): StoredJudgment {
  const label = TEST_BOOK_LABELS.claims.find(
    (each) =>
      each.scene === fact.scene && slotOf(each) === fact.slot && overlaps(each.quote, fact.quote)
  )
  if (label !== undefined) {
    return {
      kind: 'label',
      right: label.expect !== 'reject' && label.record === fact.record,
      id: label.id
    }
  }
  const verdict = TEST_BOOK_LABELS.storedVerdicts.find(
    (each) =>
      each.scene === fact.scene &&
      each.record === fact.record &&
      slotOf(each) === fact.slot &&
      overlaps(each.quote, fact.quote) &&
      overlaps(each.value, fact.value) &&
      (each.voice === undefined || each.voice === fact.voice)
  )
  if (verdict === undefined) return { kind: 'unjudged' }
  return {
    kind: 'verdict',
    right: verdict.right,
    call: verdict.call ?? false,
    reason: verdict.reason
  }
}

/** Stored-fact precision over every stored fact (the author's bar), with what it rests on. */
export interface StoredScore {
  /** Right facts of all stored facts in the slots still read; a fact not judged yet counts wrong. */
  precision: Part
  /** The same with every judgment call (`call`) turned the other way. */
  callsTurned: Part
  /** Wrong facts, each as a line to read (the verdict's or the label's reason). */
  wrong: string[]
  /** Facts not judged yet, each as a line to judge in `storedVerdicts`. */
  unjudged: string[]
  /**
   * Stored facts in a slot the reader no longer reads (`NOT_READ_SLOTS`, plan `ReaderNarrow.md`):
   * left out of the bar, which is measured on what is still stored (an older report re-scored, or
   * a line the switch-over brought from v1).
   */
  notRead: number
}

/** Whether a stored fact's slot is one the reader still reads (`slotIsRead`). */
export function factIsRead(fact: Pick<StoredFact, 'slot'>): boolean {
  const slot = readSlot(fact.slot)
  return slot !== null && slotIsRead(slot)
}

const factLine = (fact: StoredFact): string =>
  `${fact.scene} ¶${fact.p} ${nameOf.get(fact.record ?? '') ?? '?'} ${fact.slot} “${fact.value}” ` +
  `(${fact.proof}, ${fact.voice}, ${fact.mode}) ← “${fact.quote}”`

/** Scores stored facts against the labels and verdicts (also from a report's JSON `stored`). */
export function scoreStored(all: readonly StoredFact[]): StoredScore {
  const facts = all.filter(factIsRead)
  let right = 0
  let turned = 0
  const wrong: string[] = []
  const unjudged: string[] = []
  for (const fact of facts) {
    const judged = judgeStored(fact)
    if (judged.kind === 'unjudged') {
      unjudged.push(factLine(fact))
      continue
    }
    if (judged.right) right += 1
    const call = judged.kind === 'verdict' && judged.call
    if (judged.right !== call) turned += 1
    if (!judged.right) {
      const why = judged.kind === 'label' ? `label ${judged.id}` : judged.reason
      wrong.push(`${factLine(fact)}: ${why}${call ? ' (judgment call)' : ''}`)
    }
  }
  return {
    precision: share(right, facts.length),
    callsTurned: share(turned, facts.length),
    wrong,
    unjudged,
    notRead: all.length - facts.length
  }
}

/** A share: how many of how many. */
export interface Part {
  right: number
  of: number
}

export interface PlantedMeasures {
  /**
   * Quotes found in the text of those that were looked for: refusals for an invented slot or a
   * quote's length (`COST_REFUSALS`) are left out, only `QUOTE_MISSES` count against it.
   */
  quotesFound: Part
  /** Items proposed, and those refused for slot or length (a cost, reported with no bar). */
  costRefusals: { items: number; byReason: Record<string, number> }
  /** Items sent to the checker that it passed (an efficiency figure: reported, no bar). */
  verifierPass: Part
  /** The author's bar: right stored facts over every stored fact (`scoreStored`). */
  stored: StoredScore
  /** Every live fact as the bar judged it (the report's JSON, so it can be re-scored). */
  storedFacts: StoredFact[]
  /** Stored facts on a labelled sentence and slot, with the label's subject. */
  attribution: Part
  /**
   * Literal facts that are a labelled fact about the label's record, or (on no labelled sentence)
   * that a verdict judges right.
   */
  literalPrecision: Part
  /** Verified facts on a labelled sentence that the label proves, about its record. */
  supportPrecision: Part
  /** Stored facts on no labelled sentence, each as a line to read by hand. */
  unreviewed: string[]
  /** Live facts stored. */
  facts: number
  /** Claims from the scenes never read (the Idea scene, the cut scene, the inactive draft). */
  strays: number
  /** Those claims, each as a line to read (scene, record, slot, value, quote). */
  strayLines: string[]
  /** Negatives the labels forbid, stored live. */
  falseAlarms: string[]
  /**
   * Readings left cut off at the cap (a reply cut and not recovered by its re-read, so paragraphs
   * or verdicts were lost; the reading's `finishReason` is `length`), and readings.
   */
  cut: Part
  /** Readings with a reply cut at the cap that the re-read recovered whole, and readings. */
  recovered: Part
  /** Replies cut at the cap in all readings, recovered or not (reader and checker). */
  cutReplies: number
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
  const labelOf = new Map([...book.records].map(([labelId, id]) => [id, labelId]))
  const storedFacts: StoredFact[] = claims.map((claim) => ({
    scene: sceneOf(book, claim.nodeId),
    p: claim.para,
    record: labelOf.get(claim.recordId ?? '') ?? null,
    slot: claim.slot,
    value: claim.value,
    quote: claim.quote,
    voice: claim.voice,
    mode: claim.mode,
    proof: claim.proof
  }))
  const factOf = new Map(claims.map((claim, i) => [claim, storedFacts[i]]))
  // A literal fact on no labelled sentence is judged by its verdict (plan ReaderNarrow.md: the
  // fourth run's one wrong literal was Hobb at the lodge gate, right, on a sentence only a
  // contradiction label covered); one not judged yet counts wrong.
  const literalRight = (claim: (typeof claims)[number]): boolean => {
    if (rightAbout(claim)) return true
    const fact = factOf.get(claim)
    if (fact === undefined) return false
    const judged = judgeStored(fact)
    return judged.kind === 'verdict' && judged.right
  }
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
  const strays = neverRead(book)
  // The health gate's measures, from the readings' own yields.
  const readings = [...book.scenes]
    .filter(([id]) => id !== 'h10')
    .flatMap(([, node]) => {
      const reading = lastReading(book.db, node, activeDraftId(book.db))
      return reading === null ? [] : [reading]
    })
  const sum = (pick: (yields: (typeof readings)[number]['yields']) => number): number =>
    readings.reduce((total, reading) => total + pick(reading.yields), 0)
  const refused = (reasons: readonly string[]): number =>
    sum((yields) => reasons.reduce((total, reason) => total + (yields.rejections[reason] ?? 0), 0))
  const found = sum((yields) => yields.quotesFound)
  return {
    quotesFound: share(found, found + refused(QUOTE_MISSES)),
    costRefusals: {
      items: sum((yields) => yields.items),
      byReason: Object.fromEntries(COST_REFUSALS.map((reason) => [reason, refused([reason])]))
    },
    stored: scoreStored(storedFacts),
    storedFacts,
    verifierPass: share(
      sum((yields) => yields.verified),
      sum((yields) => yields.verifySent)
    ),
    attribution: share(attributed, matched.length),
    literalPrecision: share(literal.filter(literalRight).length, literal.length),
    supportPrecision: share(verifiedMatched.filter(rightAbout).length, verifiedMatched.length),
    unreviewed,
    facts: claims.length,
    strays: strays.length,
    strayLines: strays.map(
      (claim) =>
        `${sceneOf(book, claim.nodeId) || claim.nodeId} ${nameOfRecord.get(claim.recordId ?? '') ?? '?'} ` +
        `${claim.slot} “${claim.value}” ← “${claim.quote}”`
    ),
    falseAlarms: negativesStored(book, claims),
    // A reading's finishReason is `length` only for a cut its re-read did not recover (second live
    // run of 2026-10-14: every cut reply used to count, so the share could not fall as pages grew
    // smaller and the requests per reading more); a recovered one is counted apart.
    cut: share(
      readings.filter((reading) => reading.finishReason === 'length').length,
      readings.length
    ),
    recovered: share(
      readings.filter((reading) => reading.yields.cut > 0 && reading.finishReason !== 'length')
        .length,
      readings.length
    ),
    cutReplies: sum((yields) => yields.cut)
  }
}

export const percentOf = (part: Part): string =>
  part.of === 0 ? 'n/a' : `${((part.right / part.of) * 100).toFixed(1)} %`

/**
 * The report's cut-off lines: readings left cut off (paragraphs or verdicts lost), and apart from
 * them the readings whose cut reply the re-read recovered, with every cut reply counted.
 */
export function cutLines(measures: PlantedMeasures): string[] {
  const { cut, recovered } = measures
  return [
    `- Cut off at the cap and not recovered (paragraphs or verdicts lost): ${percentOf(cut)} of readings (${cut.right} of ${cut.of})`,
    `- Cut off at the cap and recovered by the re-read: ${recovered.right} of ${recovered.of} readings (replies cut, reader and checker: ${measures.cutReplies})`
  ]
}

/** The bars the measures miss, each as a report line names it. */
export function plantedFailures(measures: PlantedMeasures): string[] {
  const failures: string[] = []
  const bar = (name: string, part: Part, min: number): void => {
    if (part.of > 0 && part.right / part.of < min) {
      failures.push(`${name} ${percentOf(part)} < ${min * 100} %`)
    }
  }
  bar('stored-fact precision', measures.stored.precision, PLANTED_PASS_BARS.storedPrecision)
  if (measures.stored.unjudged.length > 0) {
    failures.push(
      `${measures.stored.unjudged.length} stored facts not judged yet (counted wrong; judge them in storedVerdicts and re-score)`
    )
  }
  bar('quotes found', measures.quotesFound, PLANTED_PASS_BARS.quotesFound)
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
  const { falseAlarms, stored, costRefusals } = measures
  const costs = Object.entries(costRefusals.byReason)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(', ')
  return [
    `- **Stored-fact precision: ${percentOf(stored.precision)}** (bar ${bars.storedPrecision * 100} %; ${stored.precision.right} right of every stored fact in the slots still read, ${stored.precision.of}; not judged yet, counted wrong: ${stored.unjudged.length}; with every judgment call turned: ${percentOf(stored.callsTurned)}; in slots no longer read, left out: ${stored.notRead})`,
    `- Quotes found: ${percentOf(measures.quotesFound)} (bar ${bars.quotesFound * 100} %; of the quotes looked for, ${measures.quotesFound.of})`,
    `- Refused for slot or length (a cost, no bar): ${costs} of ${costRefusals.items} items proposed`,
    `- Verifier pass (efficiency, no bar): ${percentOf(measures.verifierPass)}`,
    `- Attribution precision: ${percentOf(measures.attribution)} (bar ${bars.attribution * 100} %)`,
    `- Literal precision: ${percentOf(measures.literalPrecision)} (bar ${bars.literalPrecision * 100} %)`,
    `- Support precision: ${percentOf(measures.supportPrecision)} (bar ${bars.supportPrecision * 100} %; verified claims on labelled sentences, the label's record)`,
    `- Stored on no labelled sentence (judged by the verdicts, or listed below to judge): ${measures.unreviewed.length} of ${measures.facts}`,
    `- Claims from never-read scenes: ${measures.strays} (bar 0)${measures.strayLines.length > 0 ? `: ${measures.strayLines.join('; ')}` : ''}`,
    `- Negatives stored live (false alarms): ${falseAlarms.length} (bar 0)${falseAlarms.length > 0 ? `: ${falseAlarms.join('; ')}` : ''}`
  ]
}

/**
 * The report's closing sections: the stored facts judged wrong, and those not judged yet (no
 * claim label and no verdict), each to judge by hand into `storedVerdicts` before the precision
 * bar is final.
 */
export function unreviewedLines(measures: PlantedMeasures): string[] {
  const { wrong, unjudged } = measures.stored
  return [
    '## Stored facts judged wrong',
    '',
    ...(wrong.length === 0 ? ['None.'] : wrong.map((line) => `- ${line}`)),
    '',
    '## Not judged yet: stored on no labelled or judged sentence',
    '',
    'Each counts wrong until judged: read it against its quote from the text alone and add a',
    'verdict to `storedVerdicts` (`src/main/memory/testBook/labels.ts`), then re-score the JSON.',
    '',
    ...(unjudged.length === 0 ? ['None.'] : unjudged.map((line) => `- ${line}`))
  ]
}
