import { z } from 'zod'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import type { ClaimMode, ClaimVoice } from '@shared/memory/claims'
import { JudgeVerdict } from '@shared/memory/findings'
import { salvageJsonItems, unfence } from '@shared/memory/readerAnswer'
import { clipAtWord } from '@shared/textClip'
import type { AiMessage } from '../providers/types'
import { clipAround } from './cite.v1'

/**
 * The contradiction judge (F-16.27; plan P4 §2.2, design §2.4), version 1: fast tier, JSON,
 * reasoning off. Code found each pair under rules C1–C7 (`candidates.ts`); the judge only rules
 * whether both passages can be true at their places in the story. A batch of at most 10 pairs is
 * sent twice, as two separate requests: once with every pair as found (A, B) and once with every
 * pair's passages swapped (B, A), the question unchanged, so the second verdict is not the first
 * one echoed (P4-D11). Only two `c` verdicts make a finding (P4-D10). The stronger check of *Check
 * the book* (F-16.30, slice 3) is this version's confirm render: one pair at ±3 sentences on the
 * strong tier, its verdict with up to 20 words of reason.
 *
 * Nothing here states an absence (P4 rule 5): every question names what the two passages say, never
 * that something did not happen or that someone does not know.
 *
 * Order (token rule 3): the rules, identical for every batch (cached); then one user turn, "Pairs:"
 * and the numbered items.
 */
export const JUDGE_PROMPT_VERSION = 'judge.v1'

/** The opening sentence; the e2e's fake provider keys on it. */
export const JUDGE_SENTINEL = 'You are the contradiction judge inside a novel-writing app.'

/** The rules both renders share (the golden holds each system message at 450 tokens or under). */
const JUDGE_RULES_CORE =
  `${JUDGE_SENTINEL} Each numbered item is a pair of passages, A and B, from one novel or from ` +
  "the author's notes, with what the app found that may not fit. Decide whether both can be true " +
  'in the story as written:\n' +
  '- "c": they cannot both be true at their places in the story.\n' +
  '- "ok": both can be true: a change the story shows or allows over the time between them, a ' +
  'different person or thing, a figure of speech, a character lying, guessing or mistaken, a ' +
  'rumour, a memory, a dream, a hypothetical.\n' +
  '- "u": these words do not settle it.\n' +
  '- Reading order is story order, except in a flashback or a remembered moment.\n' +
  "- Notes are the author's timeless canon: they describe the whole story and may describe the " +
  'future, so a note about what happens later is not contradicted by an earlier scene. A fixed ' +
  'fact in a note (eyes, birth, family) must match the book.\n' +
  "- Narration states what is true in the story; a character's speech, thought or rumour may be " +
  'wrong, but only where the passage shows it.\n' +
  '- Judge only from the words given.\n'

/** The batch's rules: one verdict per item. */
export const JUDGE_RULES =
  JUDGE_RULES_CORE +
  'Reply with JSON only: {"v":[{"i":1,"r":"c","w":"grey eyes against brown"}]}: one entry per ' +
  'item, in order; "w" (at most 8 words) only with "c".'

/** The stronger check's rules (*Check the book*): one pair, a reason for every verdict. */
export const JUDGE_CONFIRM_RULES =
  JUDGE_RULES_CORE +
  'Reply with JSON only: {"r":"c","w":"grey eyes in one passage, brown in the other"}: "w" (at most ' +
  '20 words) with every verdict.'

