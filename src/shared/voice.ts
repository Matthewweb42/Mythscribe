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

/**
 * Who chose an exemplar (F-14.14): the author marked it (`author`, F-14.1), or the local voice
 * job picked it from the author's own paragraphs (`auto`). The job only ever replaces its own
 * rows; a hand-marked row is never touched and ranks first in the voice block.
 */
export const VOICE_EXEMPLAR_SOURCES = ['author', 'auto'] as const
export const VoiceExemplarSource = z.enum(VOICE_EXEMPLAR_SOURCES)
export type VoiceExemplarSource = z.infer<typeof VoiceExemplarSource>

/** Bounds of one exemplar's plain text, in characters; the contract and the toolbar button share them. */
export const VOICE_EXEMPLAR_TEXT_MIN = 80
export const VOICE_EXEMPLAR_TEXT_MAX = 2_000

/** How many hand-marked exemplars a project keeps (the spec's 6–12); automatic ones are counted apart. */
export const VOICE_EXEMPLAR_MAX = 12

/**
 * Automatic voice learning (F-14.14, decided by Claude, unconfirmed). The local `voice` job
 * re-picks up to `VOICE_AUTO_EXEMPLAR_MAX` exemplars from the author's own paragraphs (never
 * AI-origin text) once the manuscript has moved by `VOICE_AUTO_REFRESH_WORDS` words since the
 * last pick, `VOICE_JOB_DEBOUNCE_MS` after the last save. A passage is one paragraph, or a run of
 * consecutive short ones, between `VOICE_AUTO_PASSAGE_MIN` and `VOICE_AUTO_PASSAGE_MAX`
 * characters, so a picked exemplar fits a prompt's voice block.
 */
export const VOICE_AUTO_EXEMPLAR_MAX = 6
export const VOICE_AUTO_REFRESH_WORDS = 1_500
export const VOICE_JOB_DEBOUNCE_MS = 30_000
export const VOICE_AUTO_PASSAGE_MIN = 200
export const VOICE_AUTO_PASSAGE_MAX = 900
/** How many removed automatic passages the project remembers, so the job never picks them again. */
export const VOICE_AUTO_DISMISSED_MAX = 200

/** Settings key of the job's own state: the manuscript words at the last pick and the removed passages. */
export const VOICE_AUTO_KEY = 'voiceAuto'
export const VoiceAutoState = z.object({
  /** Manuscript words when the automatic exemplars were last picked; null before the first pick. */
  basedOnWords: z.number().int().nonnegative().nullable(),
  /** sha256 hashes of the passages the author removed, newest last. */
  dismissed: z.array(z.string()).max(VOICE_AUTO_DISMISSED_MAX)
})
export type VoiceAutoState = z.infer<typeof VoiceAutoState>

export function defaultVoiceAutoState(): VoiceAutoState {
  return { basedOnWords: null, dismissed: [] }
}

/**
 * Learned style notes (F-14.14, decided by Claude, unconfirmed): AI-made derived data (`PLAN.md`
 * §2.6), a few concrete observations about how the author writes, kept in a settings row apart
 * from the author's own rules, shown in the Voice section with Clear, and carried by the voice
 * block. Refreshed in the background by the fast tier at most once per
 * `VOICE_NOTES_REFRESH_WORDS` manuscript words, the first time once the manuscript holds
 * `VOICE_NOTES_MIN_WORDS`. The prompt reads at most `VOICE_NOTES_SAMPLE_CHARS` characters of
 * the author's own paragraphs; the voice block carries the notes within
 * `VOICE_NOTES_TOKEN_BUDGET` of its own budget.
 */
export const VOICE_NOTES_KEY = 'voiceNotes'
export const VOICE_NOTES_MAX = 8
export const VOICE_NOTE_MAX_CHARS = 160
export const VOICE_NOTES_REFRESH_WORDS = 5_000
export const VOICE_NOTES_MIN_WORDS = 2_000
export const VOICE_NOTES_SAMPLE_CHARS = 6_000
export const VOICE_NOTES_TOKEN_BUDGET = 200

export const VoiceNotes = z.object({
  /** The notes, each at most `VOICE_NOTE_MAX_CHARS`; empty after Clear until the next refresh. */
  notes: z.array(z.string().max(VOICE_NOTE_MAX_CHARS)).max(VOICE_NOTES_MAX),
  /** Manuscript words when the notes were last written (or cleared). */
  basedOnWords: z.number().int().nonnegative(),
  /** The model that wrote them; null after Clear. */
  model: z.string().nullable(),
  /** ISO time of the last write. */
  updated: z.string()
})
export type VoiceNotes = z.infer<typeof VoiceNotes>

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
