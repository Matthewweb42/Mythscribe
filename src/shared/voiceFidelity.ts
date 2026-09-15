import {
  computeStylometrics,
  RULE_MIN_DIALOGUE_CHARS,
  RULE_MIN_PARAGRAPHS,
  RULE_MIN_TAGS,
  RULE_MIN_WORDS,
  type Stylometrics
} from './stylometry'

/**
 * The voice fidelity check (F-14.7): local, deterministic scoring of AI output against the
 * stylometric profile (F-14.1), no AI call. Two shapes of text are scored: a ghost-text
 * fragment (20–60 tokens, so only the signals such a fragment can carry are checked, each
 * behind its own evidence gate on the profile side) and a whole document (the voice
 * consistency report, where the document is long enough for the rate-based signals too).
 * Every violation carries a plain-language message: the first one is what the regenerate
 * prompt names and what the warning badge shows.
 */

export const FIDELITY_CODES = [
  'tense',
  'person',
  'dialogueTag',
  'adverbRate',
  'sentenceLength',
  'semicolon',
  'dialogueRatio'
] as const
export type FidelityCode = (typeof FIDELITY_CODES)[number]

export interface FidelityViolation {
  code: FidelityCode
  message: string
}

export interface FidelityResult {
  ok: boolean
  violations: FidelityViolation[]
}

/** The profile's said/asked share from which a non-said tag in a fragment counts as off-voice. */
export const FIDELITY_SAID_RATIO = 0.85
/** A fragment needs this many `-ly` adverbs before its rate is compared at all. */
export const FIDELITY_MIN_ADVERBS = 2
/** The fragment's adverb rate must be this many times the profile's. */
export const FIDELITY_ADVERB_FACTOR = 2.5
/** A fragment sentence is "much longer" past this floor and this multiple of the profile's p90. */
export const FIDELITY_SENTENCE_FLOOR = 25
export const FIDELITY_SENTENCE_FACTOR = 2.5
/** Below this many semicolons per 1,000 words the manuscript "never" uses them. */
export const FIDELITY_SEMICOLON_NEVER = 0.3

/** The document report's bands. */
export const DRIFT_SENTENCE_RATIO = { min: 0.67, max: 1.5 } as const
export const DRIFT_DIALOGUE_RATIO_DELTA = 0.25
export const DRIFT_ADVERB_FACTOR = 2
/** A document under this many `-ly` adverbs per 100 words never drifts on adverbs (a zero-rate manuscript would otherwise flag every one). */
export const DRIFT_ADVERB_FLOOR = 1
export const DRIFT_SAID_RATIO_DELTA = 0.4
export const DRIFT_SEMICOLON_DELTA = 3

const resolved = (value: string): value is 'past' | 'present' | 'first' | 'third' =>
  value === 'past' || value === 'present' || value === 'first' || value === 'third'

/**
 * Scores a ghost-text fragment against the profile's stylometrics. Signals a short fragment
 * cannot carry (dialogue ratio, paragraph length, top verbs, comma and question rates) are not
 * checked; the rest each need their own evidence on the profile side, so a thin profile never
 * flags anything. `ok` is true when there are no violations.
 */
export function checkGhostTextFidelity(profile: Stylometrics, fragment: string): FidelityResult {
  const stats = computeStylometrics(fragment)
  const violations: FidelityViolation[] = []
  const enough = profile.wordCount >= RULE_MIN_WORDS

  if (resolved(stats.tense) && resolved(profile.tense) && stats.tense !== profile.tense) {
    violations.push({ code: 'tense', message: `switches to ${stats.tense} tense` })
  }

  if (resolved(stats.person) && resolved(profile.person) && stats.person !== profile.person) {
    violations.push({ code: 'person', message: `switches to ${stats.person} person` })
  }

  if (
    profile.tagVerbs.sampleSize >= RULE_MIN_TAGS &&
    profile.tagVerbs.saidRatio >= FIDELITY_SAID_RATIO &&
    stats.tagVerbs.sampleSize >= 1 &&
    stats.tagVerbs.saidRatio === 0
  ) {
    violations.push({ code: 'dialogueTag', message: 'uses a dialogue tag other than said' })
  }

  if (enough) {
    const adverbs = Math.round((stats.adverbRate * stats.wordCount) / 100)
    if (
      adverbs >= FIDELITY_MIN_ADVERBS &&
      stats.adverbRate >= FIDELITY_ADVERB_FACTOR * profile.adverbRate
    ) {
      violations.push({ code: 'adverbRate', message: 'piles on -ly adverbs' })
    }
  }

  if (
    enough &&
    stats.sentenceLength.p90 >
      Math.max(FIDELITY_SENTENCE_FLOOR, profile.sentenceLength.p90 * FIDELITY_SENTENCE_FACTOR)
  ) {
    violations.push({
      code: 'sentenceLength',
      message: 'runs to a much longer sentence than the manuscript'
    })
  }

  if (
    profile.paragraphLength.count >= RULE_MIN_PARAGRAPHS &&
    profile.punctuation.semicolonsPer1000 < FIDELITY_SEMICOLON_NEVER &&
    fragment.includes(';')
  ) {
    violations.push({
      code: 'semicolon',
      message: 'uses a semicolon, which the manuscript never does'
    })
  }

  return { ok: violations.length === 0, violations }
}

