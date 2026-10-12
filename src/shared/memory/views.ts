import { z } from 'zod'
import { AiErrorCode } from '../ai'
import {
  CardFields,
  CLAIM_PROOFS,
  ClaimMode,
  ClaimState,
  ClaimVoice,
  ReadingPurpose,
  SpotTier,
  SpotVerdict
} from './claims'
import { SlotSchema } from './slots'
import { RebuildEstimate } from './switchover'
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

/** The card as scene details show it: the AI's map of the scene, never quoted. */
export const CardView = z.object({
  line: z.string(),
  gist: z.string(),
  fields: CardFields,
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

/** The footer: "Read 3 min ago · today 0.3¢ · Cloud 12¢ of $1". */
export const MemoryStatus = z.object({
  lastRead: z.object({ nodeId: z.string(), at: z.string() }).nullable(),
  paused: MemoryPause.nullable(),
  todayUsd: z.number().nonnegative(),
  cloud: z
    .object({ spentUsd: z.number().nonnegative(), capUsd: z.number().nonnegative() })
    .nullable()
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
  z.object({
    id: z.string(),
    kind: z.literal('detailConflict'),
    nodeId: z.string(),
    field: z.enum(TYPED_FIELDS),
    typed: z.string(),
    text: z.string(),
    quote: z.string()
  })
])
export type MemoryNotice = z.infer<typeof MemoryNotice>

/**
 * What a notice's buttons do (`memory:answerNotice`, F-16.16, F-16.19): *Read them* / *Read*
 * (`read`: the work is queued as asked, spent on the author's say-so), *Later* / *Not now*
 * (`later`), *Keep reading anyway* (`keepReading`, remembered per model; also lifts a local
 * cut-off pause), *Switch to DeepSeek V4 Flash* (`switchModel`), *Allow another $1 this month*
 * (`allowMore`), and closing it (`dismiss`: the pause, if any, stays).
 */
export const MEMORY_NOTICE_ACTIONS = [
  'read',
  'later',
  'keepReading',
  'switchModel',
  'allowMore',
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
  z.object({ ok: z.literal(true), queued: z.number().int().nonnegative(), estimate: RebuildEstimate }),
  z.object({ ok: z.literal(false), code: AiErrorCode, message: z.string(), nextStep: z.string() })
])
export type RebuildStartResult = z.infer<typeof RebuildStartResult>

/** The rebuild summary's bulk actions (`memory:rebuildAction`). */
export const RebuildAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('notRightAll'), recordId: z.string() }),
  z.object({ action: z.literal('notNames') })
])
export type RebuildAction = z.infer<typeof RebuildAction>
