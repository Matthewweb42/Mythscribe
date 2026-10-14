import { z } from 'zod'
import { sentenceHash } from './anchor'
import { ClaimMode, ClaimVoice, setsState } from './claims'
import { dismissedKey } from './dismissed'

/**
 * Contradictions as story memory v2 keeps them (F-16.27; design §2.4, plan P4 §1.2): the
 * vocabulary every layer shares. Code finds candidate pairs under rules C1–C7
 * (`candidates.ts`); a candidate becomes a `finding` row, judged twice by `judge.v1` (slice 2),
 * and only two "contradiction" verdicts make it open. A finding is derived index data (AI rule 1's
 * exception): its sides are references into the book and the author's notes, never copies of the
 * text, and it closes itself when its rule no longer produces it.
 *
 * Relative imports only: `schema.ts` imports the enums below, and drizzle-kit loads it without
 * the `@shared` alias.
 */

/** The rules (design §2.4's table). C7 runs on *Check the book* only. */
export const FINDING_RULES = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'] as const
export const FindingRule = z.enum(FINDING_RULES)
export type FindingRule = z.infer<typeof FindingRule>

/** A rule's variant: C2's dead character or body change, C4's birth year or falling age. */
export const FINDING_VARIANTS = ['dead', 'body', 'birth', 'falls'] as const
export const FindingVariant = z.enum(FINDING_VARIANTS)
export type FindingVariant = z.infer<typeof FindingVariant>

/**
 * A finding's state:
 * - `unjudged`: a candidate waiting for its two verdicts;
 * - `held`: a side is a claim whose sentence changed since it was read: never judged, shown or
 *   closed until the re-read (P4-D13);
 * - `hidden`: it needs a scene not to be a flashback, and the scene's card says it is one (shown
 *   only by *Check the book*, with *Not a flashback?*);
 * - `open`: both orders said "contradiction";
 * - `unclear`: no "fine", and at least one "unclear" (shown muted, never counted, never
 *   underlined);
 * - `fine`: a "fine" in either order (or the stronger check's), not shown.
 */
export const FINDING_STATES = ['unjudged', 'held', 'hidden', 'open', 'unclear', 'fine'] as const
export const FindingState = z.enum(FINDING_STATES)
export type FindingState = z.infer<typeof FindingState>

/** The judge's verdicts: `c` a contradiction, `ok` both can be true, `u` the words do not settle it. */
export const JUDGE_VERDICTS = ['c', 'ok', 'u'] as const
export const JudgeVerdict = z.enum(JUDGE_VERDICTS)
export type JudgeVerdict = z.infer<typeof JudgeVerdict>

/** The order findings are listed and underlined in: fixed values first, notes, then the rest. */
export const RULE_ORDER: readonly FindingRule[] = ['C1', 'C6', 'C2', 'C3', 'C4', 'C5', 'C7']

/** Why a finding closed (kept for slice 5's precision log). */
export const FINDING_CLOSE_REASONS = ['gone', 'dismissed', 'right'] as const
export type FindingCloseReason = (typeof FINDING_CLOSE_REASONS)[number]

/** The note owners C6 reads: a record's Pinned page, or a Research page. */
export const NOTE_OWNER_KINDS = ['record', 'research'] as const
export type NoteOwnerKind = (typeof NOTE_OWNER_KINDS)[number]

/**
 * One side of a finding, a reference (never a copy of the quote):
 * - `claim`: a stored claim, by id, with the scene and value it had when the candidate was made,
 *   and `seen`, a hash of what the judge reads of it (its quote, the sentences it rests on, its
 *   voice and mode: `claimSeen`), so a pair whose words changed under the same key is judged again;
 * - `presence`: a record on the page in a scene (a held `present` entry of its card, C2);
 * - `note`: a sentence of a canon note paragraph (a record's Pinned page or a Research page), with
 *   the value code read from it and, for a dated line, the scene it names (C6, and C4's Pinned
 *   "Born:" line).
 */
