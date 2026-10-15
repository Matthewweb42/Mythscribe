import { z } from 'zod'
import { straightenQuotes } from '../critique'
import { CLAIM_PROOFS } from './invariants'
import { SlotSchema } from './slots'

/**
 * Claims, cards and readings of story memory v2 (F-16.17, F-16.18; design §2.2 "Derived"): the
 * vocabulary every layer shares. A claim is one thing the prose states about a record, proved by
 * a verbatim quote (literal proof in code, or the verifier) and live only while the sentences it
 * rests on (its anchor) are unchanged. A card is the AI's map of one scene: findable, never
 * citable. A reading is one read of one scene (all its pages), with what it cost and yielded.
 *
 * Relative imports only: `schema.ts` imports the enums below, and drizzle-kit loads it without
 * the `@shared` alias.
 */

export { CLAIM_PROOFS }
export type ClaimProof = (typeof CLAIM_PROOFS)[number]

/** Who states it: the narration, a character speaking (with `speaker`), thinking, or hearsay. */
export const CLAIM_VOICES = ['narration', 'dialogue', 'thought', 'rumour'] as const
export const ClaimVoice = z.enum(CLAIM_VOICES)
export type ClaimVoice = z.infer<typeof ClaimVoice>

/** In what mode: true now in the story, remembered, supposed, or dreamt. */
export const CLAIM_MODES = ['now', 'memory', 'hypothetical', 'dream'] as const
export const ClaimMode = z.enum(CLAIM_MODES)
export type ClaimMode = z.infer<typeof ClaimMode>

/**
 * `suggested` (plan `Suggestions.md`, the author's decision of 2026-10-14): what a reading proved,
 * waiting for the author's *Accept* or *Dismiss*; shown only as a suggestion, used by nothing.
 * `live`: accepted by the author, shown and used. `stale`: an accepted line whose anchor changed;
 * dimmed until a reading revives or drops it (a suggestion whose anchor changes is deleted
 * instead: the next reading of its paragraph suggests it again if the text still says it).
 * `waiting`: its subject is not settled yet (a new name the author has not answered, or a pronoun
 * or shared alias that fits more than one person); once settled it is a suggestion.
 */
export const CLAIM_STATES = ['live', 'stale', 'waiting', 'suggested'] as const
export const ClaimState = z.enum(CLAIM_STATES)
export type ClaimState = z.infer<typeof ClaimState>

/**
 * Whether a claim is the author's accepted memory (`live`, or `stale` while it is re-checked):
 * the one rule every reader of claims uses (sheets, the panel's True now, ages, the Timeline, who
 * knows what, threads, contradictions, Ms Scribe's instant cards and tools). A suggestion or a
 * waiting claim is neither shown as memory nor used.
 */
export const isAccepted = (claim: { state: ClaimState }): boolean =>
  claim.state === 'live' || claim.state === 'stale'

/** Why a reading ran (`reading.purpose`). */
export const READING_PURPOSES = [
  'first',
  'window',
  'full',
  'backfill',
  'rebuild',
  'retry',
  'probe',
  'notAbout'
] as const
export const ReadingPurpose = z.enum(READING_PURPOSES)
export type ReadingPurpose = z.infer<typeof ReadingPurpose>

/** A spot check's verdict on a stored claim, and which tier gave it. */
export const SPOT_VERDICTS = ['agree', 'disagree'] as const
export const SpotVerdict = z.enum(SPOT_VERDICTS)
export type SpotVerdict = z.infer<typeof SpotVerdict>
export const SPOT_TIERS = ['fast', 'strong'] as const
export const SpotTier = z.enum(SPOT_TIERS)
export type SpotTier = z.infer<typeof SpotTier>

/** Who made a plan link stored in `plan_link`: matched in code or picked by `planLinks.v2`. */
export const PLAN_LINK_ORIGINS = ['code', 'ai'] as const
export type PlanLinkOrigin = (typeof PLAN_LINK_ORIGINS)[number]

/** A lazy back-fill's state per name (`memory_backfill`): it runs once. */
export const BACKFILL_STATES = ['due', 'asked', 'done', 'declined'] as const
export type BackfillState = (typeof BACKFILL_STATES)[number]

