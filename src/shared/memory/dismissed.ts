import { z } from 'zod'
import { sentenceHash } from './anchor'
import { valueKey, type CardFieldName } from './claims'
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
 * - `notRight` (F-16.18): an AI line the author said is wrong (*Not right › Wrong value*), keyed by
 *   the record, slot, value and the quote's own sentences (their gate texts, every name as one
 *   placeholder), so a new sentence stating the same value is new evidence and comes back, while
 *   an edit beside it, Rename in book or *Same as…* leaves the dismissal standing (answer 22). A
 *   line whose quote is no longer in its scene (a stale line) is keyed by its stored anchor
 *   instead: no new sentence can match it, but the row is there to undo. A card's value (its POV,
 *   place, time or year, or a character on the page) the author said is not right is keyed by
 *   the scene, the field and the value: the views and the conflicts then leave it out. P2b: a
 *   knows line uses the slot `knows:<secretId>` with its how as the value (P2b-D6), a thread step
 *   `thread:<threadId>` with its step; an AI-made secret or thread the author said is not one is
 *   keyed by its kind and its reveal's sentences (`topic|kind|…`, P2b-D13).
 * - `notProblem`: a conflict that is fine: a filed line's (F-16.9, by the caller's `ref`), the
 *   typed-detail conflict's *Keep mine* (decision 4, F-16.18: `detail`), and P4's findings.
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
  | {
      kind: 'notRight'
      recordId: string
      slot: string
      value: string
      /** The gate texts (`gateText`) of the quote's own sentences, in order. */
      stating: readonly string[]
    }
  | {
      kind: 'notRight'
      recordId: string
      slot: string
      value: string
      /** A stale line's stored anchor (its quote is no longer in the scene). */
      anchor: readonly string[]
    }
  | {
      kind: 'notRight'
      /** A card's value: for `pov` and `present`, the value is the record's id. */
      card: { nodeId: string; field: CardEntryName; value: string }
    }
  | {
      kind: 'notRight'
      /**
       * An AI-made secret or thread the author said is not one (*Not a secret*, *Not a thread*;
       * P2b-D13), by the gate texts of its reveal's sentences, so the same sentences never make it
       * again while a new reveal elsewhere may.
       */
      topic: { kind: 'secret' | 'thread'; stating: readonly string[] }
    }
  | { kind: 'notProblem'; ref: string }
  | { kind: 'notProblem'; detail: { nodeId: string; field: string; value: string } }

/** A card entry *Not right* may dismiss: one of its fields, or a character on the page. */
export type CardEntryName = CardFieldName | 'present'

/** Whether a card entry's value is a record's id (the POV, a character on the page). */
export const cardEntryIsRecord = (field: CardEntryName): boolean =>
  field === 'pov' || field === 'present'

/**
 * The evidence part of a `notRight` key: one hash over the quote's sentences as the gate reads
 * them, with each name's record token (`⟨r1|r2⟩`) folded to one placeholder, so a rename or a
 * merge of records never moves it (the key's record says whose line it was).
 */
export function statingKey(stating: readonly string[]): string {
  return sentenceHash(stating.map((gate) => gate.replace(/⟨[^⟩]*⟩/gu, '⟨⟩')).join(' '))
}

/**
 * The one key shape per kind (unique per kind in the table): `name` → the name's norm; `alias`
 * → `recordId|norm`; `notMention` → `recordId|norm(the span with one word either side)`;
 * `split` and `notSame` → the two record ids in sorted order; `unlink` → `planId|sceneId`;
 * `notRight` → `recordId|slot|valueKey|statingKey` (a stale line: `recordId|slot|valueKey|a` and
 * its anchor's hash; a card's record value: `recordId|card|nodeId|field`, so a merge re-keys it;
 * another card value: `card|nodeId|field|valueKey`; an AI-made topic the author said is not one:
 * `topic|kind|statingKey`; a knows line keys by its learner with the slot `knows:<secretId>` and its
 * how as the value, so a merge of either record re-keys it); `notProblem` → the caller's reference, or for
 * a typed detail `detail|nodeId|field|valueKey` (the text's value the author kept hers against; for
 * a POV, the text's record id, so a rename never asks again).
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
      if ('topic' in input) return `topic|${input.topic.kind}|${statingKey(input.topic.stating)}`
      if ('card' in input) {
        const { nodeId, field, value } = input.card
        return cardEntryIsRecord(field)
          ? `${value}|card|${nodeId}|${field}`
          : `card|${nodeId}|${field}|${valueKey(value)}`
      }
      if ('anchor' in input) {
        return `${input.recordId}|${input.slot}|${valueKey(input.value)}|a${sentenceHash(input.anchor.join(' '))}`
      }
      return `${input.recordId}|${input.slot}|${valueKey(input.value)}|${statingKey(input.stating)}`
    case 'notProblem':
      if ('ref' in input) return input.ref
      return `detail|${input.detail.nodeId}|${input.detail.field}|${valueKey(input.detail.value)}`
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