/** The most pairs one call carries, and the tokens of pairs (the rest of the 3,000 is the rules'). */
export const JUDGE_PAIRS_MAX = 10
export const JUDGE_ITEMS_TOKENS = 2_500
/** One item's tokens at most: its contexts are cut shorter until it fits (`JUDGE_CONTEXT_CHARS`). */
export const JUDGE_ITEM_TOKENS = 260
/** A side's context caps, tried in order until the item fits (the last always does). */
export const JUDGE_CONTEXT_CHARS = [450, 360, 280, 200, 160] as const
/** The question, a side's value and place, and a between-hint, cut to these many characters. */
export const JUDGE_QUESTION_CHARS = 200
export const JUDGE_SAYS_CHARS = 60
export const JUDGE_PLACE_CHARS = 48
export const JUDGE_HINT_CHARS = 70
/** At most two time-skip sentences between the two scenes. */
export const JUDGE_HINTS_MAX = 2
/** The judge's reason with a `c`, in words; the stronger check's, with every verdict. */
export const JUDGE_WHY_WORDS = 8
export const JUDGE_CONFIRM_WHY_WORDS = 20
/** The stronger check: one pair at ±3 sentences, each side cut to 1,200 characters around its quote. */
export const JUDGE_CONFIRM_CHARS = 1_200
export const JUDGE_CONFIRM_INPUT_TOKENS = 1_000
export const JUDGE_CONFIRM_MAX_TOKENS = 90
/** Output per batch: 20, then 26 a pair (P4 §2.2). */
export const JUDGE_BASE_TOKENS = 20
export const JUDGE_PAIR_TOKENS = 26

/** `max_tokens` of a batch: min(300, 20 + 26 per pair). */
export function judgeMaxTokens(pairs: number): number {
  return Math.min(outputBudget('judge'), JUDGE_BASE_TOKENS + JUDGE_PAIR_TOKENS * pairs)
}

/**
 * What the app found, by rule, as the item's question: order-neutral, so the swapped call reads
 * true, and positive (it names what each passage says, never an absence). C2's body question does
 * not say that no change is shown (P4 slice 2 review): code only infers that from a change claim
 * the reader did not find, and the rules already tell the judge to allow a change the story shows
 * or allows over the time between.
 */
export type JudgeQuestion =
  | { rule: 'C1' | 'C7'; name: string; slot: string }
  | { rule: 'C2'; variant: 'dead'; name: string }
  | { rule: 'C2'; variant: 'body'; name: string; slot: string }
  | { rule: 'C3'; name: string; secret: string }
  | {
      rule: 'C4'
      variant: 'birth'
      name: string
      age: string
      born: string
      year: number
      source: 'typed' | 'quoted'
    }
  | { rule: 'C4'; variant: 'falls'; name: string }
  | { rule: 'C5'; thread: string }
  | { rule: 'C6'; name: string; slot: string }

/** A name as its possessive ("Mara's", "Hobbs'"). */
const possessive = (name: string): string => (/s$/iu.test(name) ? `${name}’` : `${name}’s`)

/** The item's question, by rule (plan P4 §2.2's wording). */
export function judgeQuestion(question: JudgeQuestion): string {
  switch (question.rule) {
    case 'C1':
    case 'C7':
      return `${question.name} · ${question.slot}. Can both be true?`
    case 'C2':
      return question.variant === 'dead'
        ? `One passage has ${question.name} die; the other has ${question.name} present. Can both be true?`
        : `${possessive(question.name)} ${question.slot} differs between these two appearances. Can both be true?`
    case 'C3':
      return `In one passage ${question.name} passes on ${question.secret}; in the other ${question.name} learns it. Can both be true?`
    case 'C4':
      return question.variant === 'birth'
        ? `${question.name}: stated age ${question.age}; born ${question.born}; the story year of the scene with the age is ${question.year} (${question.source === 'typed' ? 'typed by the author' : 'stated in that scene'}). Can both be true?`
        : `${possessive(question.name)} stated age falls from the earlier passage to the later one. Can both be true?`
    case 'C5':
      return `One passage resolves ${question.thread} (a plot thread); the other, later, advances it. Can both be true?`
    case 'C6':
      return `One passage is the book, the other the author's note. Can both be true of ${possessive(question.name)} ${question.slot}?`
  }
}

/** Where a side stands in reading order: a book passage's scene and paragraph, or none for a note. */
export interface JudgeAt {
  /** The scene's place in reading order. */
  order: number
  para: number
}

