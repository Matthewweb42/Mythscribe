import { z } from 'zod'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import { normalizeForMatch } from '@shared/critique'
import { salvageJsonItems, unfence } from '@shared/memory/readerAnswer'
import { clipAtWord } from '@shared/textClip'
import type { AiMessage } from '../providers/types'

/**
 * Ms Scribe's quote check (F-16.25; plan P3 §3.2, design §2.6), version 1: fast tier, JSON,
 * reasoning off. After code has kept an answer's citations (each quote in its item as sent), one
 * request asks whether each cited sentence says what its quotes say ("yes", "partly", "no"), and,
 * for a first/last/ever/never answer, whether an earlier passage the search found shows the same
 * thing (the scope item, P3-D8), and, for an answer that found nothing, whether a passage the
 * search found shows it. Never the whole scene: each quote travels in its own sentence with one
 * either side. One call per answer, none when nothing was cited and no absence has passages to be
 * checked against. The labels are read as agent.v9 reads them, against the Now line.
 *
 * Order (token rule 3): the rules, identical for every check (cached); then one user turn with the
 * question and Now, the numbered sentences and the scope item.
 */
export const CITE_PROMPT_VERSION = 'cite.v1'

/** The opening sentence; the e2e's fake provider keys on it. */
export const CITE_SENTINEL = 'You are the citation checker inside a novel-writing app.'

/**
 * The rules (the golden holds them at 250 tokens or under). The labels are the evidence tags'
 * words (`EVIDENCE_LABEL_WORDS`) as agent.v9 reads them: "happened" text has happened by Now (the
 * user turn's Now line), "later in the book" after it; notes, source documents and filed lines say
 * who or what things are, never that an event happened (design §2.6).
 */
export const CITE_RULES =
  `${CITE_SENTINEL} Each numbered sentence is from an answer about the author's book; each quote ` +
  'it cites is shown in its sentence with one either side.\n' +
  '- "ok": "yes" when the quotes say what the sentence says, not merely name the same things; ' +
  '"partly" when they support only part of it; "no" when they do not. Judge from the passages ' +
  'alone.\n' +
  '- Labels: only "happened" text has happened by Now; "later in the book" happens after Now; ' +
  'your notes, source documents and "filed from" lines say who or what things are, never that ' +
  'an event happened; your idea, planned, idea scene and not canon text never happened. Such a ' +
  'passage supports a sentence only if it says so.\n' +
  '- "scope", only with a Scope item: "earlier" when a listed passage shows the same thing as ' +
  'the first sentence (so it is not the first, or the last) or what the answer says was not ' +
  'found; else "ok". Without one: "none".\n' +
  'Reply with JSON only: {"v":[{"i":1,"ok":"yes"}],"scope":"none"}'

/** The most cited sentences one check carries (an answer keeps at most 8 citations). */
export const CITE_SENTENCES_MAX = 8
/** The most earlier passages the scope item lists. */
export const CITE_SCOPE_HITS_MAX = 5
/**
 * The sentences part's tokens at most (less when the question and the scope item leave less of
 * the 2,500 input cap), the scope item's, and the question's characters.
 */
export const CITE_SENTENCES_TOKENS = 1_800
export const CITE_SCOPE_TOKENS = 400
export const CITE_QUESTION_CHARS = 1_000
/**
 * A cited sentence, a quote (25 words at most, `quoteHeld`), a quote's tag, its context and a
 * scope passage, cut to these many characters. When the first sentence with all its quotes does
 * not fit beside the question and the scope item, its contexts are cut shorter
 * (`CITE_FIRST_CONTEXT_CHARS`, around the quote); at the shortest it always fits.
 */
export const CITE_SENTENCE_CHARS = 400
export const CITE_QUOTE_CHARS = 200
export const CITE_CONTEXT_CHARS = 450
export const CITE_HIT_CHARS = 240
/** The first sentence's context caps, tried in order until it fits (the last always does). */
export const CITE_FIRST_CONTEXT_CHARS = [CITE_CONTEXT_CHARS, 300, 200, 120] as const
/** What the fit keeps back for the joins between the parts. */
const CITE_MARGIN_TOKENS = 10

/** Output per answer: 20, then 10 a sentence and 20 for the scope (P3 §3.2). */
export const CITE_BASE_TOKENS = 20
export const CITE_SENTENCE_TOKENS = 10
export const CITE_SCOPE_OUT_TOKENS = 20

