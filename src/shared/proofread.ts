import { z } from 'zod'

/**
 * Proofread (F-14.12): a mechanical pass over a scene or a selection — spelling, typos,
 * grammar, punctuation, doubled and missing words, and misspelled story names. Never style:
 * every fix is a small edit to the quoted passage, and main drops anything larger. The limits
 * the prompt, the contract, and the panel share live here.
 */

export const PROOFREAD_KINDS = [
  'spelling',
  'typo',
  'grammar',
  'punctuation',
  'doubledWord',
  'missingWord',
  'name'
] as const
export const ProofreadKind = z.enum(PROOFREAD_KINDS)
export type ProofreadKind = z.infer<typeof ProofreadKind>

export const PROOFREAD_KIND_LABEL: Record<ProofreadKind, string> = {
  spelling: 'Spelling',
  typo: 'Typo',
  grammar: 'Grammar',
  punctuation: 'Punctuation',
  doubledWord: 'Doubled word',
  missingWord: 'Missing word',
  name: 'Name'
}

/** Characters a scene or a selection needs before it can be proofread. */
export const PROOFREAD_TEXT_MIN = 20
/** The scene (or the selection) is head-truncated to this many characters before it is sent. */
export const PROOFREAD_CHAR_BUDGET = 20_000
/** Fixes per run, in document order, after the invalid ones are dropped. */
export const PROOFREAD_MAX_FIXES = 30
/** The quoted passage: the error with just enough words around it to be found exactly once. */
export const PROOFREAD_QUOTE_MAX = 160
export const PROOFREAD_FIX_MAX = 200
/**
 * Words a fix may delete plus insert against its quote (by `diffWords`); a larger edit is a
 * rewrite, not a correction, and is dropped (the "never style" rule, enforced in main).
 */
export const PROOFREAD_MAX_CHANGED_WORDS = 6
/** The names and project-dictionary words sent as "leave these alone", at most. */
export const PROOFREAD_KEEP_WORDS_MAX = 200

/**
 * One fix as the renderer receives it: `quote` is in the text main sent and occurs exactly once
 * in the saved scene, so the renderer's `locateText` lands on it; `fix` is the corrected
 * passage, scored by the fidelity check (F-14.7) when the project has a voice block.
 */
export const ProofreadFix = z.object({
  kind: ProofreadKind,
  quote: z.string().min(1).max(PROOFREAD_QUOTE_MAX),
  fix: z.string().min(1).max(PROOFREAD_FIX_MAX),
  flagged: z.boolean(),
  violation: z.string().nullable()
})
export type ProofreadFix = z.infer<typeof ProofreadFix>
export const ProofreadFixes = z.array(ProofreadFix).max(PROOFREAD_MAX_FIXES)
export type ProofreadFixes = z.infer<typeof ProofreadFixes>

/** What was proofread: the whole saved scene, or the selection the renderer sent. */
export const ProofreadScope = z.enum(['scene', 'selection'])
export type ProofreadScope = z.infer<typeof ProofreadScope>