/**
 * A topic quote's role (F-16.22, F-16.23; P2b-D3, D4): the sentence that revealed the secret or
 * opened the thread (`defining`), or a reveal another reading proposed as a new topic that the
 * checker judged the same and merged into it (`merged`; *Split* undoes it).
 */
export const TOPIC_QUOTE_ROLES = ['defining', 'merged'] as const
export const TopicQuoteRole = z.enum(TOPIC_QUOTE_ROLES)
export type TopicQuoteRole = z.infer<typeof TopicQuoteRole>

/** A topic quote is `live` while its sentences stand, `stale` once they changed (as claims). */
export const TOPIC_QUOTE_STATES = ['live', 'stale'] as const
export const TopicQuoteState = z.enum(TOPIC_QUOTE_STATES)
export type TopicQuoteState = z.infer<typeof TopicQuoteState>

/**
 * What a waiting claim waits on: a new name the author is asked about (`name`, with its norm and
 * text as written), or a subject more than one record fits (`subject`, the candidates' ids).
 */
export const ClaimPending = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('name'), norm: z.string(), text: z.string() }),
  z.object({ kind: z.literal('subject'), candidates: z.array(z.string()) })
])
export type ClaimPending = z.infer<typeof ClaimPending>

/** A sentence hash list (`anchor.ts`): what a quote's proof rests on. */
const Anchor = z.array(z.string())

export const Claim = z.object({
  id: z.string(),
  nodeId: z.string(),
  draftId: z.string(),
  readingId: z.string().nullable(),
  /** Null while it waits on a new name. */
  recordId: z.string().nullable(),
  pending: ClaimPending.nullable(),
  /** The name span that pinned the subject; null for a pronoun. *Split* reads it. */
  subjectText: z.string().nullable(),
  slot: SlotSchema,
  value: z.string(),
  /** `valueKey(value)`: what values are grouped and dismissed by. */
  valueKey: z.string(),
  /** The second record of a kinship or relation claim. */
  objectId: z.string().nullable(),
  /**
   * P2b's knows and thread claims: a knows claim's `how` (`KNOWS_HOWS`) and `from` (told, overheard
   * and read only), a thread step's `how` (`THREAD_STEPS`); null for every other claim.
   */
  how: z.string().nullable(),
  fromId: z.string().nullable(),
  voice: ClaimVoice,
  /** The speaker or thinker of a dialogue or thought claim. */
  speakerId: z.string().nullable(),
  mode: ClaimMode,
  quote: z.string(),
  /** The paragraph the quote is in (`passageParagraphs` numbering). */
  para: z.number().int(),
  anchor: Anchor,
  proof: z.enum(CLAIM_PROOFS),
  /** The sentence states a change ("cut her hair"). */
  change: z.boolean(),
  state: ClaimState,
  spot: SpotVerdict.nullable(),
  spotTier: SpotTier.nullable(),
  spotAt: z.string().nullable(),
  created: z.string(),
  /** When its proof last passed (stored, revived, or re-proved for free). */
  proved: z.string(),
  /**
   * P2b: the merged reveal (`topic_quote`, role `merged`) a knows or thread claim came in with, so
   * *Split* moves exactly those (P2b-D5); null for every other claim.
   */
  topicQuoteId: z.string().nullable()
})
export type Claim = z.infer<typeof Claim>

/** The card's fields, each with its quote. */
export const CARD_FIELDS = ['where', 'when', 'pov', 'year', 'flashback', 'elapsed'] as const
export type CardFieldName = (typeof CARD_FIELDS)[number]

/**
 * One card field: its value (for `pov`, a record id; for `flashback`, `yes` or `no`), the quote
 * that says so, its paragraph, and whether the verifier confirmed it (POV, year and flashback
 * feed computation only when verified).
 */
export const CardField = z.object({
  value: z.string(),
  quote: z.string(),
  p: z.number().int(),
  verified: z.boolean()
})
export type CardField = z.infer<typeof CardField>

export const CardFields = z.object({
  where: CardField.nullable(),
  when: CardField.nullable(),
  pov: CardField.nullable(),
  year: CardField.nullable(),
  flashback: CardField.nullable(),
  elapsed: CardField.nullable()
})
export type CardFields = z.infer<typeof CardFields>