const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`

/**
 * Scores a whole document's stylometrics against the profile's for the voice consistency
 * report: the categorical signals (tense, person) plus the rates a document is long enough to
 * carry, each gated on evidence from both sides. The messages read as report lines.
 */
export function scoreDocumentDrift(
  profile: Stylometrics,
  doc: Stylometrics
): { violations: FidelityViolation[] } {
  const violations: FidelityViolation[] = []
  const bothLong = profile.wordCount >= RULE_MIN_WORDS && doc.wordCount >= RULE_MIN_WORDS

  if (resolved(doc.tense) && resolved(profile.tense) && doc.tense !== profile.tense) {
    violations.push({
      code: 'tense',
      message: `Narrated in ${doc.tense} tense; the manuscript is in ${profile.tense} tense.`
    })
  }

  if (resolved(doc.person) && resolved(profile.person) && doc.person !== profile.person) {
    violations.push({
      code: 'person',
      message: `Narrated in ${doc.person} person; the manuscript is in ${profile.person} person.`
    })
  }

  if (bothLong && profile.sentenceLength.median > 0) {
    const ratio = doc.sentenceLength.median / profile.sentenceLength.median
    if (ratio < DRIFT_SENTENCE_RATIO.min || ratio > DRIFT_SENTENCE_RATIO.max) {
      violations.push({
        code: 'sentenceLength',
        message:
          `Sentences run a median of ${Math.round(doc.sentenceLength.median)} words; ` +
          `the manuscript's is ${Math.round(profile.sentenceLength.median)}.`
      })
    }
  }

  if (
    profile.dialogueChars >= RULE_MIN_DIALOGUE_CHARS &&
    doc.dialogueChars >= RULE_MIN_DIALOGUE_CHARS &&
    Math.abs(doc.dialogueRatio - profile.dialogueRatio) > DRIFT_DIALOGUE_RATIO_DELTA
  ) {
    violations.push({
      code: 'dialogueRatio',
      message:
        `About ${percent(doc.dialogueRatio)} dialogue; ` +
        `the manuscript is about ${percent(profile.dialogueRatio)}.`
    })
  }

  if (
    bothLong &&
    doc.adverbRate >= DRIFT_ADVERB_FLOOR &&
    doc.adverbRate >= DRIFT_ADVERB_FACTOR * profile.adverbRate
  ) {
    violations.push({
      code: 'adverbRate',
      message:
        `${doc.adverbRate} -ly adverbs per 100 words; ` +
        `the manuscript has ${profile.adverbRate}.`
    })
  }

  if (
    profile.tagVerbs.sampleSize >= RULE_MIN_TAGS &&
    doc.tagVerbs.sampleSize >= RULE_MIN_TAGS &&
    Math.abs(doc.tagVerbs.saidRatio - profile.tagVerbs.saidRatio) > DRIFT_SAID_RATIO_DELTA
  ) {
    violations.push({
      code: 'dialogueTag',
      message:
        `Dialogue tags are said or asked ${percent(doc.tagVerbs.saidRatio)} of the time; ` +
        `the manuscript's are ${percent(profile.tagVerbs.saidRatio)}.`
    })
  }

  if (
    profile.paragraphLength.count >= RULE_MIN_PARAGRAPHS &&
    doc.paragraphLength.count >= RULE_MIN_PARAGRAPHS &&
    Math.abs(doc.punctuation.semicolonsPer1000 - profile.punctuation.semicolonsPer1000) >
      DRIFT_SEMICOLON_DELTA
  ) {
    violations.push({
      code: 'semicolon',
      message:
        `${doc.punctuation.semicolonsPer1000} semicolons per 1,000 words; ` +
        `the manuscript has ${profile.punctuation.semicolonsPer1000}.`
    })
  }

  return { violations }
}
