import { z } from 'zod'
import { SCENE_META_FIELD_MAX } from '../sceneMeta'

/**
 * Typed scene details (F-16.11): a scene's POV, place, time, story year and "+ also here", which
 * point at records in v2. Stored in their own table (`scene_detail`), not in `SceneMeta`: that is
 * a `z.object`, which strips unknown keys, so an older build saving scene meta would silently drop
 * new ones (plan P1 §1.1). Synopsis, brief, beats and status stay in `SceneMeta`.
 */

/** Most records one scene lists under "+ also here". */
export const ALSO_HERE_MAX = 30
/** The story-year range accepted (a year of the story's own calendar). */
export const STORY_YEAR_MIN = -100_000
export const STORY_YEAR_MAX = 100_000

const DetailText = z.string().trim().max(SCENE_META_FIELD_MAX)

export const SceneDetails = z.object({
  /** The POV character's record. */
  povRecordId: z.string().nullable(),
  /** The place: a record, free text, or both (the text says more than the record). */
  place: z.object({ recordId: z.string().nullable(), text: DetailText }),
  /** When, in the author's words ("December, evening"). */
  time: z.object({ text: DetailText }),
  /** One typed year per time jump; ages count from it (decision 5). */
  storyYear: z.number().int().min(STORY_YEAR_MIN).max(STORY_YEAR_MAX).nullable(),
  /** Records present without being named ("+ also here"), in the author's order. */
  alsoHere: z.array(z.string()).max(ALSO_HERE_MAX)
})
export type SceneDetails = z.infer<typeof SceneDetails>

/** What `sceneDetail:get` answers: the details, and the "+ also here" ids whose record is gone. */
export const SceneDetailsView = SceneDetails.extend({ gone: z.array(z.string()) })
export type SceneDetailsView = z.infer<typeof SceneDetailsView>

export function emptySceneDetails(): SceneDetails {
  return {
    povRecordId: null,
    place: { recordId: null, text: '' },
    time: { text: '' },
    storyYear: null,
    alsoHere: []
  }
}