/** One side of a pair as the judge reads it. */
export interface JudgeSide {
  /** Where it is: a book passage's reference ("1.2 ¶3"), or a note's place ("Orrin's Pinned page"). */
  place: string
  /** Null for a note. */
  at: JudgeAt | null
  /** What this side says, as code read it: the value ("grey"), "here", "learns it (overheard)". */
  says: string
  /** The claim's voice and mode; null for a presence or a note. */
  voice: ClaimVoice | null
  mode: ClaimMode | null
  /**
   * The scene is a flashback (`sceneFlashback`: the author's Flashback switch when set, else the
   * card's checked reading). A doc comment only: the prompt text is unchanged.
   */
  flashback: boolean
  /** The scene's story year as typed or stated there (never carried); null for none or a note. */
  year: number | null
  /** The quote, as stored. */
  quote: string
  /** Its context: the quote's sentence ±1 (±3 for the stronger check), within its paragraph. */
  text: string
}

export interface JudgePair {
  question: JudgeQuestion
  a: JudgeSide
  b: JudgeSide
  /** Time-skip sentences between the two scenes ("Three winters later"), at most two. */
  between: readonly string[]
}

/** The two orders a pair is judged in: as found, and swapped. */
export type JudgeOrder = 'ab' | 'ba'

/** A side's relative order against the other (earlier, later, same scene…, note). */
function relative(side: JudgeSide, other: JudgeSide): string {
  if (side.at === null) return 'note'
  if (other.at === null) return 'book'
  if (side.at.order !== other.at.order) return side.at.order < other.at.order ? 'earlier' : 'later'
  if (side.at.para === other.at.para) return 'same paragraph'
  return side.at.para < other.at.para ? 'same scene, earlier' : 'same scene, later'
}

/**
 * One side's line: its label, `[place · relative order · voice, mode · flashback · story year]`,
 * what it says, then its text cut around the quote. `masked` drops the place (scene and paragraph
 * numbers move with a scene move; the verdict must not, plan P4 §2.3).
 */
function sideLine(
  label: 'A' | 'B',
  side: JudgeSide,
  other: JudgeSide,
  chars: number,
  masked: boolean
): string {
  const parts = [
    masked && side.at !== null ? '#' : clipAtWord(side.place, JUDGE_PLACE_CHARS),
    relative(side, other)
  ]
  if (side.at !== null) {
    parts.push(side.voice === null ? 'on the page' : `${side.voice}, ${side.mode ?? 'now'}`)
    if (side.flashback) parts.push('flashback')
    if (side.year !== null) parts.push(`story year ${side.year}`)
  }
  return `${label} [${parts.join(' · ')}] says ${clipAtWord(side.says, JUDGE_SAYS_CHARS)}: ${clipAround(side.text, side.quote, chars)}`
}

/**
 * One numbered item in `order`: the question, the two sides (swapped for `ba`: the passages and
 * their labels change places, the question does not), then the time-skip hints. Its contexts are
 * cut to `chars`. `masked` renders it as the verdict cache keys it (no number, no scene place).
 */
export function judgeItemText(
  pair: JudgePair,
  n: number,
  order: JudgeOrder,
  chars: number = JUDGE_CONTEXT_CHARS[0],
  masked = false
): string {
  const [first, second] = order === 'ab' ? [pair.a, pair.b] : [pair.b, pair.a]
  const hints = pair.between
    .slice(0, JUDGE_HINTS_MAX)
    .map((hint) => `“${clipAtWord(hint, JUDGE_HINT_CHARS)}”`)
  return [
    `${masked ? 0 : n}. ${clipAtWord(judgeQuestion(pair.question), JUDGE_QUESTION_CHARS)}`,
    sideLine('A', first, second, chars, masked),
    sideLine('B', second, first, chars, masked),
    ...(hints.length === 0 ? [] : [`Between: ${hints.join('; ')}`])
  ].join('\n')
}

