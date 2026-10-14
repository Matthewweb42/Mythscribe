import { z } from 'zod'
import { AiErrorCode } from '../ai'
import {
  CARD_FIELDS,
  CardField,
  CardFields,
  CLAIM_PROOFS,
  ClaimMode,
  ClaimState,
  ClaimVoice,
  ReadingPurpose,
  SpotTier,
  SpotVerdict
} from './claims'
import { Dismissed, LOOSE_END_KINDS } from './dismissed'
import { FINDING_STATES, FindingRule, FindingView } from './findings'
import { KnowsHow } from './knows'
import { RecordOrigin } from './records'
import { SlotSchema } from './slots'
import { RebuildEstimate } from './switchover'
import { ThreadStep } from './topics'
import { TYPED_FIELDS } from './typedVsText'

/**
 * What story memory v2's reading shows (F-16.18), as the channels of slices 2–4 answer it: the
 * This scene panel's `SceneMemory`, a sheet's `SheetMemory` (as of a scene), ⓘ's `ClaimInfo`, the
 * footer's `MemoryStatus` and Needs a look's `MemoryNotice`s. Built in main (`reading/views.ts`)
 * from the stores and `asOf.ts`; nothing here is ever sent to a model.
 */

/** One claim as a line shows it. */
export const ClaimView = z.object({
  id: z.string(),
  recordId: z.string().nullable(),
  slot: SlotSchema,
  /** The slot's display name ("Eyes", "Last seen at"). */
  label: z.string(),
  value: z.string(),
  voice: ClaimVoice,
  mode: ClaimMode,
  speakerId: z.string().nullable(),
  objectId: z.string().nullable(),
  /** P2b: a knows line's how and source, a thread step's step (null for every other line). */
  how: z.string().nullable(),
  fromId: z.string().nullable(),
  state: ClaimState,
  proof: z.enum(CLAIM_PROOFS),
  nodeId: z.string(),
  /** The scene's reference ("14.2"). */
  ref: z.string(),
  para: z.number().int(),
  quote: z.string()
})
export type ClaimView = z.infer<typeof ClaimView>

/** A True now line: "Mara: at the quay, last stated in 1.1", "hair: red since 2.1". */
export const TrueNowView = z.object({
  recordId: z.string(),
  slot: SlotSchema,
  label: z.string(),
  objectId: z.string().nullable(),
  value: z.string(),
  claimId: z.string(),
  kind: z.enum(['since', 'lastStated']),
  ref: z.string(),
  nodeId: z.string(),
  /** Its anchor changed: dimmed, "re-checking after you pause". */
  stale: z.boolean()
})
export type TrueNowView = z.infer<typeof TrueNowView>

/**
 * Who is Here: the POV (`pov`; where the card's verified POV differs from the typed one, the
 * text's record with the typed one in `typedPov`, dimmed), characters on the page with a verified
 * quote (`onPage`), and the author's "+ also here" (`alsoHere`).
 */
export const HereChip = z.object({
  recordId: z.string(),
  why: z.enum(['pov', 'onPage', 'alsoHere']),
  quote: z.string().nullable(),
  p: z.number().int().nullable(),
  typedPov: z.string().nullable()
})
export type HereChip = z.infer<typeof HereChip>

/** A record the scene names for certain but who is not Here (P2a-D21). */
export const MentionedChip = z.object({ recordId: z.string(), count: z.number().int().positive() })
export type MentionedChip = z.infer<typeof MentionedChip>

export const TypedComparisonView = z.object({
  outcome: z.enum(['same', 'textOnly', 'typedOnly', 'differs', 'none']),
  typed: z.string().nullable(),
  text: z.string().nullable(),
  quote: z.string().nullable()
})
export type TypedComparisonView = z.infer<typeof TypedComparisonView>

/**
 * The card as scene details show it: the AI's map of the scene, never quoted. `fields` leaves out
 * what the author said is not right; `stale` names the fields whose quote no longer stands on the
 * text (`holdingCard`): dimmed, never compared with the typed details, until the next reading.
 */
export const CardView = z.object({
  line: z.string(),
  gist: z.string(),
  fields: CardFields,
  stale: z.array(z.enum(CARD_FIELDS)),
  mood: z.string().nullable(),
  theme: z.string().nullable(),
  readingId: z.string().nullable(),
  created: z.string()
})
export type CardView = z.infer<typeof CardView>

/*
 * Who knows what, threads and time (F-16.22, F-16.23; plan P2b): what the pure rules of
 * `whoKnows.ts`, `threadsAsOf.ts` and `years.ts` answer, and the views of slices 4 and 5 carry.
 * Absence is never a line (P2b rule 9): a view carries only what was proved, plus `checkedUpTo`;
 * the words "No scene shows … (checked up to …)" are composed in the renderer alone, and nothing
 * that reaches a prompt reads `checkedUpTo`.
 */

/** A scene and how it is named ("14.2"). */
export const SceneRefView = z.object({ nodeId: z.string(), ref: z.string() })
export type SceneRefView = z.infer<typeof SceneRefView>

/**
 * "Readers have known since" (P2b-D7): the scene, and whether it rests only on reveals or lines
 * whose sentences changed since they were read (`stale`: shown dimmed, re-checking).
 */
export const SinceView = SceneRefView.extend({ stale: z.boolean() })
export type SinceView = z.infer<typeof SinceView>

/**
 * A secret's or thread's reveal (`topic_quote`): the sentence that revealed or opened it
 * (`defining`), or one merged into it as the same (`merged`, with the label it was read as).
 */
export const TopicQuoteView = z.object({
  topicQuoteId: z.string(),
  role: z.enum(['defining', 'merged']),
  label: z.string(),
  quote: z.string(),
  nodeId: z.string(),
  ref: z.string(),
  para: z.number().int(),
  /** Its sentences changed since it was read: dimmed, re-checking. */
  stale: z.boolean(),
  /**
   * The reading that proved it (ⓘ's model and cost, slice 4), when the caller gave it and it is
   * still stored; null for a reveal whose reading went.
   */
  reading: z
    .object({ model: z.string(), costUsd: z.number().nonnegative(), created: z.string() })
    .nullable()
})
export type TopicQuoteView = z.infer<typeof TopicQuoteView>
export type TopicQuoteReading = NonNullable<TopicQuoteView['reading']>