/** One quote of a cited sentence: the item, its tag as the answer was sent it, and its context. */
export interface CitePromptQuote {
  /** `E7`, `W2`, `E0`. */
  evidence: string
  /** The label's words and the place ("happened, 9.3 ¶4"; "your idea, Mara's Ideas"). */
  tag: string
  quote: string
  /** The quote's evidence sentence(s) with one sentence either side. */
  context: string
}

export interface CitePromptSentence {
  text: string
  quotes: readonly CitePromptQuote[]
}

/**
 * The scope item (P3 §3.2): what code searched, the answer's main claim and the scene it cites,
 * and up to five passages the search found before it (after it, for a last or latest answer) in
 * reading order; for an answer that found nothing, every passage the search found (no scene).
 */
export interface CitePromptScope {
  /** `searchedPhrase`: "every scene up to 14.2 for distrust, suspicion". */
  searched: string
  claim: string
  /** The scene the first sentence cites ("9.3"), or null (an absence answer, a note). */
  cited: string | null
  /** True for a last or latest answer: the listed passages come after the cited scene. */
  latest: boolean
  hits: readonly { ref: string; text: string }[]
}

export interface BuildCitePromptInput {
  question: string
  /** Now: the open scene's ref ("9.3"), which "happened" and "later in the book" are read against. */
  now: string | null
  /** The cited sentences; none for an answer that found nothing checked on its scope alone. */
  sentences: readonly CitePromptSentence[]
  scope: CitePromptScope | null
}

export interface BuiltCitePrompt {
  version: typeof CITE_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
  /** How many of the sentences were sent (the first ones; the rest are left with no verdict). */
  sent: number
  /** Whether the scope item was sent. */
  scope: boolean
}

/** `max_tokens`: min(200, 20 + 10 per sentence + 20 for the scope item). */
export function citeMaxTokens(sentences: number, scope: boolean): number {
  return Math.min(
    outputBudget('cite'),
    CITE_BASE_TOKENS + CITE_SENTENCE_TOKENS * sentences + (scope ? CITE_SCOPE_OUT_TOKENS : 0)
  )
}

/**
 * `text` flattened and cut to about `max` characters around `quote` (its whole when it fits), at
 * words, with `…` where it was cut: the quote's own words always stay in, the neighbours go first.
 * A quote not found in it is cut from the start (`clipAtWord`).
 */
export function clipAround(text: string, quote: string, max: number): string {
  const flat = normalizeForMatch(text)
  if (flat.length <= max) return flat
  const needle = normalizeForMatch(quote)
  const at = needle === '' ? -1 : flat.indexOf(needle)
  if (at < 0) return clipAtWord(flat, max)
  if (needle.length >= max) return clipAtWord(needle, max)
  const end = at + needle.length
  let from = Math.max(0, Math.min(at - Math.floor((max - needle.length) / 2), flat.length - max))
  let to = Math.min(flat.length, from + max)
  // Cut at words, never into the quote.
  if (from > 0) {
    const space = flat.indexOf(' ', from)
    if (space >= 0 && space < at) from = space + 1
  }
  if (to < flat.length) {
    const space = flat.lastIndexOf(' ', to)
    if (space >= end) to = space
  }
  return `${from > 0 ? '…' : ''}${flat.slice(from, to).trim()}${to < flat.length ? '…' : ''}`
}

/**
 * One sentence as its lines in the user turn, numbered from 1, each quote's context cut around it
 * to `contextChars`.
 */
export function citeSentenceText(
  sentence: CitePromptSentence,
  n: number,
  contextChars: number = CITE_CONTEXT_CHARS
): string {
  return [
    `${n}. ${clipAtWord(sentence.text, CITE_SENTENCE_CHARS)}`,
    ...sentence.quotes.map(
      (quote) =>
        `${quote.evidence} [${clipAtWord(quote.tag, CITE_QUOTE_CHARS)}] “${clipAtWord(quote.quote, CITE_QUOTE_CHARS)}” in: ${clipAround(quote.context, quote.quote, contextChars)}`
    )
  ].join('\n')
}

/** The scope item as its lines, its passages cut to fit `CITE_SCOPE_TOKENS`. */
export function citeScopeText(scope: CitePromptScope): string {
  const cited = scope.cited === null ? '' : ` It cites ${scope.cited}.`
  const head =
    `Scope: searched ${scope.searched}. The first sentence: “${clipAtWord(scope.claim, CITE_SENTENCE_CHARS)}”${cited}\n` +
    (scope.cited === null
      ? 'Passages the search found:'
      : `Passages the search found ${scope.latest ? 'after' : 'before'} ${scope.cited}:`)
  const lines: string[] = []
  for (const hit of scope.hits.slice(0, CITE_SCOPE_HITS_MAX)) {
    const line = `- ${hit.ref}: ${clipAtWord(hit.text, CITE_HIT_CHARS)}`
    if (estimateTokens([head, ...lines, line].join('\n')) > CITE_SCOPE_TOKENS) break
    lines.push(line)
  }
  return [head, ...(lines.length === 0 ? ['(none)'] : lines)].join('\n')
}