/**
 * What a book side's place and the item's number may add to the masked rendering: the item's fit
 * is measured on the masked text plus this, so the context cap never depends on scene numbers (a
 * scene move keeps the same words, and the same verdict key).
 */
const PLACE_ALLOWANCE_TOKENS = estimateTokens(' '.repeat(2 * JUDGE_PLACE_CHARS + 2))

/**
 * One item as it is sent and as its verdict is cached: the pair and the context cap it fits its
 * token budget at (the first of `JUDGE_CONTEXT_CHARS`, the last always standing), the same in both
 * orders, so both calls see the same words.
 */
export interface JudgeItem {
  pair: JudgePair
  chars: number
}

export function judgeItem(pair: JudgePair): JudgeItem {
  const fits = (chars: number): boolean =>
    estimateTokens(judgeItemText(pair, 0, 'ab', chars, true)) + PLACE_ALLOWANCE_TOKENS <=
    JUDGE_ITEM_TOKENS
  const chars =
    JUDGE_CONTEXT_CHARS.find(fits) ?? JUDGE_CONTEXT_CHARS[JUDGE_CONTEXT_CHARS.length - 1] ?? 160
  return { pair, chars }
}

/** An item's text as the verdict cache keys it in `order` (no number, no scene place). */
export const judgeItemKeyText = (item: JudgeItem, order: JudgeOrder): string =>
  judgeItemText(item.pair, 0, order, item.chars, true)

/** The tokens an item takes in a batch (numbered 10, the widest). */
export const judgeItemTokens = (item: JudgeItem): number =>
  estimateTokens(`${judgeItemText(item.pair, JUDGE_PAIRS_MAX, 'ab', item.chars)}\n\n`)

/**
 * Splits items into batches of at most `JUDGE_PAIRS_MAX` pairs and `JUDGE_ITEMS_TOKENS` tokens of
 * pairs, in the order given.
 */