/**
 * One knower's line about a secret (P2b-D6, D7): from a knows claim, or the author's *Knew before
 * the book* (`source: 'author'`, no scene). `line` says whether it counts as knowing (`counts`),
 * is half-knowing (`partial`: suspects, believes otherwise) or does not count (`other`: dialogue
 * by someone else, a rumour, a hypothetical, a dream). `later`: the knower's first line comes
 * after the scene the view is read as of ("learns later (17.3)").
 */
export const KnowsCellView = z.object({
  knowerId: z.string(),
  secretId: z.string(),
  how: KnowsHow,
  fromId: z.string().nullable(),
  source: z.enum(['claim', 'author']),
  line: z.enum(['counts', 'partial', 'other']),
  claimId: z.string().nullable(),
  nodeId: z.string().nullable(),
  ref: z.string().nullable(),
  para: z.number().int().nullable(),
  voice: ClaimVoice.nullable(),
  mode: ClaimMode.nullable(),
  speakerId: z.string().nullable(),
  stale: z.boolean(),
  later: z.boolean()
})
export type KnowsCellView = z.infer<typeof KnowsCellView>

/**
 * One secret as of a scene: its label, who made it, the scene readers have known it since (the
 * earliest reveal or counted line, P2b-D7; null when none; dimmed when it rests only on re-checked
 * evidence), whether readers know it as of the scene (`knownStale`: only through re-checked
 * evidence), its reveals, one cell per knower (the strongest line as of the scene, the author's
 * knew-before, or the first later line flagged `later`), the lines that do not count, the author's
 * knew-before marks, and the scenes that touch it (`touchedIn`: a counted or partial line, or a
 * reveal, there; in reading order). Never a "doesn't know" cell.
 */
export const SecretView = z.object({
  recordId: z.string(),
  label: z.string(),
  origin: RecordOrigin,
  readersSince: SinceView.nullable(),
  known: z.boolean(),
  knownStale: z.boolean(),
  defining: TopicQuoteView.nullable(),
  merged: z.array(TopicQuoteView),
  cells: z.array(KnowsCellView),
  others: z.array(KnowsCellView),
  knewBefore: z.array(z.string()),
  touchedIn: z.array(z.string())
})
export type SecretView = z.infer<typeof SecretView>

/**
 * The Book's who-knows-what grid as of a scene (P2b-D20): columns are the characters and groups
 * with any line or knew-before as of the scene, plus its POV, by how often each is named; rows
 * the secrets readers know as of the scene (and the author's own not revealed yet), newest
 * first; `later` counts the secrets readers learn later in the book. `checkedUpTo` scopes every
 * empty cell (the renderer's words only).
 */
export const KnowsGrid = z.object({
  asOf: z.string().nullable(),
  asOfRef: z.string().nullable(),
  checkedUpTo: SceneRefView.nullable(),
  columns: z.array(z.string()),
  rows: z.array(SecretView),
  later: z.number().int().nonnegative()
})
export type KnowsGrid = z.infer<typeof KnowsGrid>

/**
 * A tension line in This scene (P2b-D21): readers know a secret and the POV has no counted line
 * (`readersKnow`), or someone Here holds it and another Here has none (`hereKnows`). The "has
 * none" is scoped by `SceneSecrets.checkedUpTo`; never a fact. `stale`: it rests on a reveal or
 * line being re-checked (shown dimmed).
 */
export const TensionLine = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('readersKnow'),
    secretId: z.string(),
    /** The secret's label and "readers since" (slice 4: a line about a secret not touched here). */
    label: z.string(),
    since: SinceView.nullable(),
    recordId: z.string(),
    stale: z.boolean()
  }),
  z.object({
    kind: z.literal('hereKnows'),
    secretId: z.string(),
    label: z.string(),
    since: SinceView.nullable(),
    holderId: z.string(),
    recordId: z.string(),
    stale: z.boolean()
  })
])
export type TensionLine = z.infer<typeof TensionLine>

/** A secret touched in the scene, with the Here characters that have no counted line for it. */
export const SceneSecretView = z.object({ secret: SecretView, without: z.array(z.string()) })
export type SceneSecretView = z.infer<typeof SceneSecretView>

/**
 * This scene's Who knows what (P2b-D21): every secret touched in the scene (a line or a reveal
 * there), at most 3 tension lines, and how many of the grid's other rows "+ N more in Book" opens.
 */
export const SceneSecrets = z.object({
  touched: z.array(SceneSecretView),
  tension: z.array(TensionLine),
  more: z.number().int().nonnegative(),
  checkedUpTo: SceneRefView.nullable()
})
export type SceneSecrets = z.infer<typeof SceneSecrets>

/**
 * One thread step (an `opens`, `advances` or `resolves` claim) as of a scene: `counted` when it is
 * in mode `now` and not a rumour (it moves the status, P2b-D22); the rest are listed muted.
 */
export const ThreadStepView = z.object({
  claimId: z.string(),
  step: ThreadStep,
  value: z.string(),
  nodeId: z.string(),
  ref: z.string(),
  para: z.number().int(),
  voice: ClaimVoice,
  mode: ClaimMode,
  counted: z.boolean(),
  stale: z.boolean()
})
export type ThreadStepView = z.infer<typeof ThreadStepView>

/** A thread's status as of a scene, derived, never stored (P2b-D22). */
export const THREAD_STATUSES = ['notYet', 'open', 'resolved'] as const
export const ThreadStatus = z.enum(THREAD_STATUSES)
export type ThreadStatus = z.infer<typeof ThreadStatus>

/**
 * One thread as of a scene: its status, where it opened, its last counted step, where it resolved,
 * its steps as of the scene, how many come later, and its reveals.
 */
export const ThreadMemoryView = z.object({
  recordId: z.string(),
  label: z.string(),
  origin: RecordOrigin,
  status: ThreadStatus,
  opened: SceneRefView.nullable(),
  last: SceneRefView.nullable(),
  resolved: SceneRefView.nullable(),
  steps: z.array(ThreadStepView),
  later: z.number().int().nonnegative(),
  defining: TopicQuoteView.nullable(),
  merged: z.array(TopicQuoteView)
})
export type ThreadMemoryView = z.infer<typeof ThreadMemoryView>

