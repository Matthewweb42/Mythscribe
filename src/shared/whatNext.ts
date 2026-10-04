import { z } from 'zod'

/**
 * What should come next? (F-5.17): three short directions for the scene, grounded in its brief,
 * the story bible, and the text so far. Directions are advice in the chat, not manuscript
 * prose; one becomes prose only through Author mode, which carries the voice profile and the
 * fidelity check. The limits the prompt, the contract, and the panel share live here.
 */

/** Below this many characters of text there is nothing to continue from. */
export const WHAT_NEXT_TEXT_MIN = 40
/** The tail of the scene (or of the text up to the selection's end) sent, in characters. */
export const WHAT_NEXT_CHAR_BUDGET = 6_000
/** How many directions are asked for and kept. */
export const WHAT_NEXT_DIRECTIONS = 3
export const WHAT_NEXT_TITLE_MAX = 80
export const WHAT_NEXT_TEXT_MAX = 300

export const WhatNextDirection = z.object({
  title: z.string().min(1).max(WHAT_NEXT_TITLE_MAX),
  text: z.string().min(1).max(WHAT_NEXT_TEXT_MAX)
})
export type WhatNextDirection = z.infer<typeof WhatNextDirection>

export const WhatNextDirections = z.array(WhatNextDirection).max(WHAT_NEXT_DIRECTIONS)

/** The plain rendering kept as the turn's text, so later history turns carry the directions. */
export function directionsText(directions: readonly WhatNextDirection[]): string {
  return directions.map((d, i) => `${i + 1}. ${d.title}: ${d.text}`).join('\n')
}
