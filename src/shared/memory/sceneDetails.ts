import { z } from 'zod'
import { SCENE_META_FIELD_MAX, SCENE_META_TIMELINE_MAX } from '../sceneMeta'

/**
 * Typed scene details (F-16.11): a scene's POV, place, time, story year, "+ also here", which
 * point at records in v2, and the Flashback switch (2026-10-14). Stored in their own table (`scene_detail`), not in `SceneMeta`: that is
 * a `z.object`, which strips unknown keys, so an older build saving scene meta would silently drop
 * new ones (plan P1 §1.1). Synopsis, brief, beats and status stay in `SceneMeta`.
 */

/** Most records one scene lists under "+ also here". */
export const ALSO_HERE_MAX = 30
/** The story-year range accepted (a year of the story's own calendar). */
export const STORY_YEAR_MIN = -100_000
export const STORY_YEAR_MAX = 100_000

const DetailText = z.string().trim().max(SCENE_META_FIELD_MAX)
/** The time takes what v1's timeline text took, which the switch-over copies into it. */
const TimeText = z.string().trim().max(SCENE_META_TIMELINE_MAX)

export const SceneDetails = z.object({
  /** The POV character's record. */
  povRecordId: z.string().nullable(),
  /** The place: a record, free text, or both (the text says more than the record). */
  place: z.object({ recordId: z.string().nullable(), text: DetailText }),
  /** When, in the author's words ("December, evening"). */
  time: z.object({ text: TimeText }),
  /** One typed year per time jump; ages count from it (decision 5). */
  storyYear: z.number().int().min(STORY_YEAR_MIN).max(STORY_YEAR_MAX).nullable(),
  /** Records present without being named ("+ also here"), in the author's order. */
  alsoHere: z.array(z.string()).max(ALSO_HERE_MAX),
  /**
   * The Flashback switch (the author's decision 2026-10-14): null follows the book's reading (the
   * card's verified flashback), true is a flashback, false is not one. The author's setting wins
   * over the AI's in both directions (`sceneFlashback`).
   */
  flashback: z.boolean().nullable()
})
export type SceneDetails = z.infer<typeof SceneDetails>

/** What `sceneDetail:get` answers: the details, and the "+ also here" ids whose record is gone. */
export const SceneDetailsView = SceneDetails.extend({ gone: z.array(z.string()) })
export type SceneDetailsView = z.infer<typeof SceneDetailsView>

/** The details alone (a view's `gone` left out): what a save sends back. */
export function detailsOf(view: SceneDetails): SceneDetails {
  return {
    povRecordId: view.povRecordId,
    place: view.place,
    time: view.time,
    storyYear: view.storyYear,
    alsoHere: view.alsoHere,
    flashback: view.flashback
  }
}

export function emptySceneDetails(): SceneDetails {
  return {
    povRecordId: null,
    place: { recordId: null, text: '' },
    time: { text: '' },
    storyYear: null,
    alsoHere: [],
    flashback: null
  }
}

/**
 * A story year as the author types it: "1814" → 1814, "-40" → -40, "" → null (no year);
 * anything else, or a year out of range, → undefined, which the field refuses.
 */
export function parseStoryYear(text: string): number | null | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (!/^-?\d+$/.test(trimmed)) return undefined
  const year = Number(trimmed)
  return year >= STORY_YEAR_MIN && year <= STORY_YEAR_MAX ? year : undefined
}