/** The Book's Threads as of a scene; an author's thread with no step reads `notYet`, scoped. */
export const ThreadsMemory = z.object({
  asOf: z.string().nullable(),
  asOfRef: z.string().nullable(),
  checkedUpTo: SceneRefView.nullable(),
  threads: z.array(ThreadMemoryView)
})
export type ThreadsMemory = z.infer<typeof ThreadsMemory>

/**
 * A topic's sheet section: a secret's or a thread's view. Each carries `checkedUpTo`, which scopes
 * "no one has a line" and "no scene shows this thread yet" (P2b rule 9).
 */
export const TopicView = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('secret'),
    secret: SecretView,
    checkedUpTo: SceneRefView.nullable()
  }),
  z.object({
    kind: z.literal('thread'),
    thread: ThreadMemoryView,
    checkedUpTo: SceneRefView.nullable()
  })
])
export type TopicView = z.infer<typeof TopicView>

/**
 * A named record's **Threads, as of [scene]** (F-16.23, plan P2b §5.2): the threads with a step as
 * of the scene whose quote's paragraph names the record for certain, each with its own status and
 * its steps narrowed to those, in story order; with none, `checkedUpTo` scopes the empty state
 * (P2b rule 9).
 */
export const SheetThreadsView = z.object({
  threads: z.array(ThreadMemoryView),
  checkedUpTo: SceneRefView.nullable()
})
export type SheetThreadsView = z.infer<typeof SheetThreadsView>

/** One line of a sheet's Knows: the secret and the knower's cell for it. */
export const KnowsSheetLine = z.object({
  secretId: z.string(),
  label: z.string(),
  cell: KnowsCellView
})
export type KnowsSheetLine = z.infer<typeof KnowsSheetLine>

/**
 * A character's or group's **Knows, as of [scene]** (F-16.22, plan P2b §4.2): its line per secret
 * as of the scene (counted ones, the author's *Knew before the book*, partial ones shown muted),
 * the lines that never count (someone else's dialogue, a rumour, a dream) apart, and how many
 * secrets it first learns later in the book. Never a line for a secret it has none for; with no
 * line at all, `checkedUpTo` scopes the empty state (P2b rule 9).
 */
export const KnowsSheetView = z.object({
  lines: z.array(KnowsSheetLine),
  others: z.array(KnowsSheetLine),
  later: z.number().int().nonnegative(),
  checkedUpTo: SceneRefView.nullable()
})
export type KnowsSheetView = z.infer<typeof KnowsSheetView>

/**
 * An elapsed hint the card quoted, where, and whether it crosses a year. `text` is the book's own
 * words, never the reader's value: the value as it stands in the quote ("Three winters later"),
 * else the whole quote; `quote` and `para` are the card field's (ⓘ, *Go there*).
 */
export const ElapsedHintView = z.object({
  text: z.string(),
  quote: z.string(),
  para: z.number().int(),
  nodeId: z.string(),
  ref: z.string(),
  breaks: z.boolean()
})
export type ElapsedHintView = z.infer<typeof ElapsedHintView>

/**
 * A scene's story year (decision 5): typed in its details, quoted in its own text (verified, its
 * scene only), carried from the last typed year (`from`), or not known (with the hint that ended
 * the carry, when one did).
 */
export const YearView = z.union([
  z.object({
    kind: z.enum(['typed', 'quoted', 'carried']),
    value: z.number().int(),
    from: SceneRefView
  }),
  z.object({ kind: z.literal('unknown'), hint: ElapsedHintView.nullable() })
])
export type YearView = z.infer<typeof YearView>
export type KnownYearView = Extract<YearView, { value: number }>

/** Where a birth year came from: a quoted `born` line in the book, or the record's Pinned page. */
export const BornView = z.object({
  year: z.number().int(),
  source: z.enum(['text', 'pinned']),
  claimId: z.string().nullable(),
  nodeId: z.string().nullable(),
  ref: z.string().nullable()
})
export type BornView = z.infer<typeof BornView>

/**
 * What a stated age lists "since then" (decision 5), in reading order and never added up: an
 * elapsed hint that can cross a year, or a story year typed or quoted later that differs from the
 * one before it ("1820 (1.3)").
 */
export const AgeSinceView = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hint'), hint: ElapsedHintView }),
  z.object({
    kind: z.literal('year'),
    value: z.number().int(),
    nodeId: z.string(),
    ref: z.string()
  })
])
export type AgeSinceView = z.infer<typeof AgeSinceView>

/** The story year an age is computed against: typed, quoted, or carried from an earlier scene. */
export const AgeYearView = z.object({
  kind: z.enum(['typed', 'quoted', 'carried']),
  value: z.number().int(),
  from: SceneRefView
})
export type AgeYearView = z.infer<typeof AgeYearView>

/**
 * A character's age as of a scene (decision 5, P2b-D15): computed from a birth year and the
 * scene's year ("about 19 · year from 1.1"), not born yet, the last stated age with what changed
 * since listed and never added up ("19, stated in 2.1 · since then: 'Three winters later'
 * (14.1)"), or, with a birth year but no year for the scene and no stated age, the birth year
 * alone with why the year is not known (`bornOnly`).
 */
export const AgeView = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('computed'),
    age: z.number().int().nonnegative(),
    born: BornView,
    year: AgeYearView
  }),
  z.object({
    kind: z.literal('notBorn'),
    born: BornView,
    year: AgeYearView
  }),
  z.object({
    kind: z.literal('stated'),
    value: z.string(),
    claimId: z.string(),
    nodeId: z.string(),
    ref: z.string(),
    since: z.array(AgeSinceView)
  }),
  z.object({
    kind: z.literal('bornOnly'),
    born: BornView,
    /** The hint that ended the year carry; null before the first typed year. */
    hint: ElapsedHintView.nullable()
  })
])
export type AgeView = z.infer<typeof AgeView>

/**
 * A character's **Age, as of [scene]** (F-16.23): the age (null when the book gives no birth year
 * and no stated age up to the scene) and `checkedUpTo`, which scopes that empty state (P2b rule 9).
 */