/**
 * The check of one answer: the rules, then the question with Now, the sentences in the answer's
 * order (the main claim first), each whole with all its quotes, within `CITE_SENTENCES_TOKENS` and
 * what the input cap leaves, and the scope item when given. The first sentence is always sent: its
 * quotes' contexts are cut shorter until it fits (`CITE_FIRST_CONTEXT_CHARS`); the later ones are
 * dropped first. With no sentence (an answer that found nothing), the scope item alone.
 */
export function buildCitePrompt(input: BuildCitePromptInput): BuiltCitePrompt {
  const question = [
    `Question: ${clipAtWord(input.question, CITE_QUESTION_CHARS)}`,
    ...(input.now === null || input.now === '' ? [] : [`Now: ${input.now}`])
  ].join('\n')
  const scope = input.scope === null ? null : citeScopeText(input.scope)
  const room = Math.min(
    CITE_SENTENCES_TOKENS,
    inputBudget('cite') -
      estimateTokens([CITE_RULES, question, scope ?? ''].join('\n\n\n\n')) -
      CITE_MARGIN_TOKENS
  )
  const cost = (text: string): number => estimateTokens(`${text}\n\n`)
  const parts: string[] = []
  let used = 0
  const [first, ...rest] = input.sentences.slice(0, CITE_SENTENCES_MAX)
  if (first !== undefined) {
    const texts = CITE_FIRST_CONTEXT_CHARS.map((chars) => citeSentenceText(first, 1, chars))
    const text = texts.find((each) => cost(each) <= room) ?? texts[texts.length - 1] ?? ''
    parts.push(text)
    used += cost(text)
  }
  for (const sentence of rest) {
    const text = citeSentenceText(sentence, parts.length + 1)
    if (used + cost(text) > room) break
    parts.push(text)
    used += cost(text)
  }
  const tail = [question, ...(parts.length === 0 ? [] : [parts.join('\n\n')])]
  if (scope !== null) tail.push(scope)
  return {
    version: CITE_PROMPT_VERSION,
    messages: [
      { role: 'system', content: CITE_RULES },
      { role: 'user', content: tail.join('\n\n') }
    ],
    maxTokens: citeMaxTokens(parts.length, input.scope !== null),
    sent: parts.length,
    scope: input.scope !== null
  }
}

/** One sentence's verdict: its quotes say it, part of it, or not. */
export const CITE_VERDICTS = ['yes', 'partly', 'no'] as const
export type CiteVerdict = (typeof CITE_VERDICTS)[number]
/** The scope item's verdict; `none` without one. */
export const CITE_SCOPES = ['ok', 'earlier', 'none'] as const
export type CiteScope = (typeof CITE_SCOPES)[number]

/** A check's reply as read: the verdicts by sentence number, and the scope's (null: not given). */
export interface CiteReply {
  verdicts: Map<number, CiteVerdict>
  scope: CiteScope | null
}

const RawCiteVerdict = z.object({
  i: z.number().int().positive(),
  ok: z.enum(CITE_VERDICTS)
})

/**
 * Reads a check's reply leniently: each verdict that parses, the first for a number given twice
 * (a sentence with none is left as code checked it); a reply cut off is read up to its last whole
 * verdict (`salvageJsonItems`), its scope then unread.
 */
export function parseCiteReply(text: string): CiteReply {
  let items: unknown[]
  let scope: CiteScope | null = null
  try {
    const parsed: unknown = JSON.parse(unfence(text))
    const root =
      typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
    items = Array.isArray(root.v) ? root.v : []
    const read = z.enum(CITE_SCOPES).safeParse(root.scope)
    scope = read.success ? read.data : null
  } catch {
    items = salvageJsonItems(text, 'v')
  }
  const verdicts = new Map<number, CiteVerdict>()
  for (const item of items) {
    const parsed = RawCiteVerdict.safeParse(item)
    if (parsed.success && !verdicts.has(parsed.data.i)) verdicts.set(parsed.data.i, parsed.data.ok)
  }
  return { verdicts, scope }
}
