import { z } from 'zod'

/** Caps for the three free-text fields; generous, but bounded like every stored string. */
export const SCENE_META_FIELD_MAX = 200
export const SCENE_META_TIMELINE_MAX = 500

/**
 * The metadata of a scene, chapter, or part (F-4.5): Location and POV are free text with
 * autocomplete from the setting and character tags (plain strings, so a location that is not a
 * tag yet still works), the timeline position is free text until F-11.2 replaces it. Stored as
 * JSON in `node.scene_meta`.
 */
export const SceneMeta = z.object({
  location: z.string().max(SCENE_META_FIELD_MAX),
  pov: z.string().max(SCENE_META_FIELD_MAX),
  timeline: z.string().max(SCENE_META_TIMELINE_MAX)
})
export type SceneMeta = z.infer<typeof SceneMeta>

export const EMPTY_SCENE_META: SceneMeta = { location: '', pov: '', timeline: '' }

/**
 * The stored `scene_meta` column as a `SceneMeta`. Lenient on purpose: a null row, invalid JSON,
 * or JSON that fails the schema all read as empty metadata rather than an error, because a
 * half-legible sidecar must never keep the author out of the editor.
 */
export function parseStoredSceneMeta(raw: string | null): SceneMeta {
  if (raw === null) return { ...EMPTY_SCENE_META }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ...EMPTY_SCENE_META }
  }
  const parsed = SceneMeta.safeParse(json)
  return parsed.success ? parsed.data : { ...EMPTY_SCENE_META }
}
