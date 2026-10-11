import { z } from 'zod'

/**
 * The shape of the test book's labels (F-16.3): what a correct reading of `TEST_BOOK` yields,
 * scene by scene, for the P2a reader and verifier scoring (claims), P1's name matching and twin
 * gate (records, mentions, twin cases), P2b's who-knows-what (knows lines), and P4's
 * contradiction rules (planted contradictions and the "must not produce" negatives). Test data
 * only: nothing in the app imports it.
 */

const Id = z.string().regex(/^[a-z][a-z0-9-]*$/)
const SceneId = z.string().regex(/^[sh]\d{2}$/)
/** A slot from the design's closed list (§2.2), or `detail:<label>` / `relation:<record>`. */
const Slot = z
  .string()
  .regex(
    /^(eyes|born|species|kinship|hair|alive|role|age|scars|location|injuries|clothing|objects|traits|history|knows|thread|detail:[a-z]+|relation:[a-z][a-z0-9-]*)$/
  )

export const RECORD_KINDS = [
  'character',
  'place',
  'thing',
  'group',
  'term',
  'secret',
  'thread'
] as const

export const LabelAlias = z.object({
  text: z.string().min(1),
  /** Several records may own the alias's norm only when every one marks it shared (§2.2 rule 4). */
  shared: z.boolean().default(false)
})

export const LabelRecord = z.object({
  id: Id,
  name: z.string().min(1),
  kind: z.enum(RECORD_KINDS),
  aliases: z.array(LabelAlias).min(1),
  /** For a secret: who it started with and the sentence that reveals it (§2.5). */
  originator: Id.optional(),
  defining: z.object({ scene: SceneId, p: z.number().int().min(0), quote: z.string() }).optional()
})

export const CLAIM_VOICES = ['narration', 'dialogue', 'thought', 'rumour'] as const
export const CLAIM_MODES = ['now', 'memory', 'hypothetical', 'dream'] as const
export const CLAIM_EXPECTS = ['literal', 'verified', 'reject'] as const

export const LabelClaim = z.object({
  id: Id,
  scene: SceneId,
  /** The paragraph the quote is in. */
  p: z.number().int().min(0),
  record: Id,
  slot: Slot,
  value: z.string().min(1),
  quote: z.string().min(1),
  voice: z.enum(CLAIM_VOICES),
  /** The speaker or thinker for `dialogue` and `thought`. */
  speaker: Id.optional(),
  mode: z.enum(CLAIM_MODES),
  /** How a correct pipeline ends: proved in code, proved by the verifier, or not stored. */
  expect: z.enum(CLAIM_EXPECTS),
  reason: z.string().min(1)
})

export const LabelMentions = z.object({ scene: SceneId, records: z.array(Id).min(1) })

export const TWIN_RULES = ['alias', 'wordSubset', 'prefix', 'edit', 'dismissed'] as const

export const LabelTwinCase = z.object({
  name: z.string().min(1),
  outcome: z.enum(['blocked', 'new']),
  /** The record that blocks it, absent for `new` and for a Dismissed name. */
  blockedBy: Id.optional(),
  rule: z.enum(TWIN_RULES).optional(),
  reason: z.string().min(1)
})

export const KNOWS_HOW = [
  'saw',
  'told',
  'overheard',
  'read',
  'deduced',
  'suspects',
  'believesFalse',
  'knewBefore',
  'tells',
  'refers'
] as const

export const LabelKnows = z.object({
  secret: Id,
  learner: Id,
  how: z.enum(KNOWS_HOW),
  from: Id.nullable(),
  scene: SceneId,
  p: z.number().int().min(0),
  quote: z.string().min(1)
})

const QuoteRef = z.object({ scene: SceneId, p: z.number().int().min(0), quote: z.string().min(1) })

export const CONTRADICTION_RULES = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'] as const

export const LabelContradiction = z.object({
  rule: z.enum(CONTRADICTION_RULES),
  record: Id,
  a: QuoteRef,
  b: QuoteRef,
  reason: z.string().min(1)
})

export const LabelNegative = z.object({
  scene: SceneId,
  /** What must not come out of it: a stored claim, a finding, a new record, or a state change. */
  kind: z.enum(['claim', 'finding', 'record', 'state']),
  record: Id.optional(),
  slot: Slot.optional(),
  rule: z.enum(CONTRADICTION_RULES).optional(),
  reason: z.string().min(1)
})

export const TestBookLabels = z.object({
  records: z.array(LabelRecord).min(1),
  /** Names on the Dismissed list before reading (the twin gate blocks them silently). */
  dismissed: z.array(z.string().min(1)),
  claims: z.array(LabelClaim).min(1),
  mentions: z.array(LabelMentions),
  twinCases: z.array(LabelTwinCase).min(1),
  knows: z.array(LabelKnows).min(1),
  contradictions: z.array(LabelContradiction).min(1),
  negatives: z.array(LabelNegative).min(1)
})
export type TestBookLabels = z.input<typeof TestBookLabels>