export const SheetAgeView = z.object({
  age: AgeView.nullable(),
  checkedUpTo: SceneRefView.nullable()
})
export type SheetAgeView = z.infer<typeof SheetAgeView>

export const SceneMemory = z.object({
  nodeId: z.string(),
  ref: z.string().nullable(),
  card: CardView.nullable(),
  here: z.array(HereChip),
  mentioned: z.array(MentionedChip),
  trueNow: z.array(TrueNowView),
  typed: z.object(
    Object.fromEntries(TYPED_FIELDS.map((field) => [field, TypedComparisonView])) as Record<
      (typeof TYPED_FIELDS)[number],
      typeof TypedComparisonView
    >
  ),
  /** The scene's last reading in the active draft. */
  lastRead: z
    .object({
      readingId: z.string(),
      at: z.string(),
      model: z.string(),
      costUsd: z.number().nonnegative()
    })
    .nullable(),
  /** Finished sentences not read yet. */
  unread: z.number().int().nonnegative(),
  /** Why reading is paused, when it is (slice 3). */
  paused: z.string().nullable(),
  /**
   * F-16.17: what the active draft read from this scene, in text order (live, stale and waiting),
   * each with its quote and proof: what ⓘ and the panel's lines (slice 4) start from.
   */
  claims: z.array(ClaimView),
  /**
   * F-16.22 (P2b slice 4): the secrets the scene touches and its tension lines, as of the scene;
   * every "has none" is scoped by `checkedUpTo` and worded in the renderer alone.
   */
  secrets: SceneSecrets
})
export type SceneMemory = z.infer<typeof SceneMemory>

/** Why *Read now* read nothing (F-16.16): up to date, cosmetic edits only, nothing finished, a scene never read, or reading paused. */
export const READ_NOW_SKIPS = ['upToDate', 'cosmetic', 'empty', 'notReadable', 'paused'] as const
export const ReadNowSkip = z.enum(READ_NOW_SKIPS)
export type ReadNowSkip = z.infer<typeof ReadNowSkip>

/**
 * What `memory:readNow` answers: whether the scene was read (and the reading's id and cost), or
 * why not; an AI failure (no key, Use AI or the reading switch off, the daily cap) as data.
 */
export const ReadNowResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    read: z.boolean(),
    reason: ReadNowSkip.nullable(),
    readingId: z.string().nullable(),
    costUsd: z.number().nonnegative()
  }),
  z.object({ ok: z.literal(false), code: AiErrorCode, message: z.string(), nextStep: z.string() })
])
export type ReadNowResult = z.infer<typeof ReadNowResult>

/** ⓘ on an AI line: the quote, where it is, how it was proved, and what the reading cost. */
export const ClaimInfo = z.object({
  claim: ClaimView,
  sceneTitle: z.string(),
  spot: z.object({ verdict: SpotVerdict, tier: SpotTier, at: z.string() }).nullable(),
  reading: z
    .object({
      id: z.string(),
      purpose: ReadingPurpose,
      model: z.string(),
      promptVersion: z.string(),
      created: z.string(),
      costUsd: z.number().nonnegative()
    })
    .nullable()
})
export type ClaimInfo = z.infer<typeof ClaimInfo>

const SheetValueView = z.object({
  claimId: z.string(),
  value: z.string(),
  ref: z.string(),
  nodeId: z.string(),
  para: z.number().int(),
  stale: z.boolean()
})

export const SheetLineView = z.object({
  slot: SlotSchema,
  label: z.string(),
  objectId: z.string().nullable(),
  value: SheetValueView,
  also: z.array(SheetValueView),
  since: z.string().nullable()
})
export type SheetLineView = z.infer<typeof SheetLineView>

export const OtherLineView = z.object({
  claimId: z.string(),
  slot: SlotSchema,
  label: z.string(),
  objectId: z.string().nullable(),
  value: z.string(),
  voice: ClaimVoice,
  mode: ClaimMode,
  speakerId: z.string().nullable(),
  ref: z.string(),
  nodeId: z.string(),
  stale: z.boolean()
})
export type OtherLineView = z.infer<typeof OtherLineView>

/** A sheet's "From the book, as of [scene]". */
export const SheetMemory = z.object({
  recordId: z.string(),
  /** The scene it is read as of; null for the end of the book. */
  asOf: z.string().nullable(),
  asOfRef: z.string().nullable(),
  fixed: z.array(SheetLineView),
  lasting: z.array(SheetLineView),
  transient: z.array(SheetLineView),
  accumulating: z.array(SheetLineView),
  others: z.array(OtherLineView),
  later: z.number().int().nonnegative(),
  /** F-16.22: a character's or group's Knows as of the scene; null for any other record. */
  knows: KnowsSheetView.nullable(),
  /** F-16.23: a named record's Threads as of the scene; null for a secret or a thread. */
  threads: SheetThreadsView.nullable(),
  /** F-16.23: a character's Age as of the scene (decision 5); null for any other record. */
  age: SheetAgeView.nullable(),
  /** F-16.22, F-16.23: a secret's or a thread's own view as of the scene; null for a named record. */
  topic: TopicView.nullable()
})
export type SheetMemory = z.infer<typeof SheetMemory>

/** Why background reading is paused (slice 3). */
export const MEMORY_PAUSES = [
  'off',
  'noProvider',
  'health',
  'cloudCap',
  'localCutoff',
  'dailyCap'
] as const
export const MemoryPause = z.enum(MEMORY_PAUSES)
export type MemoryPause = z.infer<typeof MemoryPause>

/** *Rebuild memory* in progress or done (the `memoryRebuild` settings row). */
export const RebuildProgress = z.object({
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  draftId: z.string(),
  total: z.number().int().nonnegative(),
  done: z.number().int().nonnegative()
})
export type RebuildProgress = z.infer<typeof RebuildProgress>

/**
 * F-16.30: *Check the book* while it runs or as it last ended in this session (the activity bar's
 * progress, as *Rebuild memory*'s): the pairs judged of those due, then the stronger check's
 * confirmations of those due; once ended, whether it ended early and why. Null before a check this
 * session.
 */
