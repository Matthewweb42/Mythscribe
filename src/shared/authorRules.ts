import { z } from 'zod'
import { estimateTokens } from './ai'

/**
 * The author's rules (F-14.2): free-text style rules and a banned-phrases list, the third
 * source of the voice profile (PLAN.md §2.1) beside the exemplars and the stylometrics. They
 * go out with every voice block as hard constraints (`renderAuthorRulesBlock`) and come back
 * through the fidelity check as a post-filter (`findBannedPhrases`): an answer that uses a
 * banned phrase is regenerated once with the phrase named, then shown flagged. Stored per
 * project as JSON in the `settings` table; a missing row answers with the defaults, which is
 * how a fresh project is seeded without a write.
 */

/** Settings-table key under which the author's rules are stored as JSON. */
export const AUTHOR_RULES_KEY = 'authorRules'

/** The free-text rules, in characters; the textarea and the schema share the cap. */
export const AUTHOR_RULES_TEXT_MAX = 400
/** One banned phrase, in characters, after trimming. */
export const BANNED_PHRASE_MAX = 60
/** How many banned phrases a project keeps. */
export const BANNED_PHRASES_MAX = 100
/**
 * The estimated-token ceiling of the block `renderAuthorRulesBlock` renders into a prompt.
 * The rules text always fits (400 characters is about 100 tokens); the phrases fill what is
 * left in order, and one that does not fit is left out of the prompt while the post-filter
 * still enforces it. Sized so the whole seeded list (122 tokens) goes out when there is no
 * rules text, and so the maxed ghost-text regenerate in the eval fixture keeps about 40
 * tokens of headroom under its 1,500 input budget.
 */
export const AUTHOR_RULES_TOKEN_BUDGET = 130

/**
 * The seeded AI-isms: phrases language models reach for that a novelist rarely does. Each is
 * distinctive enough to be worth a regenerate; common words that fiction needs ("navigate",
 * "landscape") are not on it. Editable: a removed phrase stays removed.
 */
export const DEFAULT_BANNED_PHRASES: readonly string[] = [
  'a testament to',
  'delve',
  'tapestry',
  "I couldn't help but",
  'little did they know',
  'in the heart of',
  'a sense of',
  "couldn't shake the feeling",
  'the weight of',
  'palpable',
  'sent shivers down',
  'a mix of',
  "a breath she didn't know she was holding",
  'for what felt like an eternity',
  'nestled',
  'a beacon of',
  'danced across',
  'in a world where',
  'a stark reminder',
  'the silence was deafening',
  'a wave of',
  'unspoken words',
  'eyes widened',
  'the world seemed to'
]

/** Straight quotes for curly ones, so “I couldn’t” and "I couldn't" are one phrase. */
const foldQuotes = (text: string): string => text.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"')

/** Trimmed, whitespace collapsed, quotes folded; '' for nothing. */
export function normalizeBannedPhrase(phrase: string): string {
  return foldQuotes(phrase).replace(/\s+/g, ' ').trim()
}

/**
 * The stored shape of a phrase list: each phrase normalised, empty ones dropped, duplicates
 * (case-insensitive, first wins) dropped, and the list cut at `BANNED_PHRASES_MAX`.
 */
export function normalizeBannedPhrases(phrases: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of phrases) {
    const phrase = normalizeBannedPhrase(raw)
    if (phrase.length === 0 || phrase.length > BANNED_PHRASE_MAX) continue
    const key = phrase.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(phrase)
    if (out.length >= BANNED_PHRASES_MAX) break
  }
  return out
}

export const AuthorRules = z.object({
  /** Free text, as typed (not trimmed here, so a trailing space survives a keystroke); rendered trimmed. */
  rules: z.string().max(AUTHOR_RULES_TEXT_MAX).default(''),
  bannedPhrases: z
    .array(z.string())
    .transform(normalizeBannedPhrases)
    .default(() => [...DEFAULT_BANNED_PHRASES])
})
export type AuthorRules = z.infer<typeof AuthorRules>
/** The shape before parsing: either field may be absent. */
export type AuthorRulesInput = z.input<typeof AuthorRules>

/** No rules text and the seeded phrases: what a project has until the author edits them. */
export function defaultAuthorRules(): AuthorRules {
  return { rules: '', bannedPhrases: [...DEFAULT_BANNED_PHRASES] }
}

/** Whether there is anything to send: rules text or at least one phrase. */
export function hasAuthorRules(rules: AuthorRules): boolean {
  return rules.rules.trim().length > 0 || rules.bannedPhrases.length > 0
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A matcher for one phrase: case-insensitive, any whitespace run between its words, a word boundary at both ends. */
function phrasePattern(phrase: string): RegExp {
  const body = escapeRegExp(phrase).replace(/ /g, '\\s+')
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu')
}

/**
 * The post-filter: every banned phrase `text` uses, in order of first appearance, each once.
 * Quotes are folded on both sides and the match is case-insensitive at word boundaries, so
 * "delve" matches "Delve" but not "delved", and the list entry "I couldn't help but" matches
 * "I couldn’t  help but".
 */
export function findBannedPhrases(phrases: readonly string[], text: string): string[] {
  const haystack = foldQuotes(text)
  const hits: { phrase: string; index: number }[] = []
  const seen = new Set<string>()
  for (const raw of phrases) {
    const phrase = normalizeBannedPhrase(raw)
    if (phrase.length === 0) continue
    const key = phrase.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const match = phrasePattern(phrase).exec(haystack)
    if (match) hits.push({ phrase, index: match.index })
  }
  return hits.sort((a, b) => a.index - b.index).map((hit) => hit.phrase)
}

/** The block's first line; the e2e and the tests recognise the block by it. */
export const AUTHOR_RULES_HEADER = "The author's rules (hard constraints):"
const PHRASES_PREFIX = 'Never use these phrases: '

/**
 * The prompt block (part of the voice block, after the stylometric rules): the header, the
 * rules text as written, then the banned phrases on one line, as many in order as keep the
 * block within `AUTHOR_RULES_TOKEN_BUDGET`. Null when there is nothing to send.
 */
export function renderAuthorRulesBlock(rules: AuthorRules): string | null {
  if (!hasAuthorRules(rules)) return null
  const text = rules.rules.trim()
  const base = text.length > 0 ? `${AUTHOR_RULES_HEADER}\n${text}` : AUTHOR_RULES_HEADER
  const listed: string[] = []
  for (const phrase of rules.bannedPhrases) {
    const candidate = `${base}\n${PHRASES_PREFIX}${[...listed, phrase].join('; ')}.`
    if (estimateTokens(candidate) > AUTHOR_RULES_TOKEN_BUDGET) break
    listed.push(phrase)
  }
  return listed.length > 0 ? `${base}\n${PHRASES_PREFIX}${listed.join('; ')}.` : base
}