export function judgeBatches<T extends { item: JudgeItem }>(items: readonly T[]): T[][] {
  const batches: T[][] = []
  let batch: T[] = []
  let used = 0
  for (const each of items) {
    const cost = judgeItemTokens(each.item)
    if (batch.length > 0 && (batch.length >= JUDGE_PAIRS_MAX || used + cost > JUDGE_ITEMS_TOKENS)) {
      batches.push(batch)
      batch = []
      used = 0
    }
    batch.push(each)
    used += cost
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

export interface BuiltJudgePrompt {
  version: typeof JUDGE_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
  order: JudgeOrder
  /** How many items were sent (the first ones of the batch; the cap holds the rest back). */
  sent: number
}

/**
 * One call of a batch: the rules, then "Pairs:" and the items numbered from 1 in `order`. Items
 * past `JUDGE_PAIRS_MAX` or the input cap are left out (`sent` says how many went).
 */
export function buildJudgePrompt(items: readonly JudgeItem[], order: JudgeOrder): BuiltJudgePrompt {
  const room = Math.min(
    JUDGE_ITEMS_TOKENS,
    inputBudget('judge') - estimateTokens(`${JUDGE_RULES}\nPairs:\n`)
  )
  const parts: string[] = []
  let used = 0
  for (const item of items.slice(0, JUDGE_PAIRS_MAX)) {
    const text = judgeItemText(item.pair, parts.length + 1, order, item.chars)
    const cost = estimateTokens(`${text}\n\n`)
    if (parts.length > 0 && used + cost > room) break
    parts.push(text)
    used += cost
  }
  return {
    version: JUDGE_PROMPT_VERSION,
    messages: [
      { role: 'system', content: JUDGE_RULES },
      { role: 'user', content: `Pairs:\n${parts.join('\n\n')}` }
    ],
    maxTokens: judgeMaxTokens(parts.length),
    order,
    sent: parts.length
  }
}

/** The stronger check's context caps, tried in order until the call fits. */
const JUDGE_CONFIRM_CAPS = [JUDGE_CONFIRM_CHARS, 900, 600, 450] as const

/**
 * The context cap the stronger check's call of `pair` is sent at (the first of
 * `JUDGE_CONFIRM_CAPS` that fits `JUDGE_CONFIRM_INPUT_TOKENS`): what its remembered verdict is
 * keyed by too (F-16.30, P4 slice 3).
 */
export function judgeConfirmChars(pair: JudgePair, order: JudgeOrder = 'ab'): number {
  const fits = (chars: number): boolean =>
    estimateTokens(
      `${JUDGE_CONFIRM_RULES}\nPair:\n${judgeItemText(pair, 1, order, chars)}`
    ) <= JUDGE_CONFIRM_INPUT_TOKENS
  return JUDGE_CONFIRM_CAPS.find(fits) ?? 450
}

/**
 * The stronger check's call (*Check the book*, F-16.30): one pair, its sides' contexts (±3
 * sentences, as main gives them) cut to 1,200 characters around their quotes, shorter until the
 * call fits `JUDGE_CONFIRM_INPUT_TOKENS`; `max_tokens` 90.
 */
export function buildJudgeConfirmPrompt(
  pair: JudgePair,
  order: JudgeOrder = 'ab'
): BuiltJudgePrompt {
  const chars = judgeConfirmChars(pair, order)
  const render = (cap: number): string => `Pair:\n${judgeItemText(pair, 1, order, cap)}`
  return {
    version: JUDGE_PROMPT_VERSION,
    messages: [
      { role: 'system', content: JUDGE_CONFIRM_RULES },
      { role: 'user', content: render(chars) }
    ],
    maxTokens: JUDGE_CONFIRM_MAX_TOKENS,
    order,
    sent: 1
  }
}

/** One verdict as read: the judge's ruling and its reason (with a `c` only; the confirm's always). */
export interface JudgeRuling {
  r: JudgeVerdict
  w: string | null
}

/** A reason cut to `words` words; null when empty. */
function cutWords(text: unknown, words: number): string | null {
  if (typeof text !== 'string') return null
  const kept = text
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== '')
    .slice(0, words)
  return kept.length === 0 ? null : kept.join(' ')
}

const RawRuling = z.object({
  i: z.number().int().positive(),
  r: z.unknown().optional(),
  w: z.unknown().optional()
})

/**
 * Reads a batch's reply leniently: each entry whose `r` is a verdict (`c`, `ok`, `u`), the first
 * for a number given twice; an unknown `r` is no verdict (the pair stays unjudged); `w` is kept
 * only with `c`, cut to 8 words. A reply cut off at its cap is read up to its last whole entry
 * (`salvageJsonItems`); the unanswered items stay unjudged for the next run.
 */
export function parseJudgeAnswer(text: string): Map<number, JudgeRuling> {
  let items: unknown[]
  try {
    const parsed: unknown = JSON.parse(unfence(text))
    const root =
      typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
    items = Array.isArray(root.v) ? root.v : []
  } catch {
    items = salvageJsonItems(text, 'v')
  }
  const rulings = new Map<number, JudgeRuling>()
  for (const item of items) {
    const raw = RawRuling.safeParse(item)
    if (!raw.success || rulings.has(raw.data.i)) continue
    const verdict = JudgeVerdict.safeParse(raw.data.r)
    if (!verdict.success) continue
    rulings.set(raw.data.i, {
      r: verdict.data,
      w: verdict.data === 'c' ? cutWords(raw.data.w, JUDGE_WHY_WORDS) : null
    })
  }
  return rulings
}

/** Reads the stronger check's reply: its verdict and reason (20 words at most), or null. */
export function parseJudgeConfirm(text: string): JudgeRuling | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(unfence(text))
  } catch {
    return null
  }
  const root =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  const verdict = JudgeVerdict.safeParse(root.r)
  if (!verdict.success) return null
  return { r: verdict.data, w: cutWords(root.w, JUDGE_CONFIRM_WHY_WORDS) }
}