export const CheckProgress = z.object({
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  judged: z.number().int().nonnegative(),
  toJudge: z.number().int().nonnegative(),
  confirmed: z.number().int().nonnegative(),
  toConfirm: z.number().int().nonnegative(),
  /**
   * It ended before it judged everything: a Stop, a failure, or a hold met as it began (the cap
   * reached, the switch turned off, the provider removed since *Check*: nothing judged, no report).
   */
  stopped: z.boolean(),
  /** What ended it early, with the next step (a failure's cause or the hold); null for a Stop. */
  reason: z.string().nullable()
})
export type CheckProgress = z.infer<typeof CheckProgress>

/**
 * The footer: "Read 3 min ago · today 0.3¢ · Cloud 12¢ of $1"; the last *Rebuild memory* (its
 * progress for the activity bar while it runs, F-16.19), null before any; and *Check the book*'s
 * progress (F-16.30), null before a check this session.
 */
export const MemoryStatus = z.object({
  lastRead: z.object({ nodeId: z.string(), at: z.string() }).nullable(),
  paused: MemoryPause.nullable(),
  todayUsd: z.number().nonnegative(),
  cloud: z
    .object({ spentUsd: z.number().nonnegative(), capUsd: z.number().nonnegative() })
    .nullable(),
  rebuild: RebuildProgress.nullable(),
  check: CheckProgress.nullable()
})
export type MemoryStatus = z.infer<typeof MemoryStatus>

/** Needs a look's reading notices, each with its own actions (slices 3 and 4). */
export const MemoryNotice = z.discriminatedUnion('kind', [
  z.object({
    id: z.string(),
    kind: z.literal('backlog'),
    scenes: z.number().int().positive(),
    priceUsd: z.number().nonnegative()
  }),
  z.object({
    id: z.string(),
    kind: z.literal('draftUnread'),
    draftId: z.string(),
    scenes: z.number().int().nonnegative(),
    priceUsd: z.number().nonnegative()
  }),
  z.object({
    id: z.string(),
    kind: z.literal('backfill'),
    recordId: z.string(),
    name: z.string(),
    pages: z.number().int().positive(),
    priceUsd: z.number().nonnegative()
  }),
  z.object({
    id: z.string(),
    kind: z.literal('health'),
    model: z.string(),
    quotes: z.number().min(0).max(1),
    verified: z.number().min(0).max(1),
    /** "Switch to DeepSeek V4 Flash" applies: OpenRouter or Cloud, on another fast model. */
    switchable: z.boolean()
  }),
  z.object({
    id: z.string(),
    kind: z.literal('cloudCap'),
    month: z.string(),
    capUsd: z.number().nonnegative()
  }),
  z.object({ id: z.string(), kind: z.literal('localCutoff'), model: z.string() }),
  /**
   * Decision 4 (F-16.18, P2a-D13): the text's quoted value disagrees with a typed POV, place, time
   * or year; asked once (*Update my detail* writes the text's value through `sceneDetail:set`;
   * *Keep mine* is a `notProblem` Dismissed row). Its id is `detail:<nodeId>:<field>`.
   */
  z.object({
    id: z.string(),
    kind: z.literal('detailConflict'),
    nodeId: z.string(),
    /** The scene's reference ("14.2"). */
    ref: z.string(),
    field: z.enum(TYPED_FIELDS),
    typed: z.string(),
    text: z.string(),
    /** The record the text's value names (the card's POV; a place record the place names), or null. */
    textRecordId: z.string().nullable(),
    quote: z.string()
  }),
  /**
   * F-16.29 (P4 slice 3): a *Rebuild memory* finished: what it added (new lines on how many sheets,
   * names waiting on a question, possible contradictions it opened), with *Review* (the renderer
   * opens the grouped summary) and *Done* (`dismiss`: never shown again for this rebuild). Its id
   * is `rebuildDone:<startedAt>`.
   */
  z.object({
    id: z.string(),
    kind: z.literal('rebuildDone'),
    startedAt: z.string(),
    lines: z.number().int().nonnegative(),
    sheets: z.number().int().nonnegative(),
    names: z.number().int().nonnegative(),
    findings: z.number().int().nonnegative()
  }),
  /**
   * F-16.27, F-16.30 (P4 slice 3): pairs the background judge left for *Check the book* (today's
   * background limit reached, or the Cloud cap), with the price of judging them. Its id is
   * `findingsWaiting:<day>`; closing it (`dismiss`) hides it for the day.
   */
  z.object({
    id: z.string(),
    kind: z.literal('findingsWaiting'),
    pairs: z.number().int().positive(),
    priceUsd: z.number().nonnegative()
  }),
  /**
   * F-16.28 (P4-D16, design §2.4): of the last 20 underlined contradictions that closed, fewer than
   * 70 % were right; asked once: *Panel only* (the renderer sets `reading.underlines` to `panel`)
   * or *Keep underlines*. Either answer, or closing it, records that it was asked. Its id is
   * `underlinePrecision`.
   */
  z.object({
    id: z.string(),
    kind: z.literal('underlinePrecision'),
    counted: z.number().int().positive(),
    notProblems: z.number().int().nonnegative()
  })
])
export type MemoryNotice = z.infer<typeof MemoryNotice>
/** Decision 4's typed-detail conflict (F-16.18), one of the notices. */
export type DetailConflictNotice = Extract<MemoryNotice, { kind: 'detailConflict' }>

/**
 * What a notice's buttons do (`memory:answerNotice`, F-16.16, F-16.19): *Read them* / *Read*
 * (`read`: the work is queued as asked, spent on the author's say-so), *Later* / *Not now*
 * (`later`), *Keep reading anyway* (`keepReading`, remembered per model; also lifts a local
 * cut-off pause), *Switch to DeepSeek V4 Flash* (`switchModel`), *Allow another $1 this month*
 * (`allowMore`), *Keep mine* on a typed-detail conflict (`keepMine`, F-16.18: a `notProblem`
 * Dismissed row), F-16.28's *Panel only* (`panelOnly`; the renderer sets the setting) and *Keep
 * underlines* (`keepUnderlines`), and closing it (`dismiss`: the pause, if any, stays).
 */
export const MEMORY_NOTICE_ACTIONS = [
  'read',
  'later',
  'keepReading',
  'switchModel',
  'allowMore',
  'keepMine',
  'panelOnly',
  'keepUnderlines',
  'dismiss'
] as const
export const MemoryNoticeAction = z.enum(MEMORY_NOTICE_ACTIONS)
export type MemoryNoticeAction = z.infer<typeof MemoryNoticeAction>

