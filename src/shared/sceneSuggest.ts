import { z } from 'zod'
import { SCENE_SYNOPSIS_MAX } from './sceneMeta'

/**
 * Synopsis and notes suggestions (F-5.20): the AI, which reads the whole scene, proposes the
 * synopsis for the side panel and the key points to keep in mind in the scene's notes. Both are
 * proposals the author accepts with one click (CLAUDE.md, author-control rule 1); nothing is
 * written into the panel without that accept. This file owns the caps both sides share, and the
 * caps on the side panel as the chat and Story Intelligence see it (F-5.20: the AI that has the
 * context sees the panel too).
 */

/** Below this much scene text there is nothing to suggest a synopsis or notes from. */
export const SCENE_SUGGEST_TEXT_MIN = 100
/** The scene is head-truncated to this many characters before it is sent (~3,000 tokens). */
export const SCENE_SUGGEST_CHAR_BUDGET = 12_000
/** The most key points one notes suggestion holds. */
export const NOTES_SUGGEST_POINTS_MAX = 8
/** Each point's cap: one sentence, two at most. */
export const NOTES_SUGGEST_POINT_MAX = 200
/** The author's focus for a notes suggestion ("what should I remember about Tomas?"). */
export const NOTES_SUGGEST_INSTRUCTION_MAX = 500
/** How much of the scene's current notes a notes suggestion reads, so it adds rather than repeats. */
export const NOTES_SUGGEST_CURRENT_CHARS = 1_500

/** The side panel as the chat and Story Intelligence read it: the synopsis whole (it is capped already)… */
export const PANEL_SYNOPSIS_CHARS = SCENE_SYNOPSIS_MAX
/** …and the head of the scene's notes. */
export const PANEL_NOTES_CHARS = 1_500

/** A suggested synopsis as the reply carries it and the side panel stores it. */
export const SuggestedSynopsis = z.string().min(1).max(SCENE_SYNOPSIS_MAX)

/** Suggested key points, each a line the author can add to the notes. */
export const SuggestedNotePoints = z
  .array(z.string().min(1).max(NOTES_SUGGEST_POINT_MAX))
  .max(NOTES_SUGGEST_POINTS_MAX)
export type SuggestedNotePoints = z.infer<typeof SuggestedNotePoints>
