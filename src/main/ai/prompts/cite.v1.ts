import { z } from 'zod'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import { salvageJsonItems, unfence } from '@shared/memory/readerAnswer'
import type { AiMessage } from '../providers/types'

/**
 * Ms Scribe's quote check (F-16.25; plan P3 §3.2, design §2.6), version 1: fast tier, JSON,
 * reasoning off. After code has kept an answer's citations (each quote in its item as sent), one
 * request asks whether each cited sentence says what its quotes say ("yes", "partly", "no"), and,
 * for a first/last/ever/never answer, whether an earlier passage the search found shows the same
 * thing (the scope item, P3-D8). Never the whole scene: each quote travels in its own sentence with
 * one either side. One call per answer, none when nothing was cited.
 *
 * Order (token rule 3): the rules, identical for every check (cached); then one user turn with the
 * question, the numbered sentences and the scope item.
 */
export const CITE_PROMPT_VERSION = 'cite.v1'

/** The opening sentence; the e2e's fake provider keys on it. */
export const CITE_SENTINEL = 'You are the citation checker inside a novel-writing app.'

/** The rules (the golden holds them at 250 tokens or under). */
export const CITE_RULES =
  `${CITE_SENTINEL} Each numbered sentence comes from an answer about the author's book, with ` +
  'the passages it quotes, each quote shown in its sentence with one sentence either side.\n' +
  '- "ok": "yes" when the quotes say what the sentence says, not merely mention the same people ' +
  'or things; "partly" when they support only part of it; "no" when they do not support it. ' +
  'Judge from the passages given alone, never from what you know. A passage labelled your idea, ' +
  'planned, idea scene or not canon supports a sentence only if the sentence says it is that.\n' +
  '- "scope", only with a Scope item: "earlier" when a passage listed there shows the same thing ' +
  'as the first sentence, so it is not the first (or the last), or shows what the answer says ' +
  'was not found; else "ok". Without a Scope item: "none".\n' +
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
 * A cited sentence, a quote (25 words at most, `quoteHeld`), a quote's context and a scope passage,
 * cut to these many characters: the first sentence with all eight quotes fits whatever else is sent.
 */
export const CITE_SENTENCE_CHARS = 400
export const CITE_QUOTE_CHARS = 200
export const CITE_CONTEXT_CHARS = 450
export const CITE_HIT_CHARS = 240
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
 * The scope item (P3 §3.2): what code searched, the answer's first sentence and the scene it
 * cites, and up to five passages the search found before it (after it, for a last or latest
 * answer) in reading order.
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

/** `text` with runs of space as one, cut to `max` characters at a word with `…`. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const at = cut.lastIndexOf(' ')
  return `${(at > max / 2 ? cut.slice(0, at) : cut).trimEnd()}…`
}

/** One sentence as its lines in the user turn, numbered from 1. */
export function citeSentenceText(sentence: CitePromptSentence, n: number): string {
  return [
    `${n}. ${clip(sentence.text, CITE_SENTENCE_CHARS)}`,
    ...sentence.quotes.map(
      (quote) =>
        `${quote.evidence} [${clip(quote.tag, CITE_QUOTE_CHARS)}] “${clip(quote.quote, CITE_QUOTE_CHARS)}” in: ${clip(quote.context, CITE_CONTEXT_CHARS)}`
    )
  ].join('\n')
}

/** The scope item as its lines, its passages cut to fit `CITE_SCOPE_TOKENS`. */
export function citeScopeText(scope: CitePromptScope): string {
  const cited = scope.cited === null ? '' : ` It cites ${scope.cited}.`
  const head =
    `Scope: searched ${scope.searched}. The first sentence: “${clip(scope.claim, CITE_SENTENCE_CHARS)}”${cited}\n` +
    (scope.cited === null
      ? 'Passages the search found:'
      : `Passages the search found ${scope.latest ? 'after' : 'before'} ${scope.cited}:`)
  const lines: string[] = []
  for (const hit of scope.hits.slice(0, CITE_SCOPE_HITS_MAX)) {
    const line = `- ${hit.ref}: ${clip(hit.text, CITE_HIT_CHARS)}`
    if (estimateTokens([head, ...lines, line].join('\n')) > CITE_SCOPE_TOKENS) break
    lines.push(line)
  }
  return [head, ...(lines.length === 0 ? ['(none)'] : lines)].join('\n')
}

/**
 * The check of one answer: the rules, then the question, the sentences in the answer's order (the
 * main claim first), each whole with all its quotes, within `CITE_SENTENCES_TOKENS` and what the
 * input cap leaves (the later ones dropped first, so the first sentence is always sent), and the
 * scope item when given.
 */
export function buildCitePrompt(input: BuildCitePromptInput): BuiltCitePrompt {
  const question = `Question: ${clip(input.question, CITE_QUESTION_CHARS)}`
  const scope = input.scope === null ? null : citeScopeText(input.scope)
  const room = Math.min(
    CITE_SENTENCES_TOKENS,
    inputBudget('cite') -
      estimateTokens([CITE_RULES, question, scope ?? ''].join('\n\n\n\n')) -
      CITE_MARGIN_TOKENS
  )
  const parts: string[] = []
  let used = 0
  for (const sentence of input.sentences.slice(0, CITE_SENTENCES_MAX)) {
    const text = citeSentenceText(sentence, parts.length + 1)
    const cost = estimateTokens(`${text}\n\n`)
    if (parts.length > 0 && used + cost > room) break
    parts.push(text)
    used += cost
  }
  const tail = [question, parts.join('\n\n')]
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