/** Why `memory:settle` queued nothing: the gate's answers, reading off, or reading paused. */
export const SETTLE_SKIPS = [
  'upToDate',
  'cosmetic',
  'empty',
  'notReadable',
  'off',
  'paused'
] as const
export const SettleSkip = z.enum(SETTLE_SKIPS)
export type SettleSkip = z.infer<typeof SettleSkip>

/** What `memory:settle` answers (F-16.16): the scene was queued for reading, or why not. */
export const SettleResult = z.object({ queued: z.boolean(), reason: SettleSkip.nullable() })
export type SettleResult = z.infer<typeof SettleResult>

/** Spot checks counted (F-16.17): "proof agreement: 48 of 50 checked", never "accuracy". */
export const SpotCount = z.object({
  checked: z.number().int().nonnegative(),
  agreed: z.number().int().nonnegative()
})
export type SpotCount = z.infer<typeof SpotCount>

/** One model's health over its last 20 readings (`health.ts`), as *Details* shows it. */
export const ModelHealthView = z.object({
  model: z.string(),
  judged: z.boolean(),
  readings: z.number().int().nonnegative(),
  items: z.number().int().nonnegative(),
  quotes: z.number().min(0).max(1),
  verified: z.number().min(0).max(1),
  paused: z.boolean(),
  /** The author chose *Keep reading anyway* for this model in this project. */
  keepReading: z.boolean()
})
export type ModelHealthView = z.infer<typeof ModelHealthView>

/** `memory:health`: per model, the spot checks so far, and the cut-off rate of recent readings. */
export const MemoryHealthReport = z.object({
  models: z.array(ModelHealthView),
  spot: z.object({ fast: SpotCount, strong: SpotCount }),
  /** Share of the last 100 readings cut off at their cap (`finish_reason: length`). */
  cutRate: z.number().min(0).max(1),
  /**
   * F-16.28 (design §2.3 "Measuring accuracy"): the active draft's pairs judged both ways and how
   * many of them the two orders agreed on; and underline precision, the last 20 underlined
   * contradictions that closed and how many of them were right. Never called "accuracy".
   */
  contradictions: z.object({
    pairs: z.number().int().nonnegative(),
    agreed: z.number().int().nonnegative(),
    underlines: z.object({
      counted: z.number().int().nonnegative(),
      right: z.number().int().nonnegative()
    })
  })
})
export type MemoryHealthReport = z.infer<typeof MemoryHealthReport>

/**
 * What a rebuild changed, grouped by sheet (`memory:rebuildSummary`): the new live lines per
 * record (each can go at once with *Not right*), and the names whose lines wait on a question
 * (*Not names* answers them all).
 */
export const RebuildSummary = z.object({
  progress: RebuildProgress,
  sheets: z.array(
    z.object({
      recordId: z.string(),
      name: z.string(),
      lines: z.number().int().nonnegative(),
      claimIds: z.array(z.string())
    })
  ),
  waiting: z.array(
    z.object({ norm: z.string(), text: z.string(), lines: z.number().int().nonnegative() })
  ),
  /**
   * F-16.22 (P2b slice 4): the secrets and threads the rebuild made, AI-made and still there
   * ("New secrets and threads (n)", with one *Not right* for them all).
   */
  topics: z.array(
    z.object({ recordId: z.string(), kind: z.enum(['secret', 'thread']), label: z.string() })
  ),
  /**
   * F-16.27, F-16.29 (P4 slice 3): the possible contradictions the rebuild opened (open findings
   * made since it started), shown with the Contradiction check on ("Possible contradictions (n)",
   * with one *Not a problem* for them all).
   */
  findings: z.array(FindingView)
})
export type RebuildSummary = z.infer<typeof RebuildSummary>

/** What `memory:rebuild` answers: the scenes queued with the price shown, or an AI failure. */
export const RebuildStartResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    queued: z.number().int().nonnegative(),
    estimate: RebuildEstimate
  }),
  z.object({ ok: z.literal(false), code: AiErrorCode, message: z.string(), nextStep: z.string() })
])
export type RebuildStartResult = z.infer<typeof RebuildStartResult>

/** The rebuild summary's bulk actions (`memory:rebuildAction`). */
export const RebuildAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('notRightAll'), recordId: z.string() }),
  z.object({ action: z.literal('notNames') }),
  /** F-16.22: *Not right* on every secret and thread the rebuild made (*Not a secret* each). */
  z.object({ action: z.literal('notTopics') }),
  /** F-16.29 (P4 slice 3): *Not a problem* on every possible contradiction the rebuild opened. */
  z.object({ action: z.literal('notProblems') })
])
export type RebuildAction = z.infer<typeof RebuildAction>

/**
 * *Not right* on an AI line (F-16.18, design §2.7): *Wrong value* (a `notRight` Dismissed row; the
 * line goes, and *Undo* in Dismissed brings it back), or *Not about Mara* with the record the
 * author picks (one `verify.v1` call: supported, the line moves to that record; not, it is
 * dismissed as a wrong value).
 */
export const NotRightChoice = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('wrongValue') }),
  z.object({ kind: z.literal('notAbout'), recordId: z.string() })
])
export type NotRightChoice = z.infer<typeof NotRightChoice>

/**
 * What `memory:notRight` answers: the line `moved` to the picked record, `dismissed` (with the
 * Dismissed row it wrote, which *Undo* brings it back from), `unchecked` (*Not about* could not be
 * checked: its sentence changed since it was read, or the checker gave no verdict; nothing
 * changed), or `gone` (it had gone already); an AI failure of the *Not about* check as data.
 */
export const NotRightResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    outcome: z.enum(['moved', 'dismissed', 'unchecked', 'gone']),
    dismissed: Dismissed.nullable()
  }),
  z.object({ ok: z.literal(false), code: AiErrorCode, message: z.string(), nextStep: z.string() })
])
export type NotRightResult = z.infer<typeof NotRightResult>

/** A card entry *Not right* may dismiss: one of its fields, or a character on the page. */
export const CardEntryName = z.enum([...CARD_FIELDS, 'present'])