export const FindingSide = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('claim'),
    claimId: z.string(),
    nodeId: z.string(),
    valueKey: z.string(),
    seen: z.string()
  }),
  z.object({ kind: z.literal('presence'), nodeId: z.string(), recordId: z.string() }),
  z.object({
    kind: z.literal('note'),
    ownerKind: z.enum(NOTE_OWNER_KINDS),
    ownerId: z.string(),
    /** `pinned` for a record's page; null for a Research page. */
    page: z.literal('pinned').nullable(),
    para: z.number().int().nonnegative(),
    /** The sentence's index in its paragraph (`splitSentences`). */
    sentence: z.number().int().nonnegative(),
    value: z.string(),
    /** A dated line's scene (`Label (from 12.1 'Title'): value`), else null. */
    datedNodeId: z.string().nullable()
  })
])
export type FindingSide = z.infer<typeof FindingSide>

/**
 * What the judge reads of a claim side, as a hash (never the words): its quote, the sentences its
 * proof rests on (`anchor`), its voice and mode. A revival (a new quote under the same id) or a free
 * re-proof (new sentences) moves it; a restore (the very sentences back) does not.
 */
export function claimSeen(claim: {
  quote: string
  anchor: readonly string[]
  voice: ClaimVoice
  mode: ClaimMode
}): string {
  return sentenceHash([claim.quote, claim.voice, claim.mode, ...claim.anchor].join(' | '))
}

/** What a finding carries beside its sides: C4's story year (typed or quoted in that scene). */
export const FindingExtra = z.object({
  year: z
    .object({
      value: z.number().int(),
      source: z.enum(['typed', 'quoted']),
      nodeId: z.string()
    })
    .optional()
})
export type FindingExtra = z.infer<typeof FindingExtra>

/**
 * The pair as the judge reads it, as last rendered (P4 slice 2 review, migration 0039): `inputs` is
 * a stamp of everything its rendering reads (its sides' words and scenes, their cards and typed
 * details, the scenes between them, the notes and names), cheap to compute; `keys` are its
 * verdict-cache keys in both orders (null while it could not be rendered). The verdicts on a row
 * are for these keys: while `inputs` holds the pair is not rendered again, and when the keys move
 * the verdicts are cleared and the cache asked for the new words.
 */
export const FindingRendered = z.object({
  inputs: z.string(),
  keys: z.object({ ab: z.string(), ba: z.string() }).nullable()
})
export type FindingRendered = z.infer<typeof FindingRendered>

/** A stored finding (`finding` row). */
export const Finding = z.object({
  id: z.string(),
  draftId: z.string(),
  rule: FindingRule,
  variant: FindingVariant.nullable(),
  /** The subject; the knower for C3, the thread for C5. */
  recordId: z.string(),
  /** The slot; `kinship:<objectId>`, `knows:<secretId>` (C3) and `thread` (C5) included. */
  slot: z.string(),
  /** The lifecycle identity (`findingKey`). */
  key: z.string(),
  /** The *Not a problem* key (`npKey`). */
  npKey: z.string(),
  a: FindingSide,
  b: FindingSide,
  extra: FindingExtra.nullable(),
  verdictAb: JudgeVerdict.nullable(),
  verdictBa: JudgeVerdict.nullable(),
  /** The judge's reason (at most 8 words), with a `c`. */
  why: z.string().nullable(),
  /** The stronger check's verdict (*Check the book*). */
  confirm: JudgeVerdict.nullable(),
  confirmWhy: z.string().nullable(),
  state: FindingState,
  /** What judging it cost: its share of each call. */
  costUsd: z.number().nonnegative(),
  /** When it was first drawn as an underline (slice 5). */
  shownAt: z.string().nullable(),
  created: z.string(),
  judgedAt: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  /** What the verdicts were given for (null until the pair was first rendered). */
  rendered: FindingRendered.nullable()
})
export type Finding = z.infer<typeof Finding>

/**
 * A side as Needs a look and the hover card show it (slices 2–5): what it is, where (a scene's
 * reference, or "Your note on Orrin"), its paragraph, the quote (the claim's, the presence's from
 * the card, or the note's sentence), the value, the claim's voice and mode, a label, and where
 * *Go there* opens.
 */
export const FindingSideView = z.object({
  kind: z.enum(['claim', 'presence', 'note']),
  ref: z.string(),
  nodeId: z.string().nullable(),
  para: z.number().int().nullable(),
  quote: z.string(),
  value: z.string(),
  voice: ClaimVoice.nullable(),
  mode: ClaimMode.nullable(),
  label: z.string(),
  open: z.object({
    kind: z.enum(['scene', 'record', 'research']),
    id: z.string(),
    para: z.number().int().nullable()
  })
})
export type FindingSideView = z.infer<typeof FindingSideView>

