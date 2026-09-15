import { z } from 'zod'

/**
 * The voice profile's shared constants (F-14.1). An exemplar is a passage the author marked as
 * "this is how I sound"; the profile is built locally from the exemplars and the manuscript's
 * stylometrics (`stylometry.ts`) and never leaves the machine on its own: only the rendered
 * block a prompt folds in (`voiceBlock`) does, and the data-sharing panel names it.
 */

/** What kind of prose an exemplar mostly is; `classifyKind` in `stylometry.ts` decides. */
export const EXEMPLAR_KINDS = ['dialogue', 'action', 'interiority', 'mixed'] as const
export const VoiceExemplarKind = z.enum(EXEMPLAR_KINDS)
export type VoiceExemplarKind = z.infer<typeof VoiceExemplarKind>

export const EXEMPLAR_KIND_LABEL: Record<VoiceExemplarKind, string> = {
  dialogue: 'Dialogue',
  action: 'Action',
  interiority: 'Interiority',
  mixed: 'Mixed'
}

/** Bounds of one exemplar's plain text, in characters; the contract and the toolbar button share them. */
export const VOICE_EXEMPLAR_TEXT_MIN = 80
export const VOICE_EXEMPLAR_TEXT_MAX = 2_000

/** How many exemplars a project keeps (the spec's 6–12). */
export const VOICE_EXEMPLAR_MAX = 12

/** The estimated-token ceiling of the block `voiceBlock` renders into a prompt. */
export const VOICE_BLOCK_TOKEN_BUDGET = 600

/** Exemplar count from which the confidence gains its bonus. */
export const VOICE_CONFIDENCE_EXEMPLARS = 6
/** The manuscript sizes (words) at which confidence reaches one half and one. */
export const VOICE_CONFIDENCE_HALF_WORDS = 5_000
export const VOICE_CONFIDENCE_FULL_WORDS = 30_000

/**
 * The voice confidence (PLAN.md §2.1's indicator): piecewise-linear in the words the profile was
 * built from (0 at none, 0.5 at 5,000, 1 at 30,000 and beyond), plus 0.1 once six or more
 * exemplars are marked, capped at 1.
 */
export function voiceConfidence(words: number, exemplarCount: number): number {
  const base =
    words <= VOICE_CONFIDENCE_HALF_WORDS
      ? (words / VOICE_CONFIDENCE_HALF_WORDS) * 0.5
      : words <= VOICE_CONFIDENCE_FULL_WORDS
        ? 0.5 +
          ((words - VOICE_CONFIDENCE_HALF_WORDS) /
            (VOICE_CONFIDENCE_FULL_WORDS - VOICE_CONFIDENCE_HALF_WORDS)) *
            0.5
        : 1
  const bonus = exemplarCount >= VOICE_CONFIDENCE_EXEMPLARS ? 0.1 : 0
  return Math.min(1, base + bonus)
}
