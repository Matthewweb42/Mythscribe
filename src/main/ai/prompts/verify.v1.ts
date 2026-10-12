import { estimateTokens, outputBudget } from '@shared/ai'
import type { AiMessage } from '../providers/types'

/**
 * The story-memory fact checker (F-16.17; design §2.3 step 4, plan P2a §2.3), version 1: fast
 * tier, JSON, reasoning off. One batch per reading page: each numbered item is one fact the reader
 * proposed that code could not prove (with the records it may be about, and its sentences ±1, plus
 * the sentences back to the one that names whoever a pronoun points to), or a card check (the
 * POV, the year, a flashback) or an on-page check, never the whole scene. A fact is stored only
 * when the checker supports it with its subject, voice and mode, which win over the reader's.
 *
 * The strong spot check (P2a-D8, slice 3) is the same version with one item, three sentences
 * either side, on the strong tier, at 40 tokens out.
 */
export const VERIFY_PROMPT_VERSION = 'verify.v1'

/** The opening sentence: the e2e's fake provider recognises a check request by it. */
export const VERIFY_SENTINEL = 'You are the fact checker inside a novel-writing app.'

export const VERIFY_RULES =
  `${VERIFY_SENTINEL} Each numbered item gives a fact and the sentences it came from. Decide ` +
  'from those sentences alone whether they state the fact about that record, as written.\n' +
  '- "ok": true only when the sentences say it plainly of that record. A negation never ' +
  'supports. A wish, fear, dream, memory, lie or rumour supports a fact only with that voice and ' +
  'mode.\n' +
  '- "r": the id from "Who" the fact is about. When the subject is a pronoun ("she", "he", ' +
  '"they", "I") or a description, pick the one record it means; null when none fits or more ' +
  'than one could. A record marked "not named here" is the one only when the sentences point ' +
  'to it by a role ("his wife").\n' +
  '- "voice": narration, dialogue, thought or rumour, as the sentences give it. "mode": now, ' +
  'memory, hypothetical or dream.\n' +
  '- A card or on-page item needs only "i" and "ok".\n' +
  'Reply with JSON only: {"v":[{"i":1,"ok":true,"r":"r12","voice":"narration","mode":"now"}]}'

/** Most tokens of items in one batch before it is split (plan P2a §2.3). */
export const VERIFY_BATCH_TOKENS = 2_500
/**
 * A batch's `max_tokens`: min(400, 20 + 28 per fact + 12 per card or on-page item). A fact's
 * verdict (`{"i":12,"ok":true,"r":"r12","voice":"narration","mode":"now"},`) is about 23 tokens
 * in a real tokenizer, more with spaces; a card or on-page one (`{"i":3,"ok":true},`) about 9.
 * A batch is also split so its verdicts fit the 400 (about 13 facts). A strong spot check asks 40.
 */
export const VERIFY_BASE_TOKENS = 20
export const VERIFY_CLAIM_TOKENS = 28
export const VERIFY_CHECK_TOKENS = 12
export const VERIFY_STRONG_TOKENS = 40
/** The Who line's mark on a record nothing in reach names (a role the text gives, "his wife"). */
export const VERIFY_UNNAMED_MARK = ' · not named here'

export const VERIFY_ITEM_KINDS = ['claim', 'pov', 'year', 'flashback', 'present'] as const
export type VerifyItemKind = (typeof VERIFY_ITEM_KINDS)[number]

/** One item as the prompt shows it; the pipeline builds the lines. */
export interface VerifyPromptItem {
  kind: VerifyItemKind
  /**
   * The records it may be about, as roster lines ("r12 Mara Vell (Mara) · character"); one that
   * nothing in reach names carries `VERIFY_UNNAMED_MARK`.
   */
  who: readonly string[]
  /** The fact ("location: the quay (narration, now)", "the point of view is r12's"). */
  fact: string
  /** The sentences: the quote's ±1 (and the antecedent span), or ±3 for a strong spot check. */
  text: string
}

export interface BuildVerifyPromptInput {
  items: readonly VerifyPromptItem[]
  /** The strong-tier spot check: one claim, 40 tokens out. */
  strong?: boolean
}

export interface BuiltVerifyPrompt {
  version: typeof VERIFY_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** The output tokens one item's verdict needs. */
export const verifyItemOutput = (item: Pick<VerifyPromptItem, 'kind'>): number =>
  item.kind === 'claim' ? VERIFY_CLAIM_TOKENS : VERIFY_CHECK_TOKENS

/** The `max_tokens` of a batch of `items` (the strong spot check's own cap aside). */
export function verifyMaxTokens(
  items: readonly Pick<VerifyPromptItem, 'kind'>[],
  strong = false
): number {
  if (strong) return VERIFY_STRONG_TOKENS
  const wanted = items.reduce((sum, item) => sum + verifyItemOutput(item), VERIFY_BASE_TOKENS)
  return Math.min(outputBudget('verify'), wanted)
}

/** One item as its lines in the user turn, numbered from 1. */
export function verifyItemText(item: VerifyPromptItem, n: number): string {
  const label =
    item.kind === 'claim'
      ? 'Fact'
      : item.kind === 'present'
        ? 'On the page'
        : `Card ${item.kind === 'flashback' ? 'flashback' : item.kind === 'pov' ? 'POV' : 'year'}`
  return [
    `${n}. Who: ${item.who.length === 0 ? '(no record)' : item.who.join(' | ')}`,
    `${label}: ${item.fact}`,
    `Text: ${item.text}`
  ].join('\n')
}

/**
 * Splits items into batches, in order: at most `VERIFY_BATCH_TOKENS` tokens of item text, and no
 * more verdicts than the output budget holds (so a reply is not cut off at its cap).
 */
export function verifyBatches<T extends VerifyPromptItem>(items: readonly T[]): T[][] {
  const batches: T[][] = []
  const most = outputBudget('verify')
  let current: T[] = []
  let used = 0
  let out = VERIFY_BASE_TOKENS
  for (const item of items) {
    const cost = estimateTokens(verifyItemText(item, current.length + 1))
    const answer = verifyItemOutput(item)
    if (current.length > 0 && (used + cost > VERIFY_BATCH_TOKENS || out + answer > most)) {
      batches.push(current)
      current = []
      used = 0
      out = VERIFY_BASE_TOKENS
    }
    current.push(item)
    used += cost
    out += answer
  }
  if (current.length > 0) batches.push(current)
  return batches
}

export function buildVerifyPrompt(input: BuildVerifyPromptInput): BuiltVerifyPrompt {
  const strong = input.strong === true
  const items = strong ? input.items.slice(0, 1) : input.items
  return {
    version: VERIFY_PROMPT_VERSION,
    messages: [
      { role: 'system', content: VERIFY_RULES },
      {
        role: 'user',
        content: `Items:\n${items.map((item, i) => verifyItemText(item, i + 1)).join('\n\n')}`
      }
    ],
    maxTokens: verifyMaxTokens(items, strong)
  }
}
