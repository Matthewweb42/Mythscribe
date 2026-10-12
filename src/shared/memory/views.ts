import { z } from 'zod'
import { AiErrorCode } from '../ai'
import {
  CARD_FIELDS,
  CardFields,
  CLAIM_PROOFS,
  ClaimMode,
  ClaimState,
  ClaimVoice,
  ReadingPurpose,
  SpotTier,
  SpotVerdict
} from './claims'
import { Dismissed } from './dismissed'
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
  claims: z.array(ClaimView)
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
  later: z.number().int().nonnegative()
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
 * The footer: "Read 3 min ago · today 0.3¢ · Cloud 12¢ of $1"; and the last *Rebuild memory*
 * (its progress for the activity bar while it runs, F-16.19), null before any.
 */
export const MemoryStatus = z.object({
  lastRead: z.object({ nodeId: z.string(), at: z.string() }).nullable(),
  paused: MemoryPause.nullable(),
  todayUsd: z.number().nonnegative(),
  cloud: z
    .object({ spentUsd: z.number().nonnegative(), capUsd: z.number().nonnegative() })
    .nullable(),
  rebuild: RebuildProgress.nullable()
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
 * Dismissed row), and closing it (`dismiss`: the pause, if any, stays).
 */
export const MEMORY_NOTICE_ACTIONS = [
  'read',
  'later',
  'keepReading',
  'switchModel',
  'allowMore',
  'keepMine',
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
  cutRate: z.number().min(0).max(1)
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
  )
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
  z.object({ action: z.literal('notNames') })
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
  stale: z.boolean()
})
export type TopicQuoteView = z.infer<typeof TopicQuoteView>

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
    recordId: z.string(),
    stale: z.boolean()
  }),
  z.object({
    kind: z.literal('hereKnows'),
    secretId: z.string(),
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

/** A topic's sheet section: a secret's or a thread's view. */
export const TopicView = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('secret'), secret: SecretView }),
  z.object({ kind: z.literal('thread'), thread: ThreadMemoryView })
])
export type TopicView = z.infer<typeof TopicView>

/** An elapsed hint the card quoted ("Three winters later"), where, and whether it crosses a year. */
export const ElapsedHintView = z.object({
  text: z.string(),
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
 * A character's age as of a scene (decision 5, P2b-D15): computed from a birth year and the
 * scene's year ("about 19 · year from 1.1"), not born yet, or the last stated age with the
 * year-crossing hints since listed and never added up ("19, stated in 2.1 · since then: 'Three
 * winters later' (14.1)").
 */
export const AgeView = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('computed'),
    age: z.number().int().nonnegative(),
    born: BornView,
    year: z.object({
      kind: z.enum(['typed', 'quoted', 'carried']),
      value: z.number().int(),
      from: SceneRefView
    })
  }),
  z.object({
    kind: z.literal('notBorn'),
    born: BornView,
    year: z.object({
      kind: z.enum(['typed', 'quoted', 'carried']),
      value: z.number().int(),
      from: SceneRefView
    })
  }),
  z.object({
    kind: z.literal('stated'),
    value: z.string(),
    claimId: z.string(),
    nodeId: z.string(),
    ref: z.string(),
    since: z.array(ElapsedHintView)
  })
])
export type AgeView = z.infer<typeof AgeView>

/**
 * One row of the Book's Timeline (decision 5): a readable scene with its year, whether it is a
 * flashback, its elapsed hint, the typed time, and ages (who is Here, or one record).
 */
export const TimelineRow = z.object({
  nodeId: z.string(),
  ref: z.string(),
  title: z.string(),
  year: YearView,
  flashback: z.boolean(),
  elapsed: ElapsedHintView.nullable(),
  time: z.string(),
  ages: z.array(z.object({ recordId: z.string(), age: AgeView }))
})
export type TimelineRow = z.infer<typeof TimelineRow>

export const TimelineMemory = z.object({
  /** The record whose age every row shows; null: who is Here in each. */
  recordId: z.string().nullable(),
  rows: z.array(TimelineRow)
})
export type TimelineMemory = z.infer<typeof TimelineMemory>
