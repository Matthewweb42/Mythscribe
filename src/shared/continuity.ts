import { z } from 'zod'
import { EntityKind } from './entities'

/**
 * The consistency checker (F-13.4): what a scene states against the story bible. A finding is one
 * passage of the scene that contradicts one **reference** main built itself and numbered in the
 * prompt (a field of the author's entity sheet, an observed fact of another scene with its
 * passage, or the previous scene's timeline), so both citations are exact: the scene's quote is
 * located in the text that was sent, and the other side is never the model's own words. The
 * feature id is `continuity` (the voice consistency report of F-14.7 already owns the other
 * word). This file owns the limits and the shapes the prompt, the store, the contract, and the
 * panel share.
 */

/** Characters of scene text a document needs before it can be checked on demand. */
export const CONTINUITY_TEXT_MIN = 200
/** On demand the scene is head-truncated to this many characters (~5,000 tokens) before it is sent. */
export const CONTINUITY_SCENE_CHAR_BUDGET = 20_000
/** Findings per run, after the uncited ones are dropped. */
export const CONTINUITY_MAX_FINDINGS = 6
export const CONTINUITY_QUOTE_MAX = 240
export const CONTINUITY_WHY_MAX = 300
export const CONTINUITY_FIX_MAX = 600
/** The estimated-token room the numbered references get in one prompt; facts are dropped first, sheets last. */
export const CONTINUITY_REFS_TOKEN_BUDGET = 1_500
/** Longest value of one reference as sent and stored; a longer sheet field is cut with "…". */
export const CONTINUITY_REF_VALUE_MAX = 200

/**
 * Where the other citation comes from, in the order the author's word outranks the AI's:
 * `sheet` (a field of the entity's own sheet), `fact` (an observed fact, F-5.16, read from
 * another scene), `timeline` (the previous scene's timeline metadata).
 */
export const CONTINUITY_REF_KINDS = ['sheet', 'fact', 'timeline'] as const
export const ContinuityRefKind = z.enum(CONTINUITY_REF_KINDS)
export type ContinuityRefKind = z.infer<typeof ContinuityRefKind>

/** The second citation of a finding, as it was when the check ran. */
export const ContinuityRef = z.object({
  kind: ContinuityRefKind,
  /** The entity the reference is about; null for `timeline`, or once the entity was deleted. */
  entityId: z.string().nullable(),
  entityName: z.string().nullable(),
  entityKind: EntityKind.nullable(),
  /** The sheet field or fact attribute id; null for `timeline`. */
  attribute: z.string().nullable(),
  /** What the panel prints before the value: the field's label, or `Timeline`. */
  label: z.string(),
  value: z.string(),
  /** The scene the reference was read from (`fact`, `timeline`); null for `sheet`, or once that scene was deleted. */
  nodeId: z.string().nullable(),
  /** The passage of that scene (`fact`); null otherwise. */
  quote: z.string().nullable()
})
export type ContinuityRef = z.infer<typeof ContinuityRef>

/**
 * `open`: waiting for the author; `dismissed`: "changed in the story", kept as a tombstone so the
 * same contradiction is not raised again for that scene; `applied`: its fix is in the text.
 */
export const CONTINUITY_STATUSES = ['open', 'dismissed', 'applied'] as const
export const ContinuityStatus = z.enum(CONTINUITY_STATUSES)
export type ContinuityStatus = z.infer<typeof ContinuityStatus>

/** Which path found it: the quiet background run after a scene's facts, or `Check consistency`. */
export const CONTINUITY_ORIGINS = ['background', 'request'] as const
export const ContinuityOrigin = z.enum(CONTINUITY_ORIGINS)
export type ContinuityOrigin = z.infer<typeof ContinuityOrigin>

/**
 * One contradiction as the renderer receives it: `quote` is a passage main located in the scene
 * text it sent, `ref` is the reference it contradicts, `fix` replaces `quote` only (null when the
 * model offered none) and is scored by the fidelity check (F-14.7). Applying the fix goes through
 * `proposalId` (F-14.5), so the text carries provenance (F-14.6).
 */
export const ContinuityFinding = z.object({
  id: z.string(),
  nodeId: z.string(),
  ref: ContinuityRef,
  quote: z.string().min(1).max(CONTINUITY_QUOTE_MAX),
  why: z.string().min(1).max(CONTINUITY_WHY_MAX),
  fix: z.string().min(1).max(CONTINUITY_FIX_MAX).nullable(),
  flagged: z.boolean(),
  violation: z.string().nullable(),
  status: ContinuityStatus,
  origin: ContinuityOrigin,
  proposalId: z.string().nullable(),
  createdAt: z.string()
})
export type ContinuityFinding = z.infer<typeof ContinuityFinding>

/**
 * What a dismissal remembers: the scene, the entity (or none for the timeline), the attribute,
 * and the reference's value, case and spacing folded. A later run that finds the same
 * contradiction in that scene is dropped; another scene contradicting the same reference is new.
 */
export function continuityDedupeKey(nodeId: string, ref: ContinuityRef): string {
  const value = ref.value.toLowerCase().replace(/\s+/gu, ' ').trim()
  return [nodeId, ref.kind, ref.entityId ?? '', ref.attribute ?? '', value].join('\u001f')
}