/**
 * *Not right* on a value the card gives (F-16.18; design Part 1 "every line the AI wrote has ⓘ
 * and Not right"): the scene's POV, place, time or year, or a character on the page (`value`: the
 * record's id for `pov` and `present`). A `notRight` Dismissed row for the scene, the field and
 * the value: Here, the card and the typed-detail conflicts leave it out, so the typed detail
 * stands; *Undo* in Dismissed brings it back.
 */
export const CardNotRight = z.object({
  nodeId: z.string(),
  field: CardEntryName,
  value: z.string()
})
export type CardNotRight = z.infer<typeof CardNotRight>

/**
 * What `memory:splitTopic` answers (P2b-D5): the topic made from the merged reveal, and the
 * `split` Dismissed row that keeps the two from merging again.
 */
export const SplitTopicResult = z.object({ recordId: z.string(), dismissed: Dismissed })
export type SplitTopicResult = z.infer<typeof SplitTopicResult>

/**
 * What `memory:topicNotRight` answers (P2b-D13): the `notRight` Dismissed rows written, one per
 * reveal; *Undo* on any of them brings the topic back as it was.
 */
export const TopicNotRightResult = z.object({ dismissed: z.array(Dismissed) })
export type TopicNotRightResult = z.infer<typeof TopicNotRightResult>

/** The card fields a Timeline row's year rests on (ⓘ: the quote, *Go there*, *Not right*). */
export const TIMELINE_CARD_FIELDS = ['year', 'flashback', 'elapsed'] as const
export const TimelineSourceView = z.object({
  field: z.enum(TIMELINE_CARD_FIELDS),
  entry: CardField
})
export type TimelineSourceView = z.infer<typeof TimelineSourceView>

/**
 * One row of the Book's Timeline (decision 5): a readable scene with its year, whether it is a
 * flashback, its elapsed hint, the typed time, ages (who is Here, or one record), and the card
 * fields the AI read that its year rests on (`sources`: the year the text states when it is the
 * row's, the flashback, the hint).
 */
export const TimelineRow = z.object({
  nodeId: z.string(),
  ref: z.string(),
  title: z.string(),
  year: YearView,
  flashback: z.boolean(),
  elapsed: ElapsedHintView.nullable(),
  time: z.string(),
  ages: z.array(z.object({ recordId: z.string(), age: AgeView })),
  sources: z.array(TimelineSourceView)
})
export type TimelineRow = z.infer<typeof TimelineRow>

export const TimelineMemory = z.object({
  /** The record whose age every row shows; null: who is Here in each. */
  recordId: z.string().nullable(),
  rows: z.array(TimelineRow)
})
export type TimelineMemory = z.infer<typeof TimelineMemory>

/**
 * F-16.27 (plan P4 §1.2): what `memory:findings` answers (slice 2): the active draft's open
 * findings (those touching the asked scene first, then by `RULE_ORDER` and reading order) and the
 * unclear ones, counts by state, how many wait for a verdict, and whether a judge job is queued or
 * running. Empty while the Contradiction check is off.
 */
export const FindingsView = z.object({
  /** The Contradiction check switch (`features.judge`): off, nothing is listed and none was judged. */
  on: z.boolean(),
  open: z.array(FindingView),
  unclear: z.array(FindingView),
  counts: z.record(z.enum(FINDING_STATES), z.number().int().nonnegative()),
  waiting: z.number().int().nonnegative(),
  judging: z.boolean(),
  /**
   * The asked scene's reading (null with no scene, or not a manuscript scene): whether the active
   * draft read it, and its finished sentences not read yet, which no rule has looked at. A scoped
   * answer about the scene (P4-D23) names what it has not checked.
   */
  scene: z.object({ read: z.boolean(), unread: z.number().int().nonnegative() }).nullable()
})
export type FindingsView = z.infer<typeof FindingsView>

/**
 * F-16.29 (plan P4 §1.2, `looseEnds.ts`): one loose end behind the furthest drafted scene: a
 * thread, a character or a planned card, where it was last touched, the scene the window is
 * measured to, "checked up to", and the question *Ask Ms Scribe* sends (worded positively; the
 * scoped "nothing since" line is the renderer's alone).
 */
export const LooseEnd = z.object({
  kind: z.enum(LOOSE_END_KINDS),
  /** The thread's or character's record id, or the planned scene's node id. */
  id: z.string(),
  name: z.string(),
  /** Where it was last touched ("7.3"); null for a planned card. */
  lastRef: z.string().nullable(),
  lastNodeId: z.string().nullable(),
  /** The scene the window is measured to ("18.2"). */
  horizonRef: z.string(),
  checkedUpTo: SceneRefView.nullable(),
  ask: z.string()
})
export type LooseEnd = z.infer<typeof LooseEnd>

/** Needs a look's Loose ends: at most 10, the rest counted, with the furthest drafted scene. */
export const LooseEndsView = z.object({
  items: z.array(LooseEnd),
  more: z.number().int().nonnegative(),
  furthest: SceneRefView.nullable(),
  checkedUpTo: SceneRefView.nullable()
})
export type LooseEndsView = z.infer<typeof LooseEndsView>

/**
 * F-16.30 (plan P4 §3.1, design Part 1 "Revising"): what *Check the book* never checks, whatever
 * the book holds: no rule covers them. The report always names them.
 */
export const CHECK_NOT_COVERED = [
  'travel times and distances',
  'where objects are',
  'anything the book never states'
] as const

/**
 * F-16.30: *Check the book*'s price, worked out locally before anything is sent (P4-D22): the
 * candidate pairs it would look at (C1–C7, held and hidden ones apart), the pairs and orders no
 * remembered verdict covers (the fast check's calls), the stronger check's confirmations (about:
 * the open findings not yet confirmed and a quarter of the new pairs; at most: all that could be
 * due, never more than 20), priced from the cost registry on the models set up. `free` when
 * nothing would be sent (the book has not changed since the last check). Also: the candidates
 * hidden because a scene is a flashback (`sceneFlashback`: the author's switch, else the card's
 * checked reading), the scenes not read yet, and whether it goes
 * through MythScribe Cloud (spent from the Balance).
 */
