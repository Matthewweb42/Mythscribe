import { outputBudget } from '@shared/ai'
import { KNOWS_HOWS } from '@shared/memory/knows'
import type { AiMessage } from '../providers/types'
import {
  VERIFY_BASE_TOKENS,
  VERIFY_CHECK_TOKENS,
  VERIFY_CLAIM_TOKENS,
  VERIFY_SENTINEL,
  VERIFY_STRONG_TOKENS,
  VERIFY_UNNAMED_MARK,
  splitVerifyBatches
} from './verify.v1'

/**
 * The story-memory fact checker (F-16.17, F-16.22, F-16.23; design §2.3 step 4, §2.5; plan P2b
 * §2.3), version 2: `verify.v1` plus the items of who knows what and plot threads. Fast tier,
 * JSON, reasoning off, one batch per reading page. Besides v1's facts, card and on-page checks:
 *
 * - **Knows**: a learner candidates (`Who`), the people they may have had it from (`From`), the
 *   secret with its revealing sentence (`Secret`), the fact as the reader read it; the checker
 *   confirms the learner, how they know it and from whom, with voice and mode (36 tokens a verdict);
 * - **Step**: a thread with its opening sentence, the step and what happens; the checker confirms
 *   the step, with voice and mode (a hypothetical or a rumour never moves a thread, P2b-D22);
 * - **Reveals**: a new secret or thread (or a listed one whose reveal is re-checked) and the
 *   sentences that reveal or open it: ok when they do;
 * - **Same**: a new topic and an open one it may repeat, each with its revealing sentence
 *   ("same as s3?", P2b-D4): ok only when both are the same hidden fact or open question.
 *
 * The strong spot check is one item, three sentences either side, 40 tokens out (48 for a knows
 * item).
 */
export const VERIFY_V2_PROMPT_VERSION = 'verify.v2'

/** The same opening sentence as `verify.v1`: the e2e's fake provider recognises a check by it. */
export { VERIFY_SENTINEL, VERIFY_UNNAMED_MARK }

export const VERIFY_V2_RULES =
  `${VERIFY_SENTINEL} Each numbered item gives a fact and the sentences it came from. Decide ` +
  'from those sentences alone whether they state the fact, as written.\n' +
  '- "ok": true only when the sentences say it plainly of that record. A negation never ' +
  'supports. A wish, fear, dream, memory, lie or rumour supports a fact only with that voice and ' +
  'mode.\n' +
  '- "r": the id from "Who" the fact is about. When the subject is a pronoun ("she", "he", ' +
  '"they", "I") or a description, pick the one record it means; null when none fits or more ' +
  'than one could. A record marked "not named here" is the one only when the sentences point ' +
  'to it by a role ("his wife").\n' +
  '- "voice": narration, dialogue, thought or rumour, as the sentences give it. "mode": now, ' +
  'memory, hypothetical or dream.\n' +
  '- A knows item: ok only when the sentences show that record learning or holding that secret; ' +
  `"r" the learner from "Who"; "how" the way the text shows it, one of ${KNOWS_HOWS.join(', ')}; ` +
  '"fr" the id from "From" they had it from, or null.\n' +
  '- A thread item: ok when the sentences open, advance or resolve that thread; "how": opens, ' +
  'advances or resolves.\n' +
  '- A reveals item: ok when the sentences reveal that secret or set up that thread.\n' +
  '- A same item: ok only when both are the same hidden fact or open question, not merely ' +
  'related ones.\n' +
  '- A card, on-page, reveals or same item needs only "i" and "ok".\n' +
  'Reply with JSON only: {"v":[{"i":1,"ok":true,"r":"r12","voice":"narration","mode":"now"},' +
  '{"i":2,"ok":true,"r":"r7","how":"overheard","fr":"r2","voice":"narration","mode":"now"}]}'

/**
 * Output tokens per verdict: a knows verdict
 * (`{"i":4,"ok":true,"r":"r7","how":"overheard","fr":"r2","voice":"narration","mode":"now"},`)
 * about 36; a fact's or a thread step's 28 (`verify.v1`'s, a step answering `how` in place of `r`,
 * decided by Claude, unconfirmed); a reveals, same, card or on-page one 12. The strong spot check of
 * a knows line asks 48.
 */
export const VERIFY_KNOWS_TOKENS = 36
export const VERIFY_STRONG_KNOWS_TOKENS = 48

export const VERIFY_V2_ITEM_KINDS = [
  'claim',
  'knows',
  'step',
  'reveals',
  'same',
  'pov',
  'year',
  'flashback',
  'present'
] as const
export type VerifyV2ItemKind = (typeof VERIFY_V2_ITEM_KINDS)[number]