export function emptyCardFields(): CardFields {
  return { where: null, when: null, pov: null, year: null, flashback: null, elapsed: null }
}

/** A record on the page in this scene, with the quote that shows it. */
export const CardPresent = z.object({
  recordId: z.string(),
  quote: z.string(),
  p: z.number().int(),
  verified: z.boolean()
})
export type CardPresent = z.infer<typeof CardPresent>

/** The most words a card line holds, and the gist's range (design §2.2). */
export const CARD_LINE_MAX_WORDS = 30
export const CARD_GIST_MIN_WORDS = 60
export const CARD_GIST_MAX_WORDS = 80

export const Card = z.object({
  nodeId: z.string(),
  draftId: z.string(),
  readingId: z.string().nullable(),
  line: z.string(),
  gist: z.string(),
  fields: CardFields,
  present: z.array(CardPresent),
  mood: z.string().nullable(),
  theme: z.string().nullable(),
  /** Hashes of every card quote's sentence: when one changes, the card is due (P2a-D17). */
  anchor: Anchor,
  /**
   * The gate hashes (`gate.ts`, names out) of the scene's finished sentences when the card was
   * made: once a quarter of today's are not among them, the card is due (P2a-D17).
   */
  seen: z.array(z.string()),
  /** A hash of the line: plan links run only when it moves. */
  lineHash: z.string().nullable(),
  created: z.string()
})
export type Card = z.infer<typeof Card>

/** What a reading yielded (the health gate reads these). Rejections are counted by reason. */
export const ReadingYields = z.object({
  /** Items the reader proposed. */
  items: z.number().int().nonnegative(),
  /** Items whose quote passed the presence check. */
  quotesFound: z.number().int().nonnegative(),
  /** Items proved in code. */
  literal: z.number().int().nonnegative(),
  /** Items sent to the verifier, and those it confirmed. */
  verifySent: z.number().int().nonnegative(),
  verified: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  rejections: z.record(z.string(), z.number().int().nonnegative()),
  /** Pages cut off at the output cap. */
  cut: z.number().int().nonnegative()
})
export type ReadingYields = z.infer<typeof ReadingYields>

export function emptyYields(): ReadingYields {
  return {
    items: 0,
    quotesFound: 0,
    literal: 0,
    verifySent: 0,
    verified: 0,
    rejected: 0,
    rejections: {},
    cut: 0
  }
}

/** A paragraph range sent, inclusive. */
export const ParaRange = z.tuple([z.number().int(), z.number().int()])
export type ParaRange = z.infer<typeof ParaRange>

export const Reading = z.object({
  id: z.string(),
  nodeId: z.string(),
  draftId: z.string(),
  purpose: ReadingPurpose,
  pages: z.number().int().nonnegative(),
  paras: z.array(ParaRange),
  promptVersion: z.string(),
  verifyVersion: z.string().nullable(),
  model: z.string(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  /** Reader and verify together (the provider's reported cost where given), P2a-D1. */
  costUsd: z.number().nonnegative(),
  cloud: z.boolean(),
  /** `length` when any page was cut off at its cap. */
  finishReason: z.string().nullable(),
  yields: ReadingYields,
  created: z.string()
})
export type Reading = z.infer<typeof Reading>

const LEADING_ARTICLE = /^(?:a|an|the)\s+/

/**
 * The form values are grouped and dismissed by: NFC, straight quotes, lower case, whitespace
 * collapsed, outer punctuation trimmed, a leading article dropped ("The quay" and "quay" are one
 * value).
 */
export function valueKey(value: string): string {
  const folded = straightenQuotes(value.normalize('NFC'))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  return folded.replace(LEADING_ARTICLE, '')
}

/**
 * Whether a claim sets state (design §2.2): only narration in `now` mode does. Dialogue shows as
 * "Mara says…", a memory as remembered, a dream as dreamt; none of them ever wins.
 */
export function setsState(claim: { voice: ClaimVoice; mode: ClaimMode }): boolean {
  return claim.voice === 'narration' && claim.mode === 'now'
}