export const CheckEstimate = z.object({
  free: z.boolean(),
  pairs: z.number().int().nonnegative(),
  /** Pair-orders with no remembered verdict. */
  uncached: z.number().int().nonnegative(),
  fastCalls: z.number().int().nonnegative(),
  confirms: z.object({
    about: z.number().int().nonnegative(),
    most: z.number().int().nonnegative()
  }),
  aboutUsd: z.number().nonnegative(),
  mostUsd: z.number().nonnegative(),
  /** False when a model's price is unknown (the prices are then lower bounds). */
  priced: z.boolean(),
  hidden: z.number().int().nonnegative(),
  unreadScenes: z.array(SceneRefView),
  cloud: z.boolean(),
  fastModel: z.string(),
  strongModel: z.string()
})
export type CheckEstimate = z.infer<typeof CheckEstimate>

/** What `memory:checkBook` answers: the check queued with its price, or why it cannot run. */
export const CheckStartResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), estimate: CheckEstimate }),
  z.object({ ok: z.literal(false), code: AiErrorCode, message: z.string(), nextStep: z.string() })
])
export type CheckStartResult = z.infer<typeof CheckStartResult>

/**
 * F-16.30: the last *Check the book*'s report (`memory:checkReport`, the `memoryCheck` settings
 * row, kept until the next check): the open findings it found (those still open), the unclear
 * ones, the ones the stronger check cleared ("the stronger check found no contradiction"), how
 * many the stronger check confirmed, what it checked (pairs by rule, scenes, note pages), what it
 * did not (what no rule covers, the scenes not read yet, the open findings past the 20
 * confirmations, pairs left unjudged when it was stopped), the findings hidden because a scene
 * is a flashback (the author's switch, or the card's reading; each with *Not a flashback?*), and
 * the secrets readers know that no scene shows anyone learning, as the scenes and "checked up to"
 * only (rule 5: the renderer words the scoped line). A finding that closed since is left out.
 */
export const CheckReport = z.object({
  at: z.string(),
  draftId: z.string(),
  costUsd: z.number().nonnegative(),
  /** The check was stopped (or a failure ended it) before it judged everything. */
  stopped: z.boolean(),
  found: z.array(FindingView),
  unclear: z.array(FindingView),
  cleared: z.array(FindingView),
  confirmed: z.number().int().nonnegative(),
  checked: z.object({
    pairs: z.number().int().nonnegative(),
    byRule: z.record(FindingRule, z.number().int().nonnegative()),
    scenes: z.number().int().nonnegative(),
    notes: z.number().int().nonnegative()
  }),
  notChecked: z.object({
    fixed: z.array(z.string()),
    unreadScenes: z.array(SceneRefView),
    pastConfirm: z.number().int().nonnegative(),
    unjudged: z.number().int().nonnegative()
  }),
  hidden: z.array(
    z.object({
      findingId: z.string(),
      /**
       * The flashback scene (`sceneFlashback`): *Not a flashback?* sets its Flashback switch to
       * Not a flashback (2026-10-14; it marked the card's flashback not right before).
       */
      nodeId: z.string(),
      ref: z.string(),
      label: z.string(),
      /** The author's switch makes it a flashback (else the card's verified reading). */
      typed: z.boolean()
    })
  ),
  secretsNobodyLearns: z.array(
    z.object({
      secretId: z.string(),
      label: z.string(),
      readersSince: SceneRefView.nullable(),
      checkedUpTo: SceneRefView.nullable()
    })
  )
})
export type CheckReport = z.infer<typeof CheckReport>

/**
 * F-16.27, F-16.29 (plan P4 §3.2): the answers on a finding. *Not a problem* writes a `notProblem`
 * Dismissed row keyed by the finding's *Not a problem* key and closes it (Undo brings it back,
 * with its remembered verdicts, at no cost). *This one's right* under side `side` marks the other
 * side not right through its own path (a line's *Wrong value*, a card's *Not right* on who is on
 * the page) and closes the finding; it never edits the manuscript, and is refused when the other
 * side is a note (the panel offers *Update my note* there).
 */
export const FindingAction = z.discriminatedUnion('action', [
  z.object({ findingId: z.string(), action: z.literal('notProblem') }),
  z.object({ findingId: z.string(), action: z.literal('right'), side: z.enum(['a', 'b']) })
])
export type FindingAction = z.infer<typeof FindingAction>

/** What a finding's answer wrote, and (for *This one's right*) the scene of the side marked not right. */
export const FindingActionResult = z.object({
  dismissed: Dismissed.nullable(),
  other: SceneRefView.nullable()
})
export type FindingActionResult = z.infer<typeof FindingActionResult>

/**
 * F-16.29 (plan P4 §3.2, P4-D18): *Update my note*'s proposal, made in code with no AI: the note
 * paragraph (`before`, its index on the page) with the note's value words in its sentence replaced
 * by the book's value (`after`). Offered only for a book-against-note finding whose book side is
 * narration in `now` mode; the author edits it and saves (`memory:applyNotePatch`).
 */
export const NotePatch = z.object({
  findingId: z.string(),
  owner: z.object({
    kind: z.enum(['record', 'research']),
    id: z.string(),
    /** The record's name or the Research page's title. */
    name: z.string()
  }),
  page: z.literal('pinned').nullable(),
  index: z.number().int().nonnegative(),
  before: z.string(),
  after: z.string(),
  /** The note's sentence as it reads now, and the book's value. */
  sentence: z.string(),
  value: z.string()
})
export type NotePatch = z.infer<typeof NotePatch>

/** The longest paragraph *Update my note* writes. */
export const NOTE_PATCH_MAX = 4_000

/** What `memory:applyNotePatch` wrote: the page, and whether the finding closed. */
export const NotePatchApplied = z.object({
  owner: z.object({ kind: z.enum(['record', 'research']), id: z.string() }),
  closed: z.boolean()
})
export type NotePatchApplied = z.infer<typeof NotePatchApplied>

/** F-16.29: *Not a problem* on a loose end (it comes back once the thing is touched again). */
export const LooseEndKey = z.object({
  kind: z.enum(LOOSE_END_KINDS),
  id: z.string(),
  lastNodeId: z.string().nullable()
})
export type LooseEndKey = z.infer<typeof LooseEndKey>
