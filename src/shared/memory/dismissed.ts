import { z } from 'zod'
import { normName } from './names'

/**
 * One Dismissed list (F-16.10, answer 22): every "never bring this back" of story memory v2 in
 * one table the author can see and undo from, replacing about eight hidden lists of v1. A row is
 * a tombstone: undoing it deletes the row, so the thing may come back, and nothing else is
 * reversed (`dismissed:undo`).
 *
 * Kinds:
 * - `name`: a new name the author said is not a name ("Not a name"); the twin gate blocks it
 *   silently from then on.
 * - `alias`: a nickname she said is not that record ("No"), or an alias she removed.
 * - `notMention`: a phrase that is not a mention of a record ("Not a mention").
 * - `split`: two records she split apart; never proposed as the same again.
 * - `notSame`: two records she said are different (the switch-over's kept spellings).
 * - `unlink`: a plan link she removed.
 * - `notRight`, `notProblem`: written from P2a and P4 (a wrong line, a contradiction that is fine).
 */
export const DISMISSED_KINDS = [
  'name',
  'alias',
  'notMention',
  'split',
  'notSame',
  'unlink',
  'notRight',
  'notProblem'
] as const
export const DismissedKind = z.enum(DISMISSED_KINDS)
export type DismissedKind = z.infer<typeof DismissedKind>

/** What a key is made from, per kind. */
export type DismissedKeyInput =
  | { kind: 'name'; name: string }
  | { kind: 'alias'; recordId: string; alias: string }
  | { kind: 'notMention'; recordId: string; phrase: string }
  | { kind: 'split' | 'notSame'; a: string; b: string }
  | { kind: 'unlink'; planId: string; sceneId: string }
  | { kind: 'notRight' | 'notProblem'; ref: string }

/**
 * The one key shape per kind (unique per kind in the table): `name` → the name's norm; `alias`
 * → `recordId|norm`; `notMention` → `recordId|norm(the span with one word either side)`;
 * `split` and `notSame` → the two record ids in sorted order; `unlink` → `planId|sceneId`;
 * `notRight` and `notProblem` → the caller's reference.
 */
export function dismissedKey(input: DismissedKeyInput): string {
  switch (input.kind) {
    case 'name':
      return normName(input.name)
    case 'alias':
      return `${input.recordId}|${normName(input.alias)}`
    case 'notMention':
      return `${input.recordId}|${normName(input.phrase)}`
    case 'split':
    case 'notSame':
      return input.a < input.b ? `${input.a}|${input.b}` : `${input.b}|${input.a}`
    case 'unlink':
      return `${input.planId}|${input.sceneId}`
    case 'notRight':
    case 'notProblem':
      return input.ref
  }
}

/** The longest label and quote a row keeps (what the Dismissed list shows). */
export const DISMISSED_LABEL_MAX = 200
export const DISMISSED_QUOTE_MAX = 500

export const Dismissed = z.object({
  id: z.string(),
  kind: DismissedKind,
  key: z.string(),
  /** The record it is about, when there is one; the row goes with the record. */
  recordId: z.string().nullable(),
  /** The scene or document it is about, when there is one; cleared when that node goes. */
  nodeId: z.string().nullable(),
  /** What the list shows ("Hesk: not a name"). */
  label: z.string(),
  /** The words it was about, when there were some. */
  quote: z.string().nullable(),
  created: z.string()
})
export type Dismissed = z.infer<typeof Dismissed>

/** The list as `dismissed:list` answers it: newest first, with the total. */
export const DismissedList = z.object({ items: z.array(Dismissed), count: z.number().int() })
export type DismissedList = z.infer<typeof DismissedList>