/** A finding as the channels answer it (slice 2's `memory:findings`). */
export const FindingView = z.object({
  id: z.string(),
  rule: FindingRule,
  variant: FindingVariant.nullable(),
  recordId: z.string(),
  /** The record's name. */
  name: z.string(),
  slot: z.string(),
  slotLabel: z.string(),
  a: FindingSideView,
  b: FindingSideView,
  state: FindingState,
  verdictAb: JudgeVerdict.nullable(),
  verdictBa: JudgeVerdict.nullable(),
  /** The stronger check confirmed it. */
  confirmed: z.boolean(),
  why: z.string().nullable(),
  costUsd: z.number().nonnegative(),
  actions: z.object({
    /**
     * *This one's right* under each side: it marks the other side not right, so it is offered only
     * when both sides are book passages (a claim or a presence; never on a note conflict, P4-D17).
     */
    right: z.object({ a: z.boolean(), b: z.boolean() }),
    /** *Update my note* (a C6 finding whose book side is narration in `now` mode, P4-D18). */
    updateNote: z.boolean(),
    /** *Not a flashback?*: the scene whose card hides it. */
    notFlashback: z.string().nullable()
  })
})
export type FindingView = z.infer<typeof FindingView>

/** Where a side is: a scene's node id, or a note's owner (`note:record:<id>`, `note:research:<id>`). */
export function sideAt(side: FindingSide): string {
  return side.kind === 'note' ? `note:${side.ownerKind}:${side.ownerId}` : side.nodeId
}

/** The value a side stands for in the key: a claim's value key, `here` for a presence, a note's value. */
export function sideValue(side: FindingSide): string {
  switch (side.kind) {
    case 'claim':
      return side.valueKey
    case 'presence':
      return 'here'
    case 'note':
      return side.value
  }
}

/**
 * The *Not a problem* key (P4-D14, design §2.4): the record, the slot and both sides' places and
 * values, sorted, so it is one key whichever side came first and it survives rewording and renames.
 */
export function npKey(recordId: string, slot: string, a: FindingSide, b: FindingSide): string {
  return dismissedKey({
    kind: 'notProblem',
    finding: {
      recordId,
      slot,
      a: { at: sideAt(a), value: sideValue(a) },
      b: { at: sideAt(b), value: sideValue(b) }
    }
  })
}

/** A finding's lifecycle key: its rule and variant, and its *Not a problem* key. */
export function findingKey(
  rule: FindingRule,
  variant: FindingVariant | null,
  notProblemKey: string
): string {
  return `${rule}${variant === null ? '' : `:${variant}`}|${notProblemKey}`
}

/**
 * The state two verdicts give (P4-D10): both `c` → `open`; any `ok` → `fine`; an order not judged
 * yet → `unjudged`; otherwise (a `u`, no `ok`) → `unclear`.
 */
export function verdictOf(
  ab: JudgeVerdict | null,
  ba: JudgeVerdict | null
): 'open' | 'fine' | 'unjudged' | 'unclear' {
  if (ab === 'c' && ba === 'c') return 'open'
  if (ab === 'ok' || ba === 'ok') return 'fine'
  if (ab === null || ba === null) return 'unjudged'
  return 'unclear'
}

/**
 * A finding's state: held or hidden as its candidate says, else what its verdicts give, the
 * stronger check's `ok` clearing an open one and its `u` making it unclear (P4-D10).
 */
export function findingState(input: {
  held: boolean
  hidden: boolean
  verdictAb: JudgeVerdict | null
  verdictBa: JudgeVerdict | null
  confirm: JudgeVerdict | null
}): FindingState {
  if (input.held) return 'held'
  if (input.hidden) return 'hidden'
  const state = verdictOf(input.verdictAb, input.verdictBa)
  if (state === 'open' && input.confirm === 'ok') return 'fine'
  if (state === 'open' && input.confirm === 'u') return 'unclear'
  return state
}

/**
 * Whether a claim may raise C1, C2 or C6 on its own (P4-D1; design §2.4): only narration in
 * `now` mode. A claim in another voice or mode may still be the other side of a pair.
 */
export const raisesAlone = (claim: { voice: ClaimVoice; mode: ClaimMode }): boolean =>
  setsState(claim)