/** One item as the prompt shows it; the pipeline builds the lines. */
export interface VerifyV2Item {
  kind: VerifyV2ItemKind
  /**
   * The records it may be about, as roster lines ("r12 Mara Vell (Mara) · character"); for a
   * knows item the learner candidates. Empty for a step, reveals or same item.
   */
  who: readonly string[]
  /** A knows item's source candidates (roster lines). */
  from?: readonly string[]
  /**
   * A knows item's secret or a step's thread with its revealing sentence (`s3 the sold map: “…”`);
   * a reveals item's topic (`x1 the sold map · new secret`); a same item's pair
   * (`x1 the map sale: “…” (1.2) | s3 the sold map: “…” (1.1)`).
   */
  topic?: string
  /** The fact ("location: the quay (narration, now)", "knows, overheard from r2 (narration, now)"). */
  fact: string
  /** The sentences: the quote's ±1 (and the antecedent span), or ±3 for a strong spot check. */
  text: string
}

export interface BuildVerifyV2PromptInput {
  items: readonly VerifyV2Item[]
  /** The strong-tier spot check: one item, 40 tokens out (48 for a knows line). */
  strong?: boolean
}

export interface BuiltVerifyV2Prompt {
  version: typeof VERIFY_V2_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** The output tokens one item's verdict needs. */
export function verifyV2ItemOutput(item: Pick<VerifyV2Item, 'kind'>): number {
  switch (item.kind) {
    case 'knows':
      return VERIFY_KNOWS_TOKENS
    case 'claim':
    case 'step':
      return VERIFY_CLAIM_TOKENS
    default:
      return VERIFY_CHECK_TOKENS
  }
}

/** The `max_tokens` of a batch of `items` (a strong spot check: 40, or 48 for a knows line). */
export function verifyV2MaxTokens(
  items: readonly Pick<VerifyV2Item, 'kind'>[],
  strong = false
): number {
  if (strong) return items[0]?.kind === 'knows' ? VERIFY_STRONG_KNOWS_TOKENS : VERIFY_STRONG_TOKENS
  const wanted = items.reduce((sum, item) => sum + verifyV2ItemOutput(item), VERIFY_BASE_TOKENS)
  return Math.min(outputBudget('verify'), wanted)
}

const whoLine = (who: readonly string[]): string =>
  who.length === 0 ? '(no record)' : who.join(' | ')

/** One item as its lines in the user turn, numbered from 1. */
export function verifyV2ItemText(item: VerifyV2Item, n: number): string {
  switch (item.kind) {
    case 'claim':
      return [`${n}. Who: ${whoLine(item.who)}`, `Fact: ${item.fact}`, `Text: ${item.text}`].join(
        '\n'
      )
    case 'knows':
      return [
        `${n}. Who: ${whoLine(item.who)}`,
        `From: ${item.from === undefined || item.from.length === 0 ? '(no one named)' : item.from.join(' | ')}`,
        `Secret: ${item.topic ?? ''}`,
        `Fact: ${item.fact}`,
        `Text: ${item.text}`
      ].join('\n')
    case 'step':
      return [`${n}. Thread: ${item.topic ?? ''}`, `Fact: ${item.fact}`, `Text: ${item.text}`].join(
        '\n'
      )
    case 'reveals':
      return [`${n}. Reveals: ${item.topic ?? ''}`, `Text: ${item.text}`].join('\n')
    case 'same':
      return `${n}. Same: ${item.topic ?? ''}`
    case 'present':
      return [
        `${n}. Who: ${whoLine(item.who)}`,
        `On the page: ${item.fact}`,
        `Text: ${item.text}`
      ].join('\n')
    case 'pov':
    case 'year':
    case 'flashback': {
      const label = item.kind === 'flashback' ? 'flashback' : item.kind === 'pov' ? 'POV' : 'year'
      return [
        `${n}. Who: ${whoLine(item.who)}`,
        `Card ${label}: ${item.fact}`,
        `Text: ${item.text}`
      ].join('\n')
    }
  }
}

/**
 * Splits items into batches, in order (`verify.v1`'s rule): at most 2,500 tokens of item text, and
 * no more verdicts than the output budget holds.
 */
export function verifyV2Batches<T extends VerifyV2Item>(items: readonly T[]): T[][] {
  return splitVerifyBatches(items, verifyV2ItemText, verifyV2ItemOutput)
}

export function buildVerifyV2Prompt(input: BuildVerifyV2PromptInput): BuiltVerifyV2Prompt {
  const strong = input.strong === true
  const items = strong ? input.items.slice(0, 1) : input.items
  return {
    version: VERIFY_V2_PROMPT_VERSION,
    messages: [
      { role: 'system', content: VERIFY_V2_RULES },
      {
        role: 'user',
        content: `Items:\n${items.map((item, i) => verifyV2ItemText(item, i + 1)).join('\n\n')}`
      }
    ],
    maxTokens: verifyV2MaxTokens(items, strong)
  }
}
