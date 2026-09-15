import { z } from 'zod'

/**
 * The editor mode of F-14.8 ("editor's notes"): the honesty setting, the note categories, the
 * limits the prompt, the contract, and the panel share, and the quote matching every note's
 * citation is checked with. The beta-reader read-through is F-14.11 (M3, on scene summaries).
 */

/** From encouraging to brutal (PLAN.md §2.4); the default is "specific and direct". */
export const HONESTY_LEVELS = ['encouraging', 'direct', 'brutal'] as const
export const Honesty = z.enum(HONESTY_LEVELS)
export type Honesty = z.infer<typeof Honesty>
export const DEFAULT_HONESTY: Honesty = 'direct'

export const HONESTY_LABEL: Record<Honesty, string> = {
  encouraging: 'Encouraging',
  direct: 'Specific and direct',
  brutal: 'Brutal'
}

/** What an editor's note is about; `intent` is the "is this scene doing what the brief says?" check. */
export const CRITIQUE_CATEGORIES = [
  'pacing',
  'clarity',
  'showTell',
  'pov',
  'filterWords',
  'repetition',
  'attribution',
  'intent'
] as const
export const CritiqueCategory = z.enum(CRITIQUE_CATEGORIES)
export type CritiqueCategory = z.infer<typeof CritiqueCategory>

export const CRITIQUE_CATEGORY_LABEL: Record<CritiqueCategory, string> = {
  pacing: 'Pacing',
  clarity: 'Clarity',
  showTell: "Show, don't tell",
  pov: 'POV slip',
  filterWords: 'Filter words',
  repetition: 'Repetition',
  attribution: 'Attribution',
  intent: 'Intent'
}

/** Characters of scene text a document needs before it can be critiqued. */
export const CRITIQUE_TEXT_MIN = 200
/** The scene text is head-truncated to this many characters (~5,000 tokens) before it is sent. */
export const CRITIQUE_SCENE_CHAR_BUDGET = 20_000
/** The scene's notes (the brief stand-in until F-14.3) are cut to this many characters. */
export const CRITIQUE_NOTES_CHAR_CAP = 500
/** Notes per critique, after the uncited ones are dropped. */
export const CRITIQUE_MAX_NOTES = 8
export const CRITIQUE_QUOTE_MAX = 240
export const CRITIQUE_WHY_MAX = 300
export const CRITIQUE_FIX_MAX = 600

/**
 * One editor's note as the renderer receives it: every note cites `quote`, a passage main
 * located in the scene text it sent; `fix` is a replacement for that passage only (null for
 * praise or when the model offered none), scored by the fidelity check (F-14.7).
 */
export const CritiqueNote = z.object({
  kind: z.enum(['issue', 'praise']),
  category: CritiqueCategory,
  quote: z.string().min(1).max(CRITIQUE_QUOTE_MAX),
  why: z.string().min(1).max(CRITIQUE_WHY_MAX),
  fix: z.string().min(1).max(CRITIQUE_FIX_MAX).nullable(),
  flagged: z.boolean(),
  violation: z.string().nullable()
})
export type CritiqueNote = z.infer<typeof CritiqueNote>
export const CritiqueNotes = z.array(CritiqueNote).max(CRITIQUE_MAX_NOTES)
export type CritiqueNotes = z.infer<typeof CritiqueNotes>

/** Curly quotation marks and apostrophes as their straight forms; every other character as is. */
export function straightenQuotes(text: string): string {
  return text.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"')
}

/**
 * The form a quote is matched in, on both sides (main against the scene text it sent, the
 * renderer against the document): straight quotes, whitespace runs (line breaks included) as
 * one space, trimmed. The renderer's `locateText` mirrors these rules character by character.
 */
export function normalizeForMatch(text: string): string {
  return straightenQuotes(text).replace(/\s+/g, ' ').trim()
}

/** Whether `quote` appears in `haystack` once both are normalized; an empty quote never does. */
export function findQuote(haystack: string, quote: string): boolean {
  const needle = normalizeForMatch(quote)
  return needle !== '' && normalizeForMatch(haystack).includes(needle)
}
